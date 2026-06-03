/**
 * Bulk-import endpoints, behind the admin gate. Drives the in-app importer:
 *
 *   GET  /api/import/config        → { anthropic, storage } so the UI can warn
 *                                     if the AI key is missing and show where
 *                                     files will land.
 *   POST /api/import/analyze-pdf    → multipart {file}; AI guess of
 *                                      { docType, title, composer, arranger }.
 *   POST /api/import/analyze-tracks → JSON {folder, filenames[]}; AI voice-part
 *                                      label per track (one call for the song).
 *   POST /api/import/create-piece   → JSON {title, composer, arranger}; new song.
 *   POST /api/import/commit         → multipart {file, kind, pieceId, label};
 *                                      attaches one file to an existing song.
 *
 * Unlike per-file uploads, the importer routes the bytes through the server
 * (so it can analyse them and so it works locally without B2). Acceptable for
 * an occasional admin batch; the hot-path single-file upload stays direct-to-B2.
 */

import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { requireAdmin } from '../auth/middleware.ts';
import { createFile, createPiece, getPieceWithFiles, updatePiece } from '../db/pieces.ts';
import {
  analyzePdf,
  analyzeTracks,
  assignTracks,
  isAnthropicConfigured,
  planImport,
  planStructure,
  type PieceForAssign,
  type PlanFileInput,
  type StructureFolder,
  type TrackToAssign,
} from '../import/analyze.ts';
import { storageMode, storeImportedFile } from '../import/storage.ts';

/** Collect a single uploaded file plus any text fields from a multipart request. */
async function readMultipart(
  req: FastifyRequest,
): Promise<{ buffer: Buffer; filename: string; mimetype: string; fields: Record<string, string> }> {
  let buffer: Buffer | null = null;
  let filename = '';
  let mimetype = '';
  const fields: Record<string, string> = {};
  for await (const part of req.parts()) {
    if (part.type === 'file') {
      filename = part.filename;
      mimetype = part.mimetype;
      buffer = await part.toBuffer();
    } else {
      fields[part.fieldname] = String(part.value);
    }
  }
  if (!buffer) throw new Error('no file in upload');
  return { buffer, filename, mimetype, fields };
}

