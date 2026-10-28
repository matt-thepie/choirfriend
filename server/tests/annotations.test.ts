import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'choirfriend-annotations-'));
process.env.DATABASE_FILE = join(dir, 'test.db');
process.env.SESSION_SECRET = 'test-only-secret';
process.env.NODE_ENV = 'test';
process.env.DEV_AUTH_BYPASS = 'true';
process.env.AUTH_SGMC_IDENTITY_ENABLED = 'false';
process.env.AUTH_OIDC_ENABLED = 'false';
process.env.DEV_AUTH_EMAIL = 'owner@example.test';

const { default: Fastify } = await import('fastify');
const { db } = await import('../src/db/index.ts');
const { annotationRoutes } = await import('../src/routes/annotations.ts');
const app = Fastify();
await app.register(annotationRoutes, { prefix: '/api' });
db.exec(`INSERT INTO pieces (id, title) VALUES (1, 'Test');
  INSERT INTO files (id, piece_id, kind, storage, storage_key, filename) VALUES (1, 1, 'pdf', 'local', 'test.pdf', 'test.pdf')`);

await test('marker edits persist without changing authorship, audience or file; invalid edits are rejected', async () => {
  const input = { id: 'private-marker', fileId: 1, page: 1, kind: 'marker', layer: 'private', markerKind: 'repeat-end', label: null, position: { x: .2, y: .3 } };
  assert.equal((await app.inject({ method: 'POST', url: '/api/pieces/1/annotations', payload: input })).statusCode, 201);
  const edited = await app.inject({ method: 'PATCH', url: '/api/annotations/private-marker', payload: { page: 2, markerKind: 'coda', label: 'B', position: { x: .7, y: .8 }, fileId: 999, layer: 'shared' } });
  assert.equal(edited.statusCode, 200);
  assert.equal(edited.json().authorEmail, 'owner@example.test');
  assert.equal(edited.json().fileId, 1);
  assert.equal(edited.json().layer, 'private');
  const loaded = (await app.inject('/api/pieces/1/annotations')).json()[0];
  assert.equal(loaded.markerKind, 'coda');
  assert.equal(loaded.page, 2);
  assert.deepEqual(loaded.position, { x: .7, y: .8 });
  for (const payload of [{ position: { x: 2, y: .1 } }, { page: 0 }, { markerKind: 'invalid' }]) {
    assert.equal((await app.inject({ method: 'PATCH', url: '/api/annotations/private-marker', payload })).statusCode, 400);
  }
  process.env.DEV_AUTH_EMAIL = 'other@example.test';
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/annotations/private-marker', payload: { label: 'No' } })).statusCode, 404);
  process.env.DEV_AUTH_EMAIL = 'owner@example.test';
});

await test('individual deletion leaves later marks intact and deleted content can be recreated for redo', async () => {
  const ink = { id: 'ink', fileId: 1, page: 1, kind: 'ink', layer: 'private', pen: 'highlighter', color: '#fde047', width: 12, points: [{ x: .1, y: .2 }, { x: .8, y: .2 }] };
  assert.equal((await app.inject({ method: 'POST', url: '/api/pieces/1/annotations', payload: ink })).statusCode, 201);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/annotations/private-marker' })).statusCode, 204);
  assert.deepEqual((await app.inject('/api/pieces/1/annotations')).json().map((a: {id: string}) => a.id), ['ink']);
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/annotations/ink', payload: { label: 'bad' } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/annotations/ink' })).statusCode, 204);
  assert.equal((await app.inject({ method: 'POST', url: '/api/pieces/1/annotations', payload: { ...ink, id: 'redone' } })).statusCode, 201);
  const restored = (await app.inject('/api/pieces/1/annotations')).json()[0];
  assert.deepEqual(restored.points, ink.points);
  assert.equal(restored.pen, 'highlighter');
});

await test('shared marker edits preserve the original author and reject malformed bodies', async () => {
  const input = { id: 'shared-marker', fileId: 1, page: 1, kind: 'marker', layer: 'shared', markerKind: 'segno', label: null, position: { x: .2, y: .3 } };
  assert.equal((await app.inject({ method: 'POST', url: '/api/pieces/1/annotations', payload: input })).statusCode, 201);
  process.env.DEV_AUTH_EMAIL = 'other@example.test';
  const edited = await app.inject({ method: 'PATCH', url: '/api/annotations/shared-marker', payload: { position: { x: .4, y: .5 } } });
  assert.equal(edited.statusCode, 200);
  assert.equal(edited.json().authorEmail, 'owner@example.test');
  assert.equal(edited.json().isMine, false);
  assert.deepEqual(edited.json().position, { x: .4, y: .5 });
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/annotations/shared-marker', payload: [] })).statusCode, 400);
  process.env.DEV_AUTH_EMAIL = 'owner@example.test';
});

await test('redo restores a deleted shared mark with its original author, only for the member who deleted it', async () => {
  const input = { id: 'shared-to-redo', fileId: 1, page: 1, kind: 'marker', layer: 'shared', markerKind: 'fine', label: null, position: { x: .5, y: .5 } };
  assert.equal((await app.inject({ method: 'POST', url: '/api/pieces/1/annotations', payload: input })).statusCode, 201);
  process.env.DEV_AUTH_EMAIL = 'other@example.test';
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/annotations/shared-to-redo' })).statusCode, 204);
  assert.ok(!(await app.inject('/api/pieces/1/annotations')).json().some((a: {id: string}) => a.id === 'shared-to-redo'));
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/annotations/shared-to-redo', payload: { label: 'x' } })).statusCode, 404);
  process.env.DEV_AUTH_EMAIL = 'owner@example.test';
  assert.equal((await app.inject({ method: 'POST', url: '/api/annotations/shared-to-redo/restore' })).statusCode, 404);
  process.env.DEV_AUTH_EMAIL = 'other@example.test';
  const restored = await app.inject({ method: 'POST', url: '/api/annotations/shared-to-redo/restore' });
  assert.equal(restored.statusCode, 200);
  assert.equal(restored.json().authorEmail, 'owner@example.test');
  assert.equal(restored.json().isMine, false);
  assert.equal((await app.inject({ method: 'POST', url: '/api/annotations/shared-to-redo/restore' })).statusCode, 404);
  process.env.DEV_AUTH_EMAIL = 'owner@example.test';
  assert.ok((await app.inject('/api/pieces/1/annotations')).json().some((a: {id: string}) => a.id === 'shared-to-redo'));
});

await app.close();
db.close();
rmSync(dir, { recursive: true, force: true });
