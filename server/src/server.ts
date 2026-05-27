import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import { healthRoutes } from './routes/health.ts';
import { authRoutes } from './auth/routes.ts';
import { piecesRoutes } from './routes/pieces.ts';
import { annotationRoutes } from './routes/annotations.ts';
import { getConfig } from './config.ts';
import { seedIfEmpty } from './seed.ts';

const config = getConfig();

const app = Fastify({
  logger: {
    level: config.nodeEnv === 'production' ? 'info' : 'debug',
  },
});

await app.register(cors, {
  origin: config.clientOrigin,
  credentials: true,
});

await app.register(cookie, {
  secret: config.sessionSecret,
});

await app.register(healthRoutes, { prefix: '/api' });
await app.register(piecesRoutes, { prefix: '/api' });
await app.register(annotationRoutes, { prefix: '/api' });
await app.register(authRoutes, { prefix: '/auth' });

// First-boot seed (no-op if pieces already exist).
seedIfEmpty();

try {
  await app.listen({ port: config.port, host: '0.0.0.0' });
  app.log.info(`choirfriend server listening on :${config.port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
