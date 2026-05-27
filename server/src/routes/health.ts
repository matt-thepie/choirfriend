import type { FastifyPluginAsync } from 'fastify';
import { db } from '../db/index.ts';

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get('/health', async () => {
    let database: 'ok' | 'unreachable' = 'unreachable';
    try {
      await db.query('SELECT 1');
      database = 'ok';
    } catch {
      database = 'unreachable';
    }
    return {
      status: 'ok',
      service: 'choirfriend',
      time: new Date().toISOString(),
      database,
    };
  });
};