export const importRoutes: FastifyPluginAsync = async (app) => {
  app.get('/import/config', { preHandler: requireAdmin }, async () => {
    return { anthropic: isAnthropicConfigured(), storage: storageMode() };
  });

  app.post('/import/analyze-pdf', { preHandler: requireAdmin }, async (req, reply) => {
    if (!isAnthropicConfigured()) {
      return reply.code(503).send({ error: 'anthropic_not_configured', message: 'Set ANTHROPIC_API_KEY to analyse files.' });
    }
    const { buffer, filename } = await readMultipart(req);
    try {
      const guess = await analyzePdf(buffer, filename);
      return guess;
    } catch (e) {
      req.log.error(e, 'analyze-pdf failed');
      return reply.code(422).send({ error: 'analyze_failed', message: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post<{ Body: { folder?: string; filenames?: string[] } }>(
    '/import/analyze-tracks',
    { preHandler: requireAdmin },
    async (req, reply) => {
      if (!isAnthropicConfigured()) {
        return reply.code(503).send({ error: 'anthropic_not_configured', message: 'Set ANTHROPIC_API_KEY to analyse files.' });
      }
      const filenames = req.body?.filenames;
      if (!Array.isArray(filenames) || filenames.some((f) => typeof f !== 'string')) {
        return reply.code(400).send({ error: 'filenames (string[]) required' });
      }
      try {
        const tracks = await analyzeTracks(req.body?.folder ?? '', filenames);
        return { tracks };
      } catch (e) {
        req.log.error(e, 'analyze-tracks failed');
        return reply.code(422).send({ error: 'analyze_failed', message: e instanceof Error ? e.message : String(e) });
      }
    },
  );

  // Holistic structure plan: reason about the whole folder tree (compact) and
  // return a folder→piece grouping + folders that aren't a piece (gig/setlist).
  app.post<{ Body: { folders?: StructureFolder[] } }>(
    '/import/plan-structure',
    { preHandler: requireAdmin },
    async (req, reply) => {
      if (!isAnthropicConfigured()) {
        return reply.code(503).send({ error: 'anthropic_not_configured', message: 'Set ANTHROPIC_API_KEY to analyse files.' });
      }
      const folders = req.body?.folders;
      if (!Array.isArray(folders)) return reply.code(400).send({ error: 'folders array required' });
      try {
        return await planStructure(folders);
      } catch (e) {
        req.log.error(e, 'plan-structure failed');
        return reply.code(422).send({ error: 'analyze_failed', message: e instanceof Error ? e.message : String(e) });
      }
    },
  );

  // Holistic plan: hand the whole file tree to the model and get back the
  // grouping into pieces (+ voice parts, + an `unplaced` list it's unsure of).
  app.post<{ Body: { files?: PlanFileInput[] } }>(
    '/import/plan',
    { preHandler: requireAdmin },
    async (req, reply) => {
      if (!isAnthropicConfigured()) {
        return reply.code(503).send({ error: 'anthropic_not_configured', message: 'Set ANTHROPIC_API_KEY to analyse files.' });
      }
      const files = req.body?.files;
      if (!Array.isArray(files)) return reply.code(400).send({ error: 'files array required' });
      try {
        return await planImport(files);
      } catch (e) {
        req.log.error(e, 'plan failed');
        return reply.code(422).send({ error: 'analyze_failed', message: e instanceof Error ? e.message : String(e) });
      }
    },
  );

  // Assign detached audio (tracks that arrived without a sibling score) to the
  // piece they most likely belong to — one call for the whole batch.
  app.post<{ Body: { pieces?: PieceForAssign[]; tracks?: TrackToAssign[] } }>(
    '/import/assign-tracks',
    { preHandler: requireAdmin },
    async (req, reply) => {
      if (!isAnthropicConfigured()) {
        return reply.code(503).send({ error: 'anthropic_not_configured', message: 'Set ANTHROPIC_API_KEY to analyse files.' });
      }
      const { pieces, tracks } = req.body ?? {};
      if (!Array.isArray(pieces) || !Array.isArray(tracks)) {
        return reply.code(400).send({ error: 'pieces and tracks arrays required' });
      }
      try {
        const assignments = await assignTracks(pieces, tracks);
        return { assignments };
      } catch (e) {
        req.log.error(e, 'assign-tracks failed');
        return reply.code(422).send({ error: 'analyze_failed', message: e instanceof Error ? e.message : String(e) });
      }
    },
  );

  // Create the piece for a folder/song. Files are attached separately via
  // /import/commit, so a score + lyrics + tracks all land on the same song.
  app.post<{ Body: { title?: string; composer?: string; arranger?: string; active?: boolean } }>(
    '/import/create-piece',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const title = (req.body?.title ?? '').trim();
      if (!title) return reply.code(400).send({ error: 'title required' });
      const piece = createPiece({
        title,
        composer: req.body?.composer?.trim() || null,
        arranger: req.body?.arranger?.trim() || null,
      });
      // Bulk import = back-catalogue: keep it out of the active repertoire
      // unless explicitly flagged.
      if (req.body?.active !== true) updatePiece(piece.id, { isCurrent: false });
      return reply.code(201).send({ pieceId: piece.id, title: piece.title });
    },
  );

  // Attach one file (score PDF, lyrics PDF, or audio track) to an existing
  // piece. `label` distinguishes e.g. a "Lyrics" PDF or a "Tenor 1" track.
  app.post('/import/commit', { preHandler: requireAdmin }, async (req, reply) => {
    const { buffer, filename, mimetype, fields } = await readMultipart(req);
    const kind = fields.kind;
    if (kind !== 'pdf' && kind !== 'audio') {
      return reply.code(400).send({ error: 'kind must be pdf or audio' });
    }
    const pieceId = Number(fields.pieceId);
    if (!Number.isFinite(pieceId)) return reply.code(400).send({ error: 'valid pieceId required' });
    const piece = getPieceWithFiles(pieceId);
    if (!piece) return reply.code(404).send({ error: 'piece not found' });

    const contentType = mimetype || (kind === 'pdf' ? 'application/pdf' : 'application/octet-stream');
    const stored = await storeImportedFile({ pieceId, bytes: buffer, filename, contentType });

    const file = createFile({
      pieceId,
      kind,
      label: fields.label?.trim() || null,
      storage: stored.storage,
      storageKey: stored.storageKey,
      filename,
      sizeBytes: buffer.byteLength,
      mimeType: contentType,
      createdByUserId: req.user!.internalId,
    });

    return reply.code(201).send({ pieceId, pieceTitle: piece.title, fileId: file.id, storage: stored.storage });
  });
};
