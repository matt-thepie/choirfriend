import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeS3 } from './fake-s3.ts';

const s3 = await startFakeS3();

const dir = mkdtempSync(join(tmpdir(), 'choirfriend-media-'));
process.env.DATABASE_FILE = join(dir, 'test.db');
process.env.SESSION_SECRET = 'test-only-secret';
process.env.NODE_ENV = 'test';
process.env.DEV_AUTH_BYPASS = 'true';
process.env.AUTH_SGMC_IDENTITY_ENABLED = 'false';
process.env.AUTH_OIDC_ENABLED = 'false';
process.env.ADMIN_ROLES = 'committee';
process.env.SCORE_ROLES = 'md';
process.env.B2_KEY_ID = 'public-key';
process.env.B2_APPLICATION_KEY = 'public-secret';
process.env.B2_BUCKET = 'shared';
process.env.B2_ENDPOINT = s3.endpoint;
process.env.B2_REGION = 'eu-test-1';
process.env.B2_KEY_PREFIX = 'music/';
process.env.B2_PUBLIC_BASE_URL = 'https://cdn.example.test';
process.env.B2_MUSIC_BUCKET = 'private';
process.env.B2_MUSIC_KEY_ID = 'music-key';
process.env.B2_MUSIC_APPLICATION_KEY = 'music-secret';
process.env.DEV_AUTH_EMAIL = 'member@example.test';
process.env.DEV_AUTH_ROLES = 'member';

const { default: Fastify } = await import('fastify');
const { db, upsertUserByEmail } = await import('../src/db/index.ts');
const { createFile, createPiece } = await import('../src/db/pieces.ts');
const { markRenditionPending, markRenditionReady } = await import('../src/db/renditions.ts');
const { piecesRoutes } = await import('../src/routes/pieces.ts');
const { filesRoutes } = await import('../src/routes/files.ts');
const { imagesRoutes } = await import('../src/routes/images.ts');
const { offlineRoutes } = await import('../src/routes/offline.ts');
const { mediaRoutes } = await import('../src/routes/media.ts');
const { copyMusicToPrivate } = await import('../src/tools/copy-music-to-private.ts');

const app = Fastify();
for (const routes of [piecesRoutes, filesRoutes, imagesRoutes, offlineRoutes, mediaRoutes]) await app.register(routes, { prefix: '/api' });

function as(email: string, roles: string): void {
  process.env.DEV_AUTH_BYPASS = 'true';
  process.env.DEV_AUTH_EMAIL = email;
  process.env.DEV_AUTH_ROLES = roles;
}
function signedOut(): void {
  process.env.DEV_AUTH_BYPASS = 'false';
}

const PDF = '%PDF-1.7 sheet music bytes';
const MP3 = 'ID3 learning track bytes, long enough to take a range from';
const MSCZ = 'PK editable score bytes';
const XML = '<score-partwise>flowing</score-partwise>';

const piece = createPiece({ title: 'Gloria' });
const uploader = upsertUserByEmail({ email: 'tenor@example.test', displayName: 'Tenor', roles: ['member'] });
const K = {
  pdf: `pieces/${piece.id}/files/aaaa1111/Gloria.pdf`,
  mp3: `pieces/${piece.id}/files/bbbb2222/Tenor 1.mp3`,
  mine: `pieces/${piece.id}/files/cccc3333/my-take.mp3`,
  mscz: `pieces/${piece.id}/files/dddd4444/Gloria.mscz`,
  xml: `pieces/${piece.id}/files/eeee5555/Gloria.xml`,
  late: `pieces/${piece.id}/files/ffff6666/Late.pdf`,
};
const file = (key: string, kind: 'pdf' | 'audio' | 'score', mimeType: string, extra: object = {}) =>
  createFile({ pieceId: piece.id, kind, storage: 'b2', storageKey: key, filename: key.split('/').pop()!, mimeType, ...extra });
file(K.pdf, 'pdf', 'application/pdf');
file(K.mp3, 'audio', 'audio/mpeg');
file(K.mine, 'audio', 'audio/mpeg', { visibility: 'private', createdByUserId: uploader });
const score = file(K.mscz, 'score', 'application/octet-stream');
markRenditionPending(score.id, K.mscz);
markRenditionReady(score.id, 'b2', K.xml, XML.length);
file(K.late, 'pdf', 'application/pdf');

