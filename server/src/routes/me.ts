import type { FastifyPluginAsync } from 'fastify';
import { requireAuth, partFromIdentity } from '../auth/middleware.ts';
import { setUserSectionId } from '../db/index.ts';
import { sectionExists } from '../db/sections.ts';

/** Member self-service preferences. Currently just their voice part. */
export const meRoutes: FastifyPluginAsync = async (app) => {
  app.patch<{ Body: { sectionId?: number | null } }>('/me', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || !('sectionId' in body)) {
      return reply.code(400).send({ error: 'sectionId required (number or null)' });
    }
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
};
