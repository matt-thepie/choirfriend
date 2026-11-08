import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import {
  copySetList,
  createSetList,
  deleteSetList,
  getAllSongsSetList,
  getSetList,
  getSetListOwner,
  listSetLists,
  updateSetList,
  UnknownImageError,
  UnknownPieceError,
  type SetListStatus,
} from '../db/setlists.ts';
import { isAdmin, requireAuth } from '../auth/middleware.ts';

interface SetListBody {
  name?: string;
  status?: SetListStatus;
  sortOrder?: number;
  pinned?: boolean;
  pieceIds?: number[];
  /** Cover picture from the shared pool (GET /images); null clears it. */
  imageId?: number | null;
  /** Create only. A personal list, visible only to its owner. Non-admins
   *  always get a personal list whatever they send. */
  personal?: boolean;
}

/** Validate the shared shape of create/update bodies. Returns an error
 *  message or null. `requireName` is true for create. */
function validate(body: SetListBody | undefined, requireName: boolean): string | null {
  if (!body || typeof body !== 'object') return 'body required';
  const allowed = ['name', 'status', 'sortOrder', 'pinned', 'pieceIds', 'imageId', ...(requireName ? ['personal'] : [])];
  const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
  if (unknown.length) return `unknown fields: ${unknown.join(', ')}`;
  if (body.pinned !== undefined && typeof body.pinned !== 'boolean') return 'pinned must be a boolean';
  if (body.personal !== undefined && typeof body.personal !== 'boolean') return 'personal must be a boolean';
  if (body.name !== undefined && (typeof body.name !== 'string' || !body.name.trim())) return 'name must be a non-empty string';
  if (requireName && body.name === undefined) return 'name required';
  if (body.status !== undefined && body.status !== 'active' && body.status !== 'archived') return 'status must be active or archived';
  if (body.sortOrder !== undefined && !Number.isInteger(body.sortOrder)) return 'sortOrder must be an integer';
  if (body.imageId !== undefined && body.imageId !== null && !Number.isInteger(body.imageId)) return 'imageId must be an integer or null';
  if (body.pieceIds !== undefined && (!Array.isArray(body.pieceIds) || !body.pieceIds.every((n) => Number.isInteger(n)))) {
    return 'pieceIds must be an array of integers';
  }
  return null;
}

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) ? id : null;
}

type Access =
  /** The list exists and this user may edit it. `personal` says which kind. */
  | { kind: 'ok'; personal: boolean }
  /** Not found, or a personal list belonging to someone else (hidden, so 404). */
  | { kind: 'notFound' }
  /** A choir list and the user isn't an admin. */
  | { kind: 'forbidden' };

/** Admins manage choir lists; each member manages their own personal lists.
 *  Someone else's personal list looks like it doesn't exist. */
function editAccess(req: FastifyRequest, id: number): Access {
  const owner = getSetListOwner(id);
  if (owner === undefined) return { kind: 'notFound' };
  const user = req.user!;
  if (owner === null) return isAdmin(user) ? { kind: 'ok', personal: false } : { kind: 'forbidden' };
  return owner === user.internalId ? { kind: 'ok', personal: true } : { kind: 'notFound' };
}

export const setListsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/setlists', { preHandler: requireAuth }, async (req) => listSetLists(req.user!.internalId));

  /** Virtual "All songs" list — the whole repertoire, title order. */
  app.get('/setlists/all', { preHandler: requireAuth }, async (req) => getAllSongsSetList(req.user!.internalId));

  app.get<{ Params: { id: string } }>('/setlists/:id', { preHandler: requireAuth }, async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return reply.code(400).send({ error: 'invalid id' });
    const sl = getSetList(id, req.user!.internalId);
    if (!sl) return reply.code(404).send({ error: 'not found' });
    return sl;
  });

  /** Admins create choir lists (or, with personal: true, their own). Members
   *  only ever create personal lists. */
  app.post<{ Body: SetListBody }>('/setlists', { preHandler: requireAuth }, async (req, reply) => {
    const err = validate(req.body, true);
    if (err) return reply.code(400).send({ error: err });
    const b = req.body;
    const user = req.user!;
    const personal = !isAdmin(user) || b.personal === true;
    try {
      return await reply.code(201).send(
        createSetList({ name: b.name!.trim(), status: b.status, pieceIds: b.pieceIds, imageId: b.imageId, ownerUserId: personal ? user.internalId : null }),
      );
    } catch (e) {
      if (e instanceof UnknownPieceError || e instanceof UnknownImageError) return reply.code(400).send({ error: e.message });
      throw e;
    }
  });

  app.patch<{ Params: { id: string }; Body: SetListBody }>('/setlists/:id', { preHandler: requireAuth }, async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return reply.code(400).send({ error: 'invalid id' });
    const err = validate(req.body, false);
    if (err) return reply.code(400).send({ error: err });
    const access = editAccess(req, id);
    if (access.kind === 'notFound') return reply.code(404).send({ error: 'not found' });
    if (access.kind === 'forbidden') return reply.code(403).send({ error: 'forbidden', message: 'admin role required' });
    const b = req.body;
    if (access.personal && b.pinned) return reply.code(400).send({ error: 'a personal set list cannot be pinned as this week' });
    try {
      const sl = updateSetList(
        id,
        {
          ...(b.name !== undefined && { name: b.name.trim() }),
          ...(b.status !== undefined && { status: b.status }),
          ...(b.sortOrder !== undefined && { sortOrder: b.sortOrder }),
          ...(b.pinned !== undefined && { pinned: b.pinned }),
          ...(b.pieceIds !== undefined && { pieceIds: b.pieceIds }),
          ...(b.imageId !== undefined && { imageId: b.imageId }),
        },
        req.user!.internalId,
      );
      if (!sl) return reply.code(404).send({ error: 'not found' });
      return sl;
    } catch (e) {
      if (e instanceof UnknownPieceError || e instanceof UnknownImageError) return reply.code(400).send({ error: e.message });
      throw e;
    }
  });

  /** Copy a list. An admin copying a choir list makes another choir list;
   *  anyone else (or any copy of a personal list) gets a personal copy of
   *  their own — "Copy to my set lists". */
  app.post<{ Params: { id: string } }>('/setlists/:id/copy', { preHandler: requireAuth }, async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return reply.code(400).send({ error: 'invalid id' });
    const user = req.user!;
    const owner = getSetListOwner(id);
    const toChoir = owner === null && isAdmin(user);
    const sl = copySetList(id, user.internalId, toChoir ? null : user.internalId);
    if (!sl) return reply.code(404).send({ error: 'not found' });
    return reply.code(201).send(sl);
  });

  app.delete<{ Params: { id: string } }>('/setlists/:id', { preHandler: requireAuth }, async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return reply.code(400).send({ error: 'invalid id' });
    const access = editAccess(req, id);
    if (access.kind === 'notFound') return reply.code(404).send({ error: 'not found' });
    if (access.kind === 'forbidden') return reply.code(403).send({ error: 'forbidden', message: 'admin role required' });
    if (!deleteSetList(id)) return reply.code(404).send({ error: 'not found' });
    return reply.code(204).send();
  });
};
