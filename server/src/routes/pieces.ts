import type { FastifyPluginAsync } from 'fastify';
import { getPieceWithFiles, listPieces } from '../db/pieces.ts';

export const piecesRoutes: FastifyPluginAsync = async (app) => {
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
};
