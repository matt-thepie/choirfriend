import type { FastifyPluginAsync } from 'fastify';
import {
  createAnnotation,
  deleteAnnotation,
  getAnnotationById,
  listAnnotationsForPiece,
  type AnnotationLayer,
  type CreateAnnotationInput,
  type MarkerKind,
} from '../db/annotations.ts';
import { getPieceWithFiles } from '../db/pieces.ts';
import { requireAuth } from '../auth/middleware.ts';

const MARKER_KINDS: readonly MarkerKind[] = [
  'segno',
  'coda',
  'ds',
  'dc',
  'fine',
  'to-coda',
  'repeat-start',
  'repeat-end',
  'volta-1',
  'volta-2',
  'bar',
  'custom',
];

interface CreateBodyCommon {
  id: string;
  fileId: number;
  layer: AnnotationLayer;
  page: number;
}

type CreateBody =
  | (CreateBodyCommon & {
      kind: 'ink';
      color: string;
      width: number;
      points: Array<{ x: number; y: number }>;
    })
  | (CreateBodyCommon & {
      kind: 'marker';
      markerKind: MarkerKind;
      label?: string | null;
      position: { x: number; y: number };
    });

function isPoint(value: unknown): value is { x: number; y: number } {
  if (value === null || typeof value !== 'object') return false;
  const { x, y } = value as { x?: unknown; y?: unknown };
  return typeof x === 'number' && typeof y === 'number';
}

function validateBody(body: unknown): { ok: true; value: CreateBody } | { ok: false; reason: string } {
  if (!body || typeof body !== 'object') return { ok: false, reason: 'body must be an object' };
  const b = body as Record<string, unknown>;
  if (typeof b.id !== 'string') return { ok: false, reason: 'id missing' };
  if (typeof b.fileId !== 'number') return { ok: false, reason: 'fileId missing' };
  if (b.layer !== 'private' && b.layer !== 'shared') return { ok: false, reason: 'invalid layer' };
  if (typeof b.page !== 'number') return { ok: false, reason: 'page missing' };

  if (b.kind === 'ink') {
    if (typeof b.color !== 'string') return { ok: false, reason: 'color missing' };
    if (typeof b.width !== 'number') return { ok: false, reason: 'width missing' };
    if (!Array.isArray(b.points) || !b.points.every(isPoint)) {
      return { ok: false, reason: 'points must be Array<{x,y}>' };
    }
    return { ok: true, value: b as unknown as CreateBody };
  }

  if (b.kind === 'marker') {
    if (!MARKER_KINDS.includes(b.markerKind as MarkerKind)) {
      return { ok: false, reason: 'invalid markerKind' };
    }
    if (!isPoint(b.position)) return { ok: false, reason: 'position must be {x,y}' };
    if (b.label !== undefined && b.label !== null && typeof b.label !== 'string') {
      return { ok: false, reason: 'label must be string or null' };
    }
    return { ok: true, value: b as unknown as CreateBody };
  }

  return { ok: false, reason: 'unknown kind' };
}

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

  app.post<{ Params: { id: string } }>(
    '/pieces/:id/annotations',
    { preHandler: requireAuth },
    async (req, reply) => {
      const pieceId = Number(req.params.id);
      if (!Number.isFinite(pieceId)) return reply.code(400).send({ error: 'invalid id' });

      const piece = getPieceWithFiles(pieceId);
      if (!piece) return reply.code(404).send({ error: 'piece not found' });

      const validated = validateBody(req.body);
      if (!validated.ok) return reply.code(400).send({ error: validated.reason });
      const body = validated.value;

      if (!piece.files.some((f) => f.id === body.fileId)) {
        return reply.code(400).send({ error: 'file not in piece' });
      }

      const user = req.user!;
      const common = {
        id: body.id,
        pieceId,
        fileId: body.fileId,
        userId: user.internalId,
        layer: body.layer,
        page: body.page,
      };

      const input: CreateAnnotationInput =
        body.kind === 'ink'
          ? {
              ...common,
              kind: 'ink',
              color: body.color,
              width: body.width,
              points: body.points,
            }
          : {
              ...common,
              kind: 'marker',
              markerKind: body.markerKind,
              label: body.label ?? null,
              position: body.position,
            };

      const dto = createAnnotation(input);
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

      if (existing.layer === 'private' && !existing.isMine) {
        return reply.code(403).send({ error: 'forbidden' });
      }

      deleteAnnotation(req.params.annotationId);
      return reply.code(204).send();
    },
  );
};
