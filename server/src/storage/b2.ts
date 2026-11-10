/**
 * Backblaze B2 storage adapter — speaks the S3-compatible API so we can use
 * the AWS SDK's presigning machinery without rewriting sigv4 by hand.
 *
 * All keys are *unprefixed* in this module's public API. Callers pass
 * "pieces/123/files/abc.pdf"; we prepend the configured B2_KEY_PREFIX
 * (e.g. "music/") before talking to B2. This keeps choirfriend confined to
 * its own folder when the bucket is shared with other SGMC services.
 *
 * Path-style addressing is required (Backblaze recommends it; some buckets
 * reject virtual-hosted-style).
 */

import { DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { Buffer } from 'node:buffer';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getConfig } from '../config.ts';

let cachedClient: S3Client | null = null;

function makeClient(): S3Client {
  if (cachedClient) return cachedClient;
  const { b2 } = getConfig();
  if (!isB2Configured()) {
    throw new Error('B2 not configured — set B2_KEY_ID, B2_APPLICATION_KEY, B2_BUCKET, B2_ENDPOINT, B2_REGION');
  }
  cachedClient = new S3Client({
    endpoint: b2.endpoint,
    region: b2.region,
    credentials: {
      accessKeyId: b2.keyId,
      secretAccessKey: b2.applicationKey,
    },
    forcePathStyle: true,
  });
  return cachedClient;
}

/** True if every B2 env var needed for uploads is set. */
export function isB2Configured(): boolean {
  const { b2 } = getConfig();
  return Boolean(b2.keyId && b2.applicationKey && b2.bucket && b2.endpoint && b2.region);
}

/** Build the full storage key (with prefix) used when talking to B2. */
function prefixedKey(unprefixedKey: string): string {
  const { b2 } = getConfig();
  // Defensive: strip any leading slash on the caller's side.
  return `${b2.keyPrefix}${unprefixedKey.replace(/^\/+/, '')}`;
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
  storageKey: string;
  contentType: string;
  expiresInSec?: number;
}): Promise<PresignedUpload> {
  const expiresIn = opts.expiresInSec ?? 600;
  const { b2 } = getConfig();
  const client = makeClient();

  const url = await getSignedUrl(
    client,
    new PutObjectCommand({
      Bucket: b2.bucket,
      Key: prefixedKey(opts.storageKey),
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
  unprefixedKey: string;
  body: Buffer | Uint8Array;
  contentType: string;
}): Promise<void> {
  const { b2 } = getConfig();
  const client = makeClient();
  await client.send(
    new PutObjectCommand({
      Bucket: b2.bucket,
      Key: prefixedKey(opts.unprefixedKey),
      Body: opts.body,
      ContentType: opts.contentType,
    }),
  );
}

/** Download an object's bytes from the server side (e.g. to convert a score). */
export async function getObject(unprefixedKey: string): Promise<Uint8Array> {
  const { b2 } = getConfig();
  const client = makeClient();
  const res = await client.send(new GetObjectCommand({ Bucket: b2.bucket, Key: prefixedKey(unprefixedKey) }));
  if (!res.Body) throw new Error(`empty body for ${unprefixedKey}`);
  return res.Body.transformToByteArray();
}

/**
 * Best-effort delete. Logs but does not throw if the object is missing —
 * the DB row is the source of truth and we don't want a bookkeeping issue
 * to block a delete from completing.
 */
export async function deleteObject(unprefixedKey: string): Promise<void> {
  const { b2 } = getConfig();
  const client = makeClient();
  try {
    await client.send(
      new DeleteObjectCommand({
        Bucket: b2.bucket,
        Key: prefixedKey(unprefixedKey),
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
  const client = makeClient();
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
