import type { FastifyPluginAsync } from 'fastify';
import { createPiece, getPieceWithFiles, listPieces, updatePiece } from '../db/pieces.ts';
import { requireAdmin, requireAuth } from '../auth/middleware.ts';

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
  isCurrent?: boolean;
}

const ALLOWED_PATCH_KEYS = new Set(['title', 'composer', 'arranger', 'notes', 'isCurrent']);

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
      return piece;
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
      for (const k of ['composer', 'arranger', 'notes'] as const) {
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
        ...(body.isCurrent !== undefined && { isCurrent: body.isCurrent }),
      });
      if (!piece) return reply.code(404).send({ error: 'not found' });
      return piece;
    },
  );
};
