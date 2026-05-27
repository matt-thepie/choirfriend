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

import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
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
