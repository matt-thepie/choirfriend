import type { FastifyPluginAsync } from 'fastify';
import { createPiece, getPieceWithFiles, listPieces } from '../db/pieces.ts';
import { requireAuth } from '../auth/middleware.ts';

interface CreatePieceBody {
  title: string;
  composer?: string | null;
  arranger?: string | null;
  notes?: string | null;
}

export const piecesRoutes: FastifyPluginAsync = async (app) => {
  /** Listing pieces is open — anyone can see the catalogue. */
  app.get('/pieces', async () => {
    return listPieces();
  });

  app.get<{ Params: { id: string } }>('/pieces/:id', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return reply.code(400).send({ error: 'invalid id' });
    const piece = getPieceWithFiles(id);
    if (!piece) return reply.code(404).send({ error: 'not found' });
    return piece;
  });

  /** Creating a piece requires auth — no per-role gating yet; any signed-in
   *  member can add repertoire. Tighten to committee+ later if needed. */
  app.post<{ Body: CreatePieceBody }>(
    '/pieces',
    { preHandler: requireAuth },
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
};
