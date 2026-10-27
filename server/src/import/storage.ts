/**
 * Where imported file bytes land. One switch:
 *   - B2 configured  → upload to Backblaze (storage='b2'), same bucket/key
 *     convention the rest of the app uses.
 *   - otherwise       → write into client/public/ (storage='local'), so a
 *     local dev box with no B2 creds can still run the whole importer end to
 *     end. resolveFileUrl() serves 'local' keys from client/public rooted at /.
 *
 * Unlike per-file uploads (which presign and go browser→B2 direct), the
 * importer hands bytes to the server, so the server does the store. That's a
 * deliberate trade for the batch flow — see routes/import.ts.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isB2Configured, putObject } from '../storage/b2.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// server/src/import -> repo root -> client/public
const CLIENT_PUBLIC_DIR = path.resolve(__dirname, '../../../client/public');

export interface StoredFile {
  storage: 'b2' | 'local';
  storageKey: string;
}

/** Lowercase, dot-prefixed, 1–5 alphanumerics; '' if the filename has no sane ext. */
function sanitiseExt(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  return /^\.[a-z0-9]{1,5}$/.test(ext) ? ext : '';
}

/** A readable, URL-safe version of the original filename (accents stripped,
 *  spaces/punctuation → '-'). Uniqueness comes from a short random subfolder,
 *  so the filename itself stays legible. */
export function readableStoredName(filename: string): string {
  const ext = sanitiseExt(filename);
  const base =
    path
      .basename(filename, path.extname(filename))
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .slice(0, 80) || 'file';
  return `${crypto.randomUUID().slice(0, 8)}/${base}${ext}`;
}

export function storageMode(): 'b2' | 'local' {
  return isB2Configured() ? 'b2' : 'local';
}

export async function storeImportedFile(opts: {
  pieceId: number;
  bytes: Buffer | Uint8Array;
  filename: string;
  contentType: string;
}): Promise<StoredFile> {
  const name = readableStoredName(opts.filename);

  if (isB2Configured()) {
    const key = `pieces/${opts.pieceId}/files/${name}`;
    await putObject({ unprefixedKey: key, body: opts.bytes, contentType: opts.contentType });
    return { storage: 'b2', storageKey: key };
  }

  // Local emulation: copy into client/public/imported/<pieceId>/<short>/<name>.
  const key = `imported/${opts.pieceId}/${name}`;
  const dest = path.join(CLIENT_PUBLIC_DIR, key);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.writeFile(dest, opts.bytes);
  return { storage: 'local', storageKey: key };
}

/** Read a locally-stored file's bytes (key as stored in the files table). */
export async function readLocalFile(storageKey: string): Promise<Buffer> {
  const full = path.resolve(CLIENT_PUBLIC_DIR, storageKey.replace(/^\/+/, ''));
  if (!full.startsWith(CLIENT_PUBLIC_DIR + path.sep)) throw new Error('local key outside client/public');
  return fsp.readFile(full);
}

/** Best-effort removal of a locally-stored (importer) file from client/public.
 *  Only touches keys under `imported/` so it can never delete a repo asset. */
export async function deleteLocalFile(storageKey: string): Promise<void> {
  if (!storageKey.startsWith('imported/')) return;
  try {
    await fsp.rm(path.join(CLIENT_PUBLIC_DIR, storageKey), { force: true });
  } catch (err) {
    console.error('[import] local delete failed for', storageKey, '-', (err as Error).message);
  }
}
