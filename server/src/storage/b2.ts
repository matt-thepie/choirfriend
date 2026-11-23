/**
 * Backblaze B2 storage adapter — speaks the S3-compatible API so we can use
 * the AWS SDK's presigning machinery without rewriting sigv4 by hand.
 *
 * All keys are *unprefixed* in this module's public API. Callers pass
 * "pieces/123/files/abc.pdf"; we prepend the configured B2_KEY_PREFIX
 * (e.g. "music/") before talking to B2. This keeps choirfriend confined to
 * its own folder when the bucket is shared with other SGMC services.
 *
 * Two stores:
 *   'public' — the shared bucket behind B2_PUBLIC_BASE_URL. Cover pictures
 *              live here, and anyone with the address can read them.
 *   'music'  — scores, PDFs and audio. With B2_MUSIC_BUCKET set this is a
 *              separate private bucket, read only through /api/media (see
 *              routes/media.ts). Without it, 'music' is the public bucket,
 *              exactly as before the private bucket existed.
 * Every call names its store, so nothing lands in the wrong bucket by default.
 *
 * Path-style addressing is required (Backblaze recommends it; some buckets
 * reject virtual-hosted-style).
 */

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { Buffer } from 'node:buffer';
import type { Readable } from 'node:stream';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getConfig } from '../config.ts';

export type Store = 'music' | 'public';

interface StoreConfig {
  keyId: string;
  applicationKey: string;
  bucket: string;
  endpoint: string;
  region: string;
  keyPrefix: string;
}

function storeConfig(store: Store): StoreConfig {
  const { b2 } = getConfig();
  return store === 'music' && b2.music ? b2.music : b2;
}

/** True when the music has its own bucket, so its files are served through
 *  the app (signed-in members only) instead of from the public address. */
export function isMusicPrivate(): boolean {
  return getConfig().b2.music !== null;
}

/** True when the music bucket is a different one from the public bucket. */
function musicIsSeparate(): boolean {
  const { b2 } = getConfig();
  return b2.music !== null && (b2.music.bucket !== b2.bucket || b2.music.endpoint !== b2.endpoint);
}

const clients = new Map<string, S3Client>();

function clientFor(store: Store): S3Client {
  if (!isB2Configured()) {
    throw new Error('B2 not configured — set B2_KEY_ID, B2_APPLICATION_KEY, B2_BUCKET, B2_ENDPOINT, B2_REGION');
  }
  const c = storeConfig(store);
  const id = `${c.endpoint}|${c.region}|${c.keyId}|${c.applicationKey}`;
  let client = clients.get(id);
  if (!client) {
    client = new S3Client({
      endpoint: c.endpoint,
      region: c.region,
      credentials: { accessKeyId: c.keyId, secretAccessKey: c.applicationKey },
      forcePathStyle: true,
    });
    clients.set(id, client);
  }
  return client;
}

/** True if every B2 env var needed for uploads is set. */
export function isB2Configured(): boolean {
  const { b2 } = getConfig();
  return Boolean(b2.keyId && b2.applicationKey && b2.bucket && b2.endpoint && b2.region);
}

/** Build the full storage key (with prefix) used when talking to B2. */
function prefixedKey(store: Store, unprefixedKey: string): string {
  // Defensive: strip any leading slash on the caller's side.
  return `${storeConfig(store).keyPrefix}${unprefixedKey.replace(/^\/+/, '')}`;
}

export interface PresignedUpload {
  /** Presigned PUT URL the browser uploads to directly. */
  url: string;
  /** The unprefixed key the server will store in the files table. */
  storageKey: string;
  /** Seconds the URL remains valid. */
  expiresIn: number;
}

/**
 * Generate a presigned PUT URL for a new file. The client is expected to
 * PUT its bytes directly to `url` with the same Content-Type used here.
 */
export async function presignPut(opts: {
  store: Store;
  storageKey: string;
  contentType: string;
  expiresInSec?: number;
}): Promise<PresignedUpload> {
  const expiresIn = opts.expiresInSec ?? 600;
  const url = await getSignedUrl(
    clientFor(opts.store),
    new PutObjectCommand({
      Bucket: storeConfig(opts.store).bucket,
      Key: prefixedKey(opts.store, opts.storageKey),
      ContentType: opts.contentType,
    }),
    { expiresIn },
  );

  return { url, storageKey: opts.storageKey, expiresIn };
}

/**
 * Upload bytes directly to B2 from the server (not via a presigned browser
 * PUT). Used by the bulk importer, which has the file bytes locally and
 * doesn't need the browser round-trip. `unprefixedKey` is relative to
 * B2_KEY_PREFIX, same as everywhere else in this module.
 */
export async function putObject(opts: {
  store: Store;
  unprefixedKey: string;
  body: Buffer | Uint8Array;
  contentType: string;
}): Promise<void> {
  await clientFor(opts.store).send(
    new PutObjectCommand({
      Bucket: storeConfig(opts.store).bucket,
      Key: prefixedKey(opts.store, opts.unprefixedKey),
      Body: opts.body,
      ContentType: opts.contentType,
    }),
  );
}