s3.put('private', `music/${K.pdf}`, PDF, 'application/pdf');
s3.put('private', `music/${K.mp3}`, MP3, 'audio/mpeg');
s3.put('private', `music/${K.mine}`, MP3, 'audio/mpeg');
s3.put('private', `music/${K.mscz}`, MSCZ);
s3.put('private', `music/${K.xml}`, XML);
// Uploaded to the old bucket and not copied across yet.
s3.put('shared', `music/${K.late}`, PDF, 'application/pdf');

const media = (key: string) => `/api/media/${key.split('/').map(encodeURIComponent).join('/')}`;

await test('music is refused without a session', async () => {
  signedOut();
  for (const key of Object.values(K)) {
    for (const method of ['GET', 'HEAD'] as const) {
      const res = await app.inject({ method, url: media(key) });
      assert.equal(res.statusCode, 401, `${method} ${key}`);
      assert.ok(!res.body.includes('bytes'), 'no file content in the refusal');
    }
  }
  assert.equal((await app.inject({ url: media(K.mp3), headers: { range: 'bytes=0-9' } })).statusCode, 401);
  // The API that hands out the addresses is closed too.
  assert.equal((await app.inject(`/api/pieces/${piece.id}`)).statusCode, 401);
  // Nothing was fetched from storage for any of that.
  assert.deepEqual(s3.requests, []);
});

await test('a signed-in member is served the file, from the private bucket', async () => {
  as('member@example.test', 'member');
  const res = await app.inject(media(K.pdf));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, PDF);
  assert.equal(res.headers['content-type'], 'application/pdf');
  assert.equal(res.headers['content-length'], String(PDF.length));
  assert.match(String(res.headers['content-disposition']), /^inline; filename="Gloria\.pdf"/);
  assert.ok(s3.requests.includes(`GET private/music/${K.pdf}`));
  assert.ok(!s3.requests.some((r) => r.includes('shared/')), 'the public bucket was not touched');

  const head = await app.inject({ method: 'HEAD', url: media(K.pdf) });
  assert.equal(head.statusCode, 200);
  assert.equal(head.body, '');
  assert.equal(head.headers['content-length'], String(PDF.length));
});

await test('responses are marked private so no shared cache keeps them', async () => {
  as('member@example.test', 'member');
  for (const res of [await app.inject(media(K.pdf)), await app.inject({ url: media(K.mp3), headers: { range: 'bytes=0-3' } })]) {
    assert.equal(res.headers['cache-control'], 'private, no-cache');
  }
  assert.equal((await app.inject(media('pieces/1/files/nope/x.pdf'))).headers['cache-control'], 'no-store');
});

await test('byte ranges and revalidation pass through (audio seeking)', async () => {
  as('member@example.test', 'member');
  const part = await app.inject({ url: media(K.mp3), headers: { range: 'bytes=4-11' } });
  assert.equal(part.statusCode, 206);
  assert.equal(part.body, MP3.slice(4, 12));
  assert.equal(part.headers['content-range'], `bytes 4-11/${MP3.length}`);
  assert.equal(part.headers['accept-ranges'], 'bytes');

  assert.equal((await app.inject({ url: media(K.mp3), headers: { range: 'bytes=99999-' } })).statusCode, 416);

  const etag = String((await app.inject(media(K.mp3))).headers.etag);
  assert.equal((await app.inject({ url: media(K.mp3), headers: { 'if-none-match': etag } })).statusCode, 304);
});

await test('the same visibility rules as the piece API apply', async () => {
  // A private upload is its uploader's alone.
  as('member@example.test', 'member');
  assert.equal((await app.inject(media(K.mine))).statusCode, 404);
  as('committee@example.test', 'committee');
  assert.equal((await app.inject(media(K.mine))).statusCode, 404);
  as('tenor@example.test', 'member');
  assert.equal((await app.inject(media(K.mine))).body, MP3);

  // Editable scores are for the roles that may see them; the flowing view is for everyone.
  as('member@example.test', 'member');
  assert.equal((await app.inject(media(K.mscz))).statusCode, 404);
  const flowing = await app.inject(media(K.xml));
  assert.equal(flowing.body, XML);
  assert.equal(flowing.headers['content-type'], 'application/vnd.recordare.musicxml+xml');
  as('md@example.test', 'md');
  assert.equal((await app.inject(media(K.mscz))).body, MSCZ);
});

