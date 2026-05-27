import type { FastifyPluginAsync } from 'fastify';
import {
  createAnnotation,
  deleteAnnotation,
  getAnnotationById,
  listAnnotationsForPiece,
  type AnnotationLayer,
} from '../db/annotations.ts';
import { getPieceWithFiles } from '../db/pieces.ts';
import { requireAuth } from '../auth/middleware.ts';

/**
 * Annotation routes. All require auth: we need to know who's asking to
 * resolve private-layer visibility, attribute new annotations, and gate
 * deletes on the private layer.
 *
 * Shared-layer writes are open to any authenticated user (per matt's call).
 * Private-layer writes/deletes are restricted to the owner.
 */
export const annotationRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Params: { id: string } }>(
    '/pieces/:id/annotations',
    { preHandler: requireAuth },
    async (req, reply) => {
      const pieceId = Number(req.params.id);
      if (!Number.isFinite(pieceId)) return reply.code(400).send({ error: 'invalid id' });

      const piece = getPieceWithFiles(pieceId);
      if (!piece) return reply.code(404).send({ error: 'piece not found' });

      const user = req.user!;
      return listAnnotationsForPiece(pieceId, user.internalId);
    },
  );

  /**
   * Body shape matches the InkAnnotationDTO (minus server-set fields).
   * Client picks the id (UUID) so optimistic insertion is straightforward.
   */
  interface CreateBody {
    id: string;
    fileId: number;
    layer: AnnotationLayer;
    page: number;
    kind: 'ink';
    color: string;
    width: number;
    points: Array<{ x: number; y: number }>;
  }

  app.post<{ Params: { id: string }; Body: CreateBody }>(
    '/pieces/:id/annotations',
    { preHandler: requireAuth },
    async (req, reply) => {
      const pieceId = Number(req.params.id);
      if (!Number.isFinite(pieceId)) return reply.code(400).send({ error: 'invalid id' });

      const piece = getPieceWithFiles(pieceId);
      if (!piece) return reply.code(404).send({ error: 'piece not found' });

      const body = req.body;
      if (
        !body ||
        typeof body.id !== 'string' ||
        typeof body.fileId !== 'number' ||
        (body.layer !== 'private' && body.layer !== 'shared') ||
        typeof body.page !== 'number' ||
        body.kind !== 'ink' ||
        typeof body.color !== 'string' ||
        typeof body.width !== 'number' ||
        !Array.isArray(body.points)
      ) {
        return reply.code(400).send({ error: 'invalid payload' });
      }

      // File must belong to the piece — keeps annotations scoped.
      if (!piece.files.some((f) => f.id === body.fileId)) {
        return reply.code(400).send({ error: 'file not in piece' });
      }

      const user = req.user!;
      const dto = createAnnotation({
        id: body.id,
        pieceId,
        fileId: body.fileId,
        userId: user.internalId,
        layer: body.layer,
        page: body.page,
        kind: 'ink',
        color: body.color,
        width: body.width,
        points: body.points,
      });
      return reply.code(201).send(dto);
    },
  );

  app.delete<{ Params: { annotationId: string } }>(
    '/annotations/:annotationId',
    { preHandler: requireAuth },
    async (req, reply) => {
      const user = req.user!;
      const existing = getAnnotationById(req.params.annotationId, user.internalId);
      if (!existing) return reply.code(404).send({ error: 'not found' });

      // Private layer: only owner. Shared layer: anyone authenticated.
      if (existing.layer === 'private' && !existing.isMine) {
        return reply.code(403).send({ error: 'forbidden' });
      }

      deleteAnnotation(req.params.annotationId);
      return reply.code(204).send();
    },
  );
};