/** The HTTP status an S3 error carries, if it is one. */
function errorStatus(err: unknown): number | undefined {
  return (err as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode;
}

function isMissing(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  return name === 'NoSuchKey' || name === 'NotFound' || errorStatus(err) === 404;
}

/**
 * Stores to read a music object from, in order. While a private music bucket
 * is being brought in, an object that has not been copied across yet is still
 * read from the public bucket, so nothing goes missing mid-move. Once the
 * public copies are deleted the second read simply finds nothing.
 */
function readOrder(store: Store): Store[] {
  return store === 'music' && musicIsSeparate() ? ['music', 'public'] : [store];
}

async function readFirst<T>(store: Store, unprefixedKey: string, read: (s: Store) => Promise<T>): Promise<T> {
  const order = readOrder(store);
  for (let i = 0; i < order.length; i++) {
    try {
      const out = await read(order[i]!);
      if (i > 0) console.warn(`[b2] ${unprefixedKey} is not in the music bucket yet; read from the public bucket`);
      return out;
    } catch (err) {
      if (!isMissing(err) || i === order.length - 1) throw err;
    }
  }
  throw new Error('unreachable');
}

/** Download an object's bytes from the server side (e.g. to convert a score). */
export async function getObject(store: Store, unprefixedKey: string): Promise<Uint8Array> {
  return readFirst(store, unprefixedKey, async (s) => {
    const res = await clientFor(s).send(new GetObjectCommand({ Bucket: storeConfig(s).bucket, Key: prefixedKey(s, unprefixedKey) }));
    if (!res.Body) throw new Error(`empty body for ${unprefixedKey}`);
    return res.Body.transformToByteArray();
  });
}

export interface OpenedObject {
  /** 200 for the whole object, 206 for a byte range. */
  status: 200 | 206;
  /** The bytes; null when only the headers were asked for. */
  body: Readable | null;
  contentLength: number | null;
  contentRange: string | null;
  contentType: string | null;
  etag: string | null;
  lastModified: Date | null;
}

export type OpenResult =
  | { kind: 'ok'; object: OpenedObject }
  | { kind: 'missing' }
  /** The browser's copy is current (If-None-Match matched). */
  | { kind: 'not-modified' }
  /** The byte range asked for is outside the object. */
  | { kind: 'bad-range' };

/**
 * Open an object for streaming to a browser, passing its Range and
 * If-None-Match headers through to B2. Nothing is buffered here.
 */
export async function openObject(opts: {
  store: Store;
  unprefixedKey: string;
  range?: string;
  ifNoneMatch?: string;
  headOnly?: boolean;
}): Promise<OpenResult> {
  try {
    const object = await readFirst(opts.store, opts.unprefixedKey, async (s): Promise<OpenedObject> => {
      const target = { Bucket: storeConfig(s).bucket, Key: prefixedKey(s, opts.unprefixedKey) };
      if (opts.headOnly) {
        const res = await clientFor(s).send(new HeadObjectCommand({ ...target, IfNoneMatch: opts.ifNoneMatch }));
        return {
          status: 200,
          body: null,
          contentLength: res.ContentLength ?? null,
          contentRange: null,
          contentType: res.ContentType ?? null,
          etag: res.ETag ?? null,
          lastModified: res.LastModified ?? null,
        };
      }
      const res = await clientFor(s).send(new GetObjectCommand({ ...target, Range: opts.range, IfNoneMatch: opts.ifNoneMatch }));
      if (!res.Body) throw new Error(`empty body for ${opts.unprefixedKey}`);
      return {
        status: res.ContentRange ? 206 : 200,
        body: res.Body as Readable,
        contentLength: res.ContentLength ?? null,
        contentRange: res.ContentRange ?? null,
        contentType: res.ContentType ?? null,
        etag: res.ETag ?? null,
        lastModified: res.LastModified ?? null,
      };
    });
    return { kind: 'ok', object };
  } catch (err) {
    if (isMissing(err)) return { kind: 'missing' };
    if (errorStatus(err) === 304) return { kind: 'not-modified' };
    if (errorStatus(err) === 416) return { kind: 'bad-range' };
    throw err;
  }
}

export interface ListedObject {
  /** Key relative to the store's prefix. */
  key: string;
  size: number;
}

/** Every object under `unprefixedFolder` in one store (no fallback between stores). */
export async function listObjects(store: Store, unprefixedFolder: string): Promise<ListedObject[]> {
  const c = storeConfig(store);
  const out: ListedObject[] = [];
  let token: string | undefined;
  do {
    const res = await clientFor(store).send(
      new ListObjectsV2Command({ Bucket: c.bucket, Prefix: prefixedKey(store, unprefixedFolder), ContinuationToken: token }),
    );
    for (const o of res.Contents ?? []) {
      if (o.Key) out.push({ key: o.Key.slice(c.keyPrefix.length), size: o.Size ?? 0 });
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return out;
}

/** Copy one object from one store to the other, keeping its content type.
 *  Reads then writes, so the two stores may use different application keys. */
export async function copyBetweenStores(from: Store, to: Store, unprefixedKey: string): Promise<void> {
  const src = await clientFor(from).send(new GetObjectCommand({ Bucket: storeConfig(from).bucket, Key: prefixedKey(from, unprefixedKey) }));
  if (!src.Body) throw new Error(`empty body for ${unprefixedKey}`);
  const body = await src.Body.transformToByteArray();
  await clientFor(to).send(
    new PutObjectCommand({
      Bucket: storeConfig(to).bucket,
      Key: prefixedKey(to, unprefixedKey),
      Body: body,
      ContentType: src.ContentType,
    }),
  );
}

/**
 * Best-effort delete. Logs but does not throw if the object is missing —
 * the DB row is the source of truth and we don't want a bookkeeping issue
 * to block a delete from completing.
 */
export async function deleteObject(store: Store, unprefixedKey: string): Promise<void> {
  try {
    await clientFor(store).send(
      new DeleteObjectCommand({
        Bucket: storeConfig(store).bucket,
        Key: prefixedKey(store, unprefixedKey),
      }),
    );
  } catch (err) {
    // Swallow — the row will still be removed. Log so it's visible.
    console.error('[b2] delete failed for', unprefixedKey, '-', (err as Error).message);
  }
}

/**
 * Pictures the rest of SGMC keeps at the root of the shared bucket (the
 * website's photo library). They sit outside B2_KEY_PREFIX, so this module's
 * prefixing does not apply: keys here are the bucket's own, and their public
 * URL is simply publicBaseUrl + key.
 */
export interface SharedPicture {
  /** Bucket key of the original (no prefix). */
  key: string;
  /** Key of the smallest resized derivative, or the original if none. */
  thumbKey: string;
  /** Display name: the file name without the extension. */
  name: string;
  mimeType: string;
  sizeBytes: number | null;
  lastModified: number | null;
}

const PICTURE_EXT: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif',
};
/** The website stores resized copies as "<name>-400x300.jpg" beside the original. */
const DERIVATIVE = /^(.*)-(\d{2,4})x(\d{2,4})$/;

/** Public URL of a bucket-root object. */
export function sharedUrl(key: string): string {
  const { b2 } = getConfig();
  return `${b2.publicBaseUrl.replace(/\/+$/, '')}/${encodeURI(key)}`;
}

/** True if the key is a root-level picture (no folder, known image extension). */
export function isSharedPictureKey(key: string): boolean {
  return !key.includes('/') && Boolean(PICTURE_EXT[key.split('.').pop()!.toLowerCase()]);
}

export async function listSharedPictures(): Promise<SharedPicture[]> {
  const { b2 } = getConfig();
  const client = clientFor('public');
  interface Obj { key: string; size: number | null; modified: number | null }
  const objects: Obj[] = [];
  let token: string | undefined;
  do {
    const res = await client.send(new ListObjectsV2Command({ Bucket: b2.bucket, Delimiter: '/', ContinuationToken: token }));
    for (const o of res.Contents ?? []) {
      if (o.Key && isSharedPictureKey(o.Key)) objects.push({ key: o.Key, size: o.Size ?? null, modified: o.LastModified ? Math.floor(o.LastModified.getTime() / 1000) : null });
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);

  // Group the resized copies under their original by stem.
  const stem = (key: string) => key.replace(/\.[^.]+$/, '');
  const stems = new Set(objects.map((o) => stem(o.key)));
  const groups = new Map<string, { original: Obj | null; smallest: { obj: Obj; w: number } | null }>();
  for (const o of objects) {
    const st = stem(o.key);
    const m = DERIVATIVE.exec(st);
    const base = m && stems.has(m[1]!) ? m[1]! : st;
    const g = groups.get(base) ?? { original: null, smallest: null };
    if (base === st) g.original = o;
    else {
      const w = Number(m![2]);
      if (!g.smallest || w < g.smallest.w) g.smallest = { obj: o, w };
    }
    groups.set(base, g);
  }
  const out: SharedPicture[] = [];
  for (const [base, g] of groups) {
    const orig = g.original ?? g.smallest?.obj;
    if (!orig) continue;
    out.push({
      key: orig.key,
      thumbKey: g.smallest?.obj.key ?? orig.key,
      name: base,
      mimeType: PICTURE_EXT[orig.key.split('.').pop()!.toLowerCase()]!,
      sizeBytes: orig.size,
      lastModified: orig.modified,
    });
  }
  out.sort((a, b) => (b.lastModified ?? 0) - (a.lastModified ?? 0) || a.name.localeCompare(b.name));
  return out;
}