await test('only files the database knows are served', async () => {
  as('committee@example.test', 'committee');
  s3.put('private', 'music/pieces/999/files/zzzz/stray.pdf', 'stray');
  s3.put('shared', 'holiday.jpg', 'website picture');
  for (const key of ['pieces/999/files/zzzz/stray.pdf', 'holiday.jpg', '../shared/holiday.jpg', 'images/ab12cd34/poster.jpg', '']) {
    assert.equal((await app.inject(`/api/media/${key}`)).statusCode, 404, key);
  }
});

await test('the API hands out stable app addresses for music', async () => {
  as('md@example.test', 'md');
  const first = (await app.inject(`/api/pieces/${piece.id}`)).json();
  const again = (await app.inject(`/api/pieces/${piece.id}`)).json();
  const urls = first.files.map((f: { url: string }) => f.url);
  assert.deepEqual(urls, again.files.map((f: { url: string }) => f.url), 'the same address every time');
  assert.ok(urls.includes(media(K.pdf)));
  assert.ok(urls.includes('/api/media/pieces/' + piece.id + '/files/bbbb2222/Tenor%201.mp3'));
  assert.ok(urls.every((u: string) => u.startsWith('/api/media/')));
  assert.equal(first.flowing[0].url, media(K.xml));

  // The offline list uses the same addresses, ending in .pdf / .xml as the service worker expects.
  const offline = (await app.inject('/api/offline/scores')).json().scores as Array<{ url: string }>;
  assert.deepEqual(offline.map((s) => s.url).sort(), [media(K.pdf), media(K.xml), media(K.late)].sort());
  assert.ok(offline.every((s) => /\.(pdf|xml)$/.test(s.url)));
  // Every address the API gives out can be fetched.
  for (const u of [...urls, first.flowing[0].url]) assert.equal((await app.inject(u)).statusCode, 200, u);
});

await test('uploads go to the private bucket', async () => {
  as('committee@example.test', 'committee');
  const signed = (await app.inject({ method: 'POST', url: `/api/pieces/${piece.id}/files/sign-upload`, payload: { filename: 'New.pdf', kind: 'pdf', mimeType: 'application/pdf' } })).json();
  assert.ok(signed.url.startsWith(`${s3.endpoint}/private/music/pieces/${piece.id}/files/`), signed.url);
  assert.match(signed.url, /X-Amz-Credential=music-key/);
});

