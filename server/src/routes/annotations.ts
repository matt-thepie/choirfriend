import type { FastifyPluginAsync } from 'fastify';
import {
  canSeeAnnotation,
  createAnnotation,
  deleteAnnotation,
  restoreAnnotation,
  updateMarker,
  getAnnotationById,
  listAnnotationsForPiece,
  type AnnotationLayer,
  type CreateAnnotationInput,
  type InkPen,
  type MarkerKind,
} from '../db/annotations.ts';
import { getPieceWithFiles } from '../db/pieces.ts';
import { getUserSectionIdByEmail } from '../db/index.ts';
import { sectionExists } from '../db/sections.ts';
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
  sectionIds?: number[] | null;
}

type CreateBody =
  | (CreateBodyCommon & {
      kind: 'ink';
      pen?: InkPen;
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
  if (b.sectionIds != null) {
    if (!Array.isArray(b.sectionIds) || !b.sectionIds.every((id) => Number.isInteger(id) && sectionExists(id as number))) {
      return { ok: false, reason: 'invalid sectionIds' };
    }
  }

  if (b.kind === 'ink') {
    if (b.pen !== undefined && b.pen !== 'pen' && b.pen !== 'highlighter') return { ok: false, reason: 'invalid pen' };
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
        sectionIds: body.sectionIds ?? null,
      };

      const input: CreateAnnotationInput =
        body.kind === 'ink'
          ? {
              ...common,
              kind: 'ink',
              pen: body.pen ?? 'pen',
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

  app.patch<{ Params: { annotationId: string } }>(
    '/annotations/:annotationId',
    { preHandler: requireAuth },
    async (req, reply) => {
      const user = req.user!;
      const existing = getAnnotationById(req.params.annotationId, user.internalId);
      if (!existing || !canSeeAnnotation(existing, getUserSectionIdByEmail(user.email))) {
        return reply.code(404).send({ error: 'not found' });
      }
      if (existing.kind !== 'marker') return reply.code(400).send({ error: 'not a marker' });
      if (existing.layer === 'private' && !existing.isMine) return reply.code(403).send({ error: 'forbidden' });
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) return reply.code(400).send({ error: 'body must be an object' });
      const validated = validateBody({ ...existing, ...(req.body as object), id: existing.id,
        fileId: existing.fileId, layer: existing.layer, sectionIds: existing.sectionIds, kind: 'marker' });
      if (!validated.ok || validated.value.kind !== 'marker') return reply.code(400).send({ error: 'invalid marker' });
      const body = validated.value;
      if (!Number.isInteger(body.page) || body.page < 1 || ![body.position.x, body.position.y].every((n) => Number.isFinite(n) && n >= 0 && n <= 1)) {
        return reply.code(400).send({ error: 'invalid position' });
      }
      return updateMarker(existing.id, user.internalId, { page: body.page, markerKind: body.markerKind, label: body.label ?? null, position: body.position });
    },
  );

  app.delete<{ Params: { annotationId: string } }>(
    '/annotations/:annotationId',
    { preHandler: requireAuth },
    async (req, reply) => {
      const user = req.user!;
      const existing = getAnnotationById(req.params.annotationId, user.internalId);
      if (!existing || !canSeeAnnotation(existing, getUserSectionIdByEmail(user.email))) {
        return reply.code(404).send({ error: 'not found' });
      }

      if (existing.layer === 'private' && !existing.isMine) {
        return reply.code(403).send({ error: 'forbidden' });
      }

      deleteAnnotation(req.params.annotationId, user.internalId);
      return reply.code(204).send();
    },
  );

  // Redo of a delete: only the member who deleted the mark can bring it back.
  app.post<{ Params: { annotationId: string } }>(
    '/annotations/:annotationId/restore',
    { preHandler: requireAuth },
    async (req, reply) => {
      const restored = restoreAnnotation(req.params.annotationId, req.user!.internalId);
      if (!restored) return reply.code(404).send({ error: 'not found' });
      return restored;
    },
  );
};
