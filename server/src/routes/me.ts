import type { FastifyPluginAsync } from 'fastify';
import { requireAuth, partFromIdentity } from '../auth/middleware.ts';
import { getPartLineOverrides, setPartLineOverrides, setUserPartLine, setUserSectionId } from '../db/index.ts';
import { getFileRowById } from '../db/pieces.ts';
import { sectionExists } from '../db/sections.ts';

/** Member self-service preferences: their voice part and "My line". */
export const meRoutes: FastifyPluginAsync = async (app) => {
  app.patch<{ Body: { sectionId?: number | null; partLine?: boolean } }>('/me', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || !('sectionId' in body || 'partLine' in body)) {
      return reply.code(400).send({ error: 'sectionId (number or null) or partLine (boolean) required' });
    }
    if ('partLine' in body) {
      if (typeof body.partLine !== 'boolean') return reply.code(400).send({ error: 'partLine must be a boolean' });
      setUserPartLine(req.user!.internalId, body.partLine);
    }
    if (!('sectionId' in body)) return { partLine: body.partLine };

    const sectionId = body.sectionId;
    if (sectionId !== null && (!Number.isInteger(sectionId) || !sectionExists(sectionId as number))) {
      return reply.code(400).send({ error: 'unknown section' });
    }
    if (partFromIdentity(req.user!)) {
      return reply.code(409).send({ error: 'Your part is set in your SGMC profile' });
    }
    setUserSectionId(req.user!.internalId, sectionId as number | null);
    return { sectionId };
  });

  // The member's corrections to the "My line" guess for one PDF.
  app.get<{ Params: { fileId: string } }>('/me/part-lines/:fileId', { preHandler: requireAuth }, async (req, reply) => {
    const fileId = Number(req.params.fileId);
    if (!Number.isInteger(fileId)) return reply.code(400).send({ error: 'invalid file id' });
    return getPartLineOverrides(req.user!.internalId, fileId);
  });

  app.put<{ Params: { fileId: string }; Body: unknown }>('/me/part-lines/:fileId', { preHandler: requireAuth }, async (req, reply) => {
    const fileId = Number(req.params.fileId);
    if (!Number.isInteger(fileId) || !getFileRowById(fileId)) return reply.code(404).send({ error: 'file not found' });
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return reply.code(400).send({ error: 'object required' });
    const overrides: Record<string, number> = {};
    for (const [k, v] of Object.entries(body)) {
      if (!/^\d+:\d+$/.test(k) || !Number.isInteger(v) || (v as number) < -1) {
        return reply.code(400).send({ error: `invalid entry ${k}` });
      }
      overrides[k] = v as number;
    }
    setPartLineOverrides(req.user!.internalId, fileId, overrides);
    return overrides;
  });
};
