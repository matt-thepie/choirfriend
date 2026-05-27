import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import { healthRoutes } from './routes/health.ts';
import { authRoutes } from './auth/routes.ts';
import { getConfig } from './config.ts';

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
await app.register(authRoutes, { prefix: '/auth' });

try {
  await app.listen({ port: config.port, host: '0.0.0.0' });
  app.log.info(`choirfriend server listening on :${config.port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
