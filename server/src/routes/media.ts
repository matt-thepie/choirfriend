/**
 * Private music: scores, PDFs and audio, sent only to signed-in members.
 *
 *   GET /api/media/<storage key>     e.g. /api/media/pieces/12/files/ab12cd34/Gloria.pdf
 *
 * The address is the file's storage key, so it never changes between
 * requests (what the offline caches need) and does change when a file is
 * replaced. The bytes are streamed from the music bucket through this
 * server, not handed out as a signed link: a link expires, which stalls a
 * learning track resumed after a pause, and a redirect to another site adds
 * cross-origin rules that the older tablets in the choir have tripped over
 * before. The files are small and the choir is not.
 *
 * The same visibility rules as the piece API apply: a member's private
 * upload is theirs alone, and editable scores are for the roles that may see
 * them. Anything else is "not found", so the route says nothing about what
 * exists.
 *
 * Works without a private bucket too (it then reads the public one), so it
 * can be tried on a server before the switch.
 */

import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { db } from '../db/index.ts';
import type { FileRow } from '../db/pieces.ts';
import { canSeeScores, requireAuth } from '../auth/middleware.ts';
import { isB2Configured, openObject } from '../storage/b2.ts';

const fileByKeyStmt = db.prepare(`SELECT * FROM files WHERE storage = 'b2' AND storage_key = ?`);
const renditionByKeyStmt = db.prepare(`
  SELECT f.filename FROM score_renditions r JOIN files f ON f.id = r.file_id
  WHERE r.storage = 'b2' AND r.storage_key = ? AND r.status = 'ready'
`);

const MUSICXML = 'application/vnd.recordare.musicxml+xml';

/** inline, with the original file name for "save as". */
function disposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function notFound(reply: FastifyReply): FastifyReply {
  return reply.code(404).header('Cache-Control', 'no-store').send({ error: 'not found' });
}

export const mediaRoutes: FastifyPluginAsync = async (app) => {
  app.route<{ Params: { '*': string } }>({
    method: ['GET', 'HEAD'],
    url: '/media/*',
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const key = req.params['*'];
      if (!key || !isB2Configured()) return notFound(reply);
      const user = req.user!;

      let filename: string;
      let mimeType: string | null;
      const file = fileByKeyStmt.get(key) as FileRow | undefined;
      if (file) {
        if ((file.visibility ?? 'shared') !== 'shared' && file.created_by_user_id !== user.internalId) return notFound(reply);
        if (file.kind === 'score' && !canSeeScores(user)) return notFound(reply);
        filename = file.filename;
        mimeType = file.mime_type;
      } else {
        // The flowing view of a score is for every member, like sheet music.
        const rendition = renditionByKeyStmt.get(key) as { filename: string } | undefined;
        if (!rendition) return notFound(reply);
        filename = `${rendition.filename.replace(/\.[^.]+$/, '') || 'score'}.xml`;
        mimeType = MUSICXML;
      }

      const range = typeof req.headers.range === 'string' ? req.headers.range : undefined;
      const ifNoneMatch = typeof req.headers['if-none-match'] === 'string' ? req.headers['if-none-match'] : undefined;
      const result = await openObject({ store: 'music', unprefixedKey: key, range, ifNoneMatch, headOnly: req.method === 'HEAD' });

      // "private" keeps the file out of shared caches: Cloudflare would
      // otherwise keep .pdf and .mp3 responses at its edge and hand them to
      // anyone. "no-cache" lets the member's browser keep its copy but makes
      // it ask here before each use, so a track is not replayed from the
      // browser's cache after signing out; an unchanged file costs a 304.
      reply.header('Cache-Control', 'private, no-cache');
      reply.header('X-Content-Type-Options', 'nosniff');

      if (result.kind === 'missing') {
        req.log.warn({ key }, 'media: file is in the database but not in storage');
        return notFound(reply);
      }
      if (result.kind === 'not-modified') return reply.code(304).send();
      if (result.kind === 'bad-range') return reply.code(416).header('Cache-Control', 'no-store').send();

      const o = result.object;
      reply.code(o.status);
      reply.header('Accept-Ranges', 'bytes');
      reply.header('Content-Type', mimeType || o.contentType || 'application/octet-stream');
      reply.header('Content-Disposition', disposition(filename));
      if (o.contentLength !== null) reply.header('Content-Length', o.contentLength);
      if (o.contentRange) reply.header('Content-Range', o.contentRange);
      if (o.etag) reply.header('ETag', o.etag);
      if (o.lastModified) reply.header('Last-Modified', o.lastModified.toUTCString());
      return reply.send(o.body ?? '');
    },
  });
};
