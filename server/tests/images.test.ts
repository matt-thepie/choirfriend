import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'choirfriend-images-'));
process.env.DATABASE_FILE = join(dir, 'test.db');
process.env.SESSION_SECRET = 'test-only-secret';
process.env.NODE_ENV = 'test';
process.env.DEV_AUTH_BYPASS = 'true';
process.env.AUTH_SGMC_IDENTITY_ENABLED = 'false';
process.env.AUTH_OIDC_ENABLED = 'false';
process.env.ADMIN_ROLES = 'committee';
process.env.B2_PUBLIC_BASE_URL = 'https://cdn.example.test';
process.env.B2_KEY_PREFIX = 'music/';
process.env.DEV_AUTH_EMAIL = 'committee@example.test';
process.env.DEV_AUTH_ROLES = 'committee';

const { default: Fastify } = await import('fastify');
const { setListsRoutes } = await import('../src/routes/setlists.ts');
const { imagesRoutes } = await import('../src/routes/images.ts');
const app = Fastify();
await app.register(setListsRoutes, { prefix: '/api' });
await app.register(imagesRoutes, { prefix: '/api' });

function as(email: string, roles: string): void {
  process.env.DEV_AUTH_EMAIL = email;
  process.env.DEV_AUTH_ROLES = roles;
}

const picture = { storageKey: 'images/ab12cd34/poster.jpg', filename: 'poster.jpg', mimeType: 'image/jpeg', sizeBytes: 1234 };

await test('committee members add pictures to the pool; members may only look', async () => {
  as('member@example.test', 'member');
  assert.equal((await app.inject({ method: 'POST', url: '/api/images/complete-upload', payload: picture })).statusCode, 403);

  as('committee@example.test', 'committee');
  // Only picture types, only in the images namespace.
  assert.equal((await app.inject({ method: 'POST', url: '/api/images/complete-upload', payload: { ...picture, mimeType: 'application/pdf', filename: 'x.pdf' } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/images/complete-upload', payload: { ...picture, storageKey: 'pieces/1/files/x.jpg' } })).statusCode, 400);
  const created = await app.inject({ method: 'POST', url: '/api/images/complete-upload', payload: picture });
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().url, 'https://cdn.example.test/music/images/ab12cd34/poster.jpg');

  as('member@example.test', 'member');
  const pool = (await app.inject('/api/images')).json();
  assert.equal(pool.length, 1);
  assert.equal(pool[0].usedBy, 0);
});

await test('a set list wears a picture from the pool, and loses it when the picture goes', async () => {
  as('committee@example.test', 'committee');
  const [img] = (await app.inject('/api/images')).json();
  assert.equal((await app.inject({ method: 'POST', url: '/api/setlists', payload: { name: 'Bad picture', imageId: 999 } })).statusCode, 400);

  const choir = (await app.inject({ method: 'POST', url: '/api/setlists', payload: { name: 'Spring concert', imageId: img.id } })).json();
  assert.equal(choir.imageId, img.id);
  assert.equal(choir.imageUrl, img.url);

  // A member picks the same picture for a personal list.
  as('member@example.test', 'member');
  const mine = (await app.inject({ method: 'POST', url: '/api/setlists', payload: { name: 'Mine' } })).json();
  const patched = await app.inject({ method: 'PATCH', url: `/api/setlists/${mine.id}`, payload: { imageId: img.id } });
  assert.equal(patched.statusCode, 200);
  assert.equal(patched.json().imageUrl, img.url);
  assert.equal((await app.inject('/api/images')).json()[0].usedBy, 2);
  // Clearing works with null.
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/setlists/${mine.id}`, payload: { imageId: null } })).json().imageId, null);
  // Members cannot delete pictures.
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/images/${img.id}` })).statusCode, 403);

  as('committee@example.test', 'committee');
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/images/${img.id}` })).statusCode, 204);
  const after = (await app.inject(`/api/setlists/${choir.id}`)).json();
  assert.equal(after.imageId, null);
  assert.equal(after.imageUrl, null);
  assert.deepEqual((await app.inject('/api/images')).json(), []);
});
