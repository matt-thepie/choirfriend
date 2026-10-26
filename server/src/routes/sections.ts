import type { FastifyPluginAsync } from 'fastify';
import { listSections, replaceSections, type SectionInput } from '../db/sections.ts';
import { requireAdmin, requireAuth } from '../auth/middleware.ts';

export const sectionsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/sections', { preHandler: requireAuth }, async () => listSections());

  /** Admin: replace the whole ordered list. Body: [{ id?, label, badge }]. */
  app.put<{ Body: SectionInput[] }>('/sections', { preHandler: requireAdmin }, async (req, reply) => {
    const body = req.body;
    if (!Array.isArray(body) || body.length === 0) {
      return reply.code(400).send({ error: 'expected a non-empty array of sections' });
    }
    const cleaned: SectionInput[] = [];
    for (const s of body) {
      if (!s || typeof s.label !== 'string' || typeof s.badge !== 'string') {
        return reply.code(400).send({ error: 'each section needs label and badge strings' });
      }
      const label = s.label.trim();
      const badge = s.badge.trim();
      if (!label || !badge) return reply.code(400).send({ error: 'label and badge must be non-empty' });
      if (s.id !== undefined && !Number.isInteger(s.id)) return reply.code(400).send({ error: 'id must be an integer' });
      cleaned.push({ ...(s.id !== undefined && { id: s.id }), label, badge });
    }
    return replaceSections(cleaned);
  });
};
