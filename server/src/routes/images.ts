/**
 * Cover pictures for set lists. Same three-step upload as files (sign → PUT
 * to B2 → complete), admin-only to upload or delete, and a list anyone can
 * read so members can pick a picture that's already there.
 */

import type { FastifyPluginAsync } from 'fastify';
import { isAdmin, requireAdmin, requireAuth } from '../auth/middleware.ts';
import { createImage, deleteImage, getImageBySharedKey, getImageStorage, listImages } from '../db/images.ts';
import { deleteObject, isB2Configured, isSharedPictureKey, listSharedPictures, presignPut, sharedUrl } from '../storage/b2.ts';
import { readableStoredName } from '../import/storage.ts';

const ALLOWED_IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);
const IMAGE_EXT = /\.(jpe?g|png|webp|gif|avif)$/i;
/** Covers are small; anything bigger is a mistake. */
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const KEY_PREFIX = 'images/';

function imageOk(mimeType: string, filename: string): boolean {
  return ALLOWED_IMAGE_MIME.has(mimeType.toLowerCase()) && IMAGE_EXT.test(filename);
}

interface SignBody {
  filename?: unknown;
  mimeType?: unknown;
  sizeBytes?: unknown;
}
interface CompleteBody extends SignBody {
  storageKey?: unknown;
}

function validate(body: SignBody | undefined): string | null {
  if (!body || typeof body.filename !== 'string' || !body.filename.trim()) return 'filename required';
  if (typeof body.mimeType !== 'string') return 'mimeType required';
  if (!imageOk(body.mimeType, body.filename)) return `${body.mimeType} (${body.filename}) is not an allowed picture type`;
  if (body.sizeBytes !== undefined && (typeof body.sizeBytes !== 'number' || body.sizeBytes > MAX_IMAGE_BYTES)) return 'picture too large';
  return null;
}

export const imagesRoutes: FastifyPluginAsync = async (app) => {
  app.get('/images', { preHandler: requireAuth }, async () => listImages());

  app.post<{ Body: SignBody }>('/images/sign-upload', { preHandler: requireAdmin }, async (req, reply) => {
    if (!isB2Configured()) {
      return reply.code(503).send({ error: 'b2_not_configured', message: 'Backblaze B2 is not configured on this server.' });
    }
    const err = validate(req.body);
    if (err) return reply.code(400).send({ error: err });
    const body = req.body as { filename: string; mimeType: string };
    const storageKey = `${KEY_PREFIX}${readableStoredName(body.filename)}`;
    return presignPut({ storageKey, contentType: body.mimeType });
  });

  app.post<{ Body: CompleteBody }>('/images/complete-upload', { preHandler: requireAdmin }, async (req, reply) => {
    const err = validate(req.body);
    if (err) return reply.code(400).send({ error: err });
    const body = req.body as { storageKey?: unknown; filename: string; mimeType: string; sizeBytes?: number };
    if (typeof body.storageKey !== 'string' || !body.storageKey.startsWith(KEY_PREFIX)) {
      return reply.code(400).send({ error: 'storage key outside images namespace' });
    }
    const dto = createImage({
      storage: 'b2',
      storageKey: body.storageKey,
      filename: body.filename,
      mimeType: body.mimeType,
      sizeBytes: body.sizeBytes ?? null,
      createdByUserId: req.user!.internalId,
    });
    return reply.code(201).send(dto);
  });

  /** The website's photo library at the bucket root, for picking a cover without re-uploading. */
  app.get('/images/shared', { preHandler: requireAdmin }, async (_req, reply) => {
    if (!isB2Configured()) {
      return reply.code(503).send({ error: 'b2_not_configured', message: 'Backblaze B2 is not configured on this server.' });
    }
    const pics = await listSharedPictures();
    return pics.map((p) => ({ ...p, url: sharedUrl(p.key), thumbUrl: sharedUrl(p.thumbKey) }));
  });

  /** Bring one of the website's pictures into the pool (idempotent per key). */
  app.post<{ Body: { key?: unknown } }>('/images/adopt', { preHandler: requireAdmin }, async (req, reply) => {
    if (!isB2Configured()) {
      return reply.code(503).send({ error: 'b2_not_configured', message: 'Backblaze B2 is not configured on this server.' });
    }
    const key = req.body?.key;
    if (typeof key !== 'string' || !isSharedPictureKey(key)) return reply.code(400).send({ error: 'not a picture at the bucket root' });
    const existing = getImageBySharedKey(key);
    if (existing) return existing;
    const pic = (await listSharedPictures()).find((p) => p.key === key);
    if (!pic) return reply.code(404).send({ error: 'not found in bucket' });
    const dto = createImage({
      storage: 'b2',
      storageKey: key,
      filename: key,
      mimeType: pic.mimeType,
      sizeBytes: pic.sizeBytes,
      createdByUserId: req.user!.internalId,
      shared: true,
    });
    return reply.code(201).send(dto);
  });

  app.delete<{ Params: { id: string } }>('/images/:id', { preHandler: requireAuth }, async (req, reply) => {
    if (!isAdmin(req.user!)) return reply.code(403).send({ error: 'forbidden', message: 'admin role required' });
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'invalid id' });
    const loc = getImageStorage(id);
    if (!loc) return reply.code(404).send({ error: 'not found' });
    if (!deleteImage(id)) return reply.code(404).send({ error: 'not found' });
    // Website pictures belong to the website; only the pool entry goes.
    if (loc.storage === 'b2' && !loc.shared && isB2Configured()) {
      await deleteObject(loc.storageKey).catch((e) => req.log.warn({ err: e, key: loc.storageKey }, 'failed to delete picture from B2'));
    }
    return reply.code(204).send();
  });
};
