import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { healthRoutes } from './routes/health.ts';
import { authRoutes } from './auth/routes.ts';
import { piecesRoutes } from './routes/pieces.ts';
import { filesRoutes } from './routes/files.ts';
import { annotationRoutes } from './routes/annotations.ts';
import { importRoutes } from './routes/import.ts';
import { sectionsRoutes } from './routes/sections.ts';
import { setListsRoutes } from './routes/setlists.ts';
import { meRoutes } from './routes/me.ts';
import { offlineRoutes } from './routes/offline.ts';
import { backfillAudioSections, seedSectionsIfEmpty } from './db/sections.ts';
import { getConfig } from './config.ts';
import { seedIfEmpty } from './seed.ts';
import { resumeRenditions } from './scores/render.ts';
import { purgeDeletedAnnotations } from './db/annotations.ts';

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

// Importer routes the file bytes through the server; cap the per-file size in
// line with the presigned-upload limit (~200MB covers long audio tracks).
await app.register(multipart, {
  limits: { fileSize: 200 * 1024 * 1024 },
});

await app.register(healthRoutes, { prefix: '/api' });
await app.register(piecesRoutes, { prefix: '/api' });
await app.register(filesRoutes, { prefix: '/api' });
await app.register(annotationRoutes, { prefix: '/api' });
await app.register(importRoutes, { prefix: '/api' });
await app.register(sectionsRoutes, { prefix: '/api' });
await app.register(setListsRoutes, { prefix: '/api' });
await app.register(meRoutes, { prefix: '/api' });
await app.register(offlineRoutes, { prefix: '/api' });
await app.register(authRoutes, { prefix: '/auth' });

// First-boot seed (no-op if pieces already exist).
seedIfEmpty();
seedSectionsIfEmpty();
backfillAudioSections();
// Flowing scores missing or out of date are converted in the background.
resumeRenditions();
// Deleted marks stay restorable for a day; clear expired ones now and hourly.
purgeDeletedAnnotations();
setInterval(purgeDeletedAnnotations, 60 * 60 * 1000).unref();

try {
  await app.listen({ port: config.port, host: '0.0.0.0' });
  app.log.info(`choirfriend server listening on :${config.port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
