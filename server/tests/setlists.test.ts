import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'choirfriend-setlists-'));
process.env.DATABASE_FILE = join(dir, 'test.db');
process.env.SESSION_SECRET = 'test-only-secret';
process.env.NODE_ENV = 'test';
process.env.DEV_AUTH_BYPASS = 'true';
process.env.AUTH_SGMC_IDENTITY_ENABLED = 'false';
process.env.AUTH_OIDC_ENABLED = 'false';
process.env.ADMIN_ROLES = 'admin';
process.env.DEV_AUTH_EMAIL = 'member@example.test';
process.env.DEV_AUTH_ROLES = 'member';

const { default: Fastify } = await import('fastify');
const { db } = await import('../src/db/index.ts');
const { setListsRoutes } = await import('../src/routes/setlists.ts');
const { offlineRoutes } = await import('../src/routes/offline.ts');
const app = Fastify();
await app.register(setListsRoutes, { prefix: '/api' });
await app.register(offlineRoutes, { prefix: '/api' });
db.exec(`INSERT INTO pieces (id, title) VALUES (1, 'Alpha'), (2, 'Beta');
  INSERT INTO files (id, piece_id, kind, storage, storage_key, filename) VALUES (1, 1, 'pdf', 'local', 'a.pdf', 'a.pdf'), (2, 2, 'pdf', 'local', 'b.pdf', 'b.pdf');
  INSERT INTO set_lists (id, name) VALUES (10, 'Choir list');
  INSERT INTO set_list_items (set_list_id, piece_id, position) VALUES (10, 1, 0)`);

function as(email: string, roles: string): void {
  process.env.DEV_AUTH_EMAIL = email;
  process.env.DEV_AUTH_ROLES = roles;
}

await test('a member creates a personal list, which only they can see', async () => {
  as('member@example.test', 'member');
  // Even asking for a choir list gives a member a personal one.
  const created = await app.inject({ method: 'POST', url: '/api/setlists', payload: { name: 'My practice', personal: false, pieceIds: [2] } });
  assert.equal(created.statusCode, 201);
  const mine = created.json();
  assert.equal(mine.personal, true);
  assert.equal(mine.mine, true);

  const list = (await app.inject('/api/setlists')).json();
  assert.deepEqual(list.map((s: { name: string }) => s.name), ['Choir list', 'My practice']);
  assert.equal(list[0].mine, false);
  assert.equal((await app.inject(`/api/setlists/${mine.id}`)).statusCode, 200);

  // Another member and an admin see neither the list nor its id.
  as('other@example.test', 'member');
  assert.deepEqual((await app.inject('/api/setlists')).json().map((s: { name: string }) => s.name), ['Choir list']);
  assert.equal((await app.inject(`/api/setlists/${mine.id}`)).statusCode, 404);
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/setlists/${mine.id}`, payload: { name: 'Hijack' } })).statusCode, 404);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/setlists/${mine.id}` })).statusCode, 404);
  as('admin@example.test', 'admin');
  assert.deepEqual((await app.inject('/api/setlists')).json().map((s: { name: string }) => s.name), ['Choir list']);
  assert.equal((await app.inject(`/api/setlists/${mine.id}`)).statusCode, 404);
});

await test('the owner edits and deletes their personal list but cannot pin it', async () => {
  as('member@example.test', 'member');
  const id = (await app.inject('/api/setlists')).json().find((s: { mine: boolean }) => s.mine).id;
  const edited = await app.inject({ method: 'PATCH', url: `/api/setlists/${id}`, payload: { name: 'Renamed', pieceIds: [2, 1] } });
  assert.equal(edited.statusCode, 200);
  assert.equal(edited.json().name, 'Renamed');
  assert.deepEqual(edited.json().songs.map((s: { id: number }) => s.id), [2, 1]);
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/setlists/${id}`, payload: { pinned: true } })).statusCode, 400);

  // Offline sync counts the member's own list as "on a set list"; others' don't.
  const scores = (await app.inject('/api/offline/scores')).json();
  assert.equal(scores.scores.find((s: { fileId: number }) => s.fileId === 2).inSetList, true);
  as('other@example.test', 'member');
  const otherScores = (await app.inject('/api/offline/scores')).json();
  assert.equal(otherScores.scores.find((s: { fileId: number }) => s.fileId === 2).inSetList, false);

  as('member@example.test', 'member');
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/setlists/${id}` })).statusCode, 204);
  assert.equal((await app.inject(`/api/setlists/${id}`)).statusCode, 404);
});

await test('choir lists stay admin-only to edit; members copy them into their own', async () => {
  as('member@example.test', 'member');
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/setlists/10', payload: { name: 'Nope' } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/setlists/10' })).statusCode, 403);
  const copy = await app.inject({ method: 'POST', url: '/api/setlists/10/copy' });
  assert.equal(copy.statusCode, 201);
  assert.equal(copy.json().personal, true);
  assert.equal(copy.json().mine, true);
  assert.deepEqual(copy.json().songs.map((s: { id: number }) => s.id), [1]);

  as('admin@example.test', 'admin');
  const adminCopy = await app.inject({ method: 'POST', url: '/api/setlists/10/copy' });
  assert.equal(adminCopy.json().personal, false);
  const own = await app.inject({ method: 'POST', url: '/api/setlists', payload: { name: 'Admin private', personal: true } });
  assert.equal(own.json().personal, true);
  const choir = await app.inject({ method: 'POST', url: '/api/setlists', payload: { name: 'Admin choir' } });
  assert.equal(choir.json().personal, false);
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/setlists/${choir.json().id}`, payload: { pinned: true } })).statusCode, 200);
});

await app.close();
