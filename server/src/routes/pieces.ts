import type { FastifyPluginAsync } from 'fastify';
import { createPiece, getPieceWithFiles, listPieces, updatePiece } from '../db/pieces.ts';
import { canSeeScores, requireAdmin, requireAuth } from '../auth/middleware.ts';
import { sectionExists } from '../db/sections.ts';
import {
  addLink,
  deleteLink,
  getMemberPieceState,
  guessLinkType,
  LINK_TYPES,
  listLinks,
  listRemarks,
  setMemberPieceState,
  setRemark,
  type LinkType,
} from '../db/pieceExtras.ts';

interface CreatePieceBody {
  title: string;
  composer?: string | null;
  arranger?: string | null;
  notes?: string | null;
}

interface UpdatePieceBody {
  title?: string;
  composer?: string | null;
  arranger?: string | null;
  notes?: string | null;
  lyrics?: string | null;
  isCurrent?: boolean;
}

const ALLOWED_PATCH_KEYS = new Set(['title', 'composer', 'arranger', 'notes', 'lyrics', 'isCurrent']);

export const piecesRoutes: FastifyPluginAsync = async (app) => {
  /** Listing the repertoire requires a signed-in member. Matches the SGMC
   *  platform posture — content is choir-internal, not public. Other
   *  deployments that want a public catalogue can drop the preHandler. */
  app.get('/pieces', { preHandler: requireAuth }, async () => {
    return listPieces();
  });

  app.get<{ Params: { id: string } }>(
    '/pieces/:id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return reply.code(400).send({ error: 'invalid id' });
      const piece = getPieceWithFiles(id);
      if (!piece) return reply.code(404).send({ error: 'not found' });
      const user = req.user!;
      return {
        ...piece,
        // Editable scores are for the MD / committee / section admins only.
        files: canSeeScores(user) ? piece.files : piece.files.filter((f) => f.kind !== 'score'),
        remarks: listRemarks(id),
        links: listLinks(id),
        me: getMemberPieceState(user.internalId, id),
      };
    },
  );

  /** The member's own confidence rating / private notes for a song. */
  app.put<{ Params: { id: string }; Body: { confidence?: 1 | 2 | 3 | null; notes?: string | null } }>(
    '/pieces/:id/me',
    { preHandler: requireAuth },
    async (req, reply) => {
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || !getPieceWithFiles(id)) return reply.code(404).send({ error: 'not found' });
      const body = req.body ?? {};
      const unknown = Object.keys(body).filter((k) => k !== 'confidence' && k !== 'notes');
      if (unknown.length) return reply.code(400).send({ error: `unknown fields: ${unknown.join(', ')}` });
      if (body.confidence !== undefined && body.confidence !== null && ![1, 2, 3].includes(body.confidence)) {
        return reply.code(400).send({ error: 'confidence must be 1, 2, 3 or null' });
      }
      if (body.notes !== undefined && body.notes !== null && typeof body.notes !== 'string') {
        return reply.code(400).send({ error: 'notes must be a string or null' });
      }
      return setMemberPieceState(req.user!.internalId, id, body);
    },
  );

  /** Admin: set (or clear, with empty text) the remark for one section. */
  app.put<{ Params: { id: string; sectionId: string }; Body: { text?: string } }>(
    '/pieces/:id/remarks/:sectionId',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const id = Number(req.params.id);
      const sectionId = Number(req.params.sectionId);
      if (!Number.isFinite(id) || !getPieceWithFiles(id)) return reply.code(404).send({ error: 'not found' });
      if (!Number.isInteger(sectionId) || !sectionExists(sectionId)) return reply.code(400).send({ error: 'unknown section' });
      const text = req.body?.text;
      if (typeof text !== 'string') return reply.code(400).send({ error: 'text required' });
      setRemark(id, sectionId, text, req.user!.internalId);
      return listRemarks(id);
    },
  );

  /** Admin: add a link. Type is guessed from the URL when omitted. */
  app.post<{ Params: { id: string }; Body: { url?: string; type?: LinkType; label?: string | null } }>(
    '/pieces/:id/links',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || !getPieceWithFiles(id)) return reply.code(404).send({ error: 'not found' });
      const url = req.body?.url?.trim();
      if (!url || !/^https?:\/\//i.test(url)) return reply.code(400).send({ error: 'url must start with http(s)://' });
      const type = req.body?.type ?? guessLinkType(url);
      if (!LINK_TYPES.includes(type)) return reply.code(400).send({ error: 'unknown link type' });
      const label = typeof req.body?.label === 'string' ? req.body.label.trim() || null : null;
      return reply.code(201).send(addLink(id, type, url, label));
    },
  );

  app.delete<{ Params: { id: string; linkId: string } }>(
    '/pieces/:id/links/:linkId',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const id = Number(req.params.id);
      const linkId = Number(req.params.linkId);
      if (!Number.isFinite(id) || !Number.isFinite(linkId)) return reply.code(400).send({ error: 'invalid id' });
      if (!deleteLink(id, linkId)) return reply.code(404).send({ error: 'not found' });
      return reply.code(204).send();
    },
  );

  /** Creating a piece is admin-only — members shouldn't be cluttering the
   *  catalogue. Same gate as PATCH/DELETE for consistency. */
  app.post<{ Body: CreatePieceBody }>(
    '/pieces',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const body = req.body;
      if (!body || typeof body.title !== 'string' || body.title.trim() === '') {
        return reply.code(400).send({ error: 'title required' });
      }
      const piece = createPiece({
        title: body.title.trim(),
        composer: body.composer?.trim() || null,
        arranger: body.arranger?.trim() || null,
        notes: body.notes?.trim() || null,
      });
      return reply.code(201).send(piece);
    },
  );

  /**
   * Admin-only: edit a piece's metadata or flip its current/archive status.
   * Locked down to admins because in practice this is repertoire management,
   * not member self-service. Unknown body keys are rejected so the surface
   * stays tight.
   */
  app.patch<{ Params: { id: string }; Body: UpdatePieceBody }>(
    '/pieces/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return reply.code(400).send({ error: 'invalid id' });

      const body = req.body;
      if (!body || typeof body !== 'object') {
        return reply.code(400).send({ error: 'body required' });
      }
      const unknown = Object.keys(body).filter((k) => !ALLOWED_PATCH_KEYS.has(k));
      if (unknown.length > 0) {
        return reply.code(400).send({ error: `unknown fields: ${unknown.join(', ')}` });
      }

      // Type-check each provided field.
      if (body.title !== undefined && (typeof body.title !== 'string' || body.title.trim() === '')) {
        return reply.code(400).send({ error: 'title must be a non-empty string' });
      }
      for (const k of ['composer', 'arranger', 'notes', 'lyrics'] as const) {
        if (body[k] !== undefined && body[k] !== null && typeof body[k] !== 'string') {
          return reply.code(400).send({ error: `${k} must be string or null` });
        }
      }
      if (body.isCurrent !== undefined && typeof body.isCurrent !== 'boolean') {
        return reply.code(400).send({ error: 'isCurrent must be boolean' });
      }

      const piece = updatePiece(id, {
        ...(body.title !== undefined && { title: body.title.trim() }),
        ...(body.composer !== undefined && { composer: body.composer?.trim() || null }),
        ...(body.arranger !== undefined && { arranger: body.arranger?.trim() || null }),
        ...(body.notes !== undefined && { notes: body.notes?.trim() || null }),
        ...(body.lyrics !== undefined && { lyrics: body.lyrics?.trim() || null }),
        ...(body.isCurrent !== undefined && { isCurrent: body.isCurrent }),
      });
      if (!piece) return reply.code(404).send({ error: 'not found' });
      return piece;
    },
  );
};
