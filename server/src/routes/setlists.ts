import type { FastifyPluginAsync } from 'fastify';
import {
  copySetList,
  createSetList,
  deleteSetList,
  getAllSongsSetList,
  getSetList,
  listSetLists,
  updateSetList,
  UnknownPieceError,
  type SetListStatus,
} from '../db/setlists.ts';
import { requireAdmin, requireAuth } from '../auth/middleware.ts';

interface SetListBody {
  name?: string;
  status?: SetListStatus;
  sortOrder?: number;
  pinned?: boolean;
  pieceIds?: number[];
}

/** Validate the shared shape of create/update bodies. Returns an error
 *  message or null. `requireName` is true for create. */
function validate(body: SetListBody | undefined, requireName: boolean): string | null {
  if (!body || typeof body !== 'object') return 'body required';
  const unknown = Object.keys(body).filter((k) => !['name', 'status', 'sortOrder', 'pinned', 'pieceIds'].includes(k));
  if (unknown.length) return `unknown fields: ${unknown.join(', ')}`;
  if (body.pinned !== undefined && typeof body.pinned !== 'boolean') return 'pinned must be a boolean';
  if (body.name !== undefined && (typeof body.name !== 'string' || !body.name.trim())) return 'name must be a non-empty string';
  if (requireName && body.name === undefined) return 'name required';
  if (body.status !== undefined && body.status !== 'active' && body.status !== 'archived') return 'status must be active or archived';
  if (body.sortOrder !== undefined && !Number.isInteger(body.sortOrder)) return 'sortOrder must be an integer';
  if (body.pieceIds !== undefined && (!Array.isArray(body.pieceIds) || !body.pieceIds.every((n) => Number.isInteger(n)))) {
    return 'pieceIds must be an array of integers';
  }
  return null;
}

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) ? id : null;
}

export const setListsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/setlists', { preHandler: requireAuth }, async () => listSetLists());

  /** Virtual "All songs" list — the whole repertoire, title order. */
  app.get('/setlists/all', { preHandler: requireAuth }, async () => getAllSongsSetList());

  app.get<{ Params: { id: string } }>('/setlists/:id', { preHandler: requireAuth }, async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return reply.code(400).send({ error: 'invalid id' });
    const sl = getSetList(id);
    if (!sl) return reply.code(404).send({ error: 'not found' });
    return sl;
  });

  app.post<{ Body: SetListBody }>('/setlists', { preHandler: requireAdmin }, async (req, reply) => {
    const err = validate(req.body, true);
    if (err) return reply.code(400).send({ error: err });
    const b = req.body;
    try {
      return await reply.code(201).send(createSetList({ name: b.name!.trim(), status: b.status, pieceIds: b.pieceIds }));
    } catch (e) {
      if (e instanceof UnknownPieceError) return reply.code(400).send({ error: e.message });
      throw e;
    }
  });

  app.patch<{ Params: { id: string }; Body: SetListBody }>('/setlists/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return reply.code(400).send({ error: 'invalid id' });
    const err = validate(req.body, false);
    if (err) return reply.code(400).send({ error: err });
    const b = req.body;
    try {
      const sl = updateSetList(id, {
        ...(b.name !== undefined && { name: b.name.trim() }),
        ...(b.status !== undefined && { status: b.status }),
        ...(b.sortOrder !== undefined && { sortOrder: b.sortOrder }),
        ...(b.pinned !== undefined && { pinned: b.pinned }),
        ...(b.pieceIds !== undefined && { pieceIds: b.pieceIds }),
      });
      if (!sl) return reply.code(404).send({ error: 'not found' });
      return sl;
    } catch (e) {
      if (e instanceof UnknownPieceError) return reply.code(400).send({ error: e.message });
      throw e;
    }
  });

  app.post<{ Params: { id: string } }>('/setlists/:id/copy', { preHandler: requireAdmin }, async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return reply.code(400).send({ error: 'invalid id' });
    const sl = copySetList(id);
    if (!sl) return reply.code(404).send({ error: 'not found' });
    return reply.code(201).send(sl);
  });

  app.delete<{ Params: { id: string } }>('/setlists/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return reply.code(400).send({ error: 'invalid id' });
    if (!deleteSetList(id)) return reply.code(404).send({ error: 'not found' });
    return reply.code(204).send();
  });
};