await test('cover pictures stay public', async () => {
  as('committee@example.test', 'committee');
  const signed = (await app.inject({ method: 'POST', url: '/api/images/sign-upload', payload: { filename: 'poster.jpg', mimeType: 'image/jpeg' } })).json();
  assert.ok(signed.url.startsWith(`${s3.endpoint}/shared/music/images/`), signed.url);
  assert.match(signed.url, /X-Amz-Credential=public-key/);

  const created = await app.inject({ method: 'POST', url: '/api/images/complete-upload', payload: { storageKey: 'images/ab12cd34/poster.jpg', filename: 'poster.jpg', mimeType: 'image/jpeg' } });
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().url, 'https://cdn.example.test/music/images/ab12cd34/poster.jpg');

  // A picture adopted from the website's library keeps its bucket-root address.
  s3.put('shared', 'holiday.jpg', 'website picture', 'image/jpeg');
  const adopted = await app.inject({ method: 'POST', url: '/api/images/adopt', payload: { key: 'holiday.jpg' } });
  assert.equal(adopted.statusCode, 201);
  assert.equal(adopted.json().url, 'https://cdn.example.test/holiday.jpg');
  const pool = (await app.inject('/api/images')).json() as Array<{ url: string }>;
  assert.ok(pool.every((p) => p.url.startsWith('https://cdn.example.test/')));

  // Deleting a cover removes it from the public bucket, not the private one.
  s3.put('shared', 'music/images/ab12cd34/poster.jpg', 'jpeg');
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/images/${created.json().id}` })).statusCode, 204);
  assert.ok(!s3.objects.has('shared/music/images/ab12cd34/poster.jpg'));
});

await test('a file not copied across yet is still served, from the old bucket', async () => {
  as('member@example.test', 'member');
  s3.requests.length = 0;
  const res = await app.inject(media(K.late));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, PDF);
  assert.deepEqual(s3.requests, [`GET private/music/${K.late}`, `GET shared/music/${K.late}`]);
  // ...and still only for members.
  signedOut();
  assert.equal((await app.inject(media(K.late))).statusCode, 401);
});

await test('the copy tool: dry run writes nothing, a real run copies music only, nothing is deleted', async () => {
  // The old bucket as it is today: all the music, a cover, and the website's pictures.
  for (const key of [K.pdf, K.mp3, K.mine, K.mscz, K.xml]) {
    const o = s3.objects.get(`private/music/${key}`)!;
    s3.put('shared', `music/${key}`, o.body, o.contentType);
  }
  s3.put('shared', 'music/images/ab12cd34/cover.jpg', 'jpeg');
  for (const key of [K.mp3, K.mine]) s3.objects.delete(`private/music/${key}`);
  const before = new Map(s3.objects);

  const dry = await copyMusicToPrivate({ execute: false });
  assert.deepEqual(dry.copied.sort(), [K.mp3, K.mine, K.late].sort());
  assert.deepEqual(dry.missingFromMusic, []);
  assert.deepEqual([...s3.objects.keys()].sort(), [...before.keys()].sort(), 'dry run changed nothing');
  assert.ok(!s3.requests.some((r) => /^(PUT|DELETE) /.test(r)));

  const run = await copyMusicToPrivate({ execute: true });
  assert.deepEqual(run.copied.sort(), [K.mp3, K.mine, K.late].sort());
  assert.deepEqual(run.failed, []);
  assert.deepEqual(run.missingFromMusic, []);
  assert.equal(s3.objects.get(`private/music/${K.late}`)!.body.toString(), PDF);
  assert.equal(s3.objects.get(`private/music/${K.mp3}`)!.contentType, 'audio/mpeg');
  assert.ok(![...s3.objects.keys()].some((k) => k.startsWith('private/') && !k.startsWith('private/music/pieces/')), 'covers and website pictures were not copied');
  for (const [k, v] of before) assert.equal(s3.objects.get(k)?.body, v.body, `${k} untouched`);
  assert.ok(!s3.requests.some((r) => r.startsWith('DELETE ')));

  const again = await copyMusicToPrivate({ execute: true });
  assert.deepEqual(again.copied, []);

  // A file in the database with no object anywhere is reported.
  file(`pieces/${piece.id}/files/9999aaaa/Lost.pdf`, 'pdf', 'application/pdf');
  assert.deepEqual((await copyMusicToPrivate({ execute: false })).missingFromMusic, [`pieces/${piece.id}/files/9999aaaa/Lost.pdf`]);
  as('member@example.test', 'member');
  assert.equal((await app.inject(media(`pieces/${piece.id}/files/9999aaaa/Lost.pdf`))).statusCode, 404);
});

await test('without a private bucket everything is as it was: public addresses, one bucket', async () => {
  const saved = process.env.B2_MUSIC_BUCKET;
  delete process.env.B2_MUSIC_BUCKET;
  try {
    as('md@example.test', 'md');
    const body = (await app.inject(`/api/pieces/${piece.id}`)).json();
    const urls = body.files.map((f: { url: string }) => f.url);
    assert.ok(urls.includes(`https://cdn.example.test/music/${K.pdf}`));
    assert.ok(urls.every((u: string) => u.startsWith('https://cdn.example.test/music/pieces/')));
    assert.equal(body.flowing[0].url, `https://cdn.example.test/music/${K.xml}`);
    const offline = (await app.inject('/api/offline/scores')).json().scores as Array<{ url: string }>;
    assert.ok(offline.every((s) => s.url.startsWith('https://cdn.example.test/music/pieces/')));

    as('committee@example.test', 'committee');
    const signed = (await app.inject({ method: 'POST', url: `/api/pieces/${piece.id}/files/sign-upload`, payload: { filename: 'New.pdf', kind: 'pdf', mimeType: 'application/pdf' } })).json();
    assert.ok(signed.url.startsWith(`${s3.endpoint}/shared/music/pieces/${piece.id}/files/`), signed.url);
    assert.match(signed.url, /X-Amz-Credential=public-key/);
    await assert.rejects(copyMusicToPrivate({ execute: true }), /B2_MUSIC_BUCKET is not set/);
  } finally {
    process.env.B2_MUSIC_BUCKET = saved;
  }
});

db.close();
await app.close();
await s3.close();
