/**
 * Cover pictures: a shared pool any set list can draw from. Admins upload
 * them (straight to B2 via a presigned PUT, like files); everyone who can
 * edit a set list can pick one.
 */

import { db } from './index.ts';
import { storageUrl } from './pieces.ts';
import { sharedUrl } from '../storage/b2.ts';

export type ImageStorage = 'b2' | 'local';

interface ImageRow {
  id: number;
  storage: ImageStorage;
  storage_key: string;
  filename: string;
  mime_type: string;
  size_bytes: number | null;
  created_by_user_id: number | null;
  created_at: number;
  shared: number;
}

export interface ImageDTO {
  id: number;
  url: string;
  filename: string;
  mimeType: string;
  sizeBytes: number | null;
  /** How many set lists currently wear this picture. */
  usedBy: number;
  createdAt: number;
  /** Bucket key when the picture is one of the website's, else null. */
  sharedKey: string | null;
}

type ImageWithUse = ImageRow & { used_by: number };

const SELECT = `
  SELECT im.*, (SELECT COUNT(*) FROM set_lists s WHERE s.image_id = im.id) AS used_by
  FROM images im
`;
const listStmt = db.prepare(`${SELECT} ORDER BY im.created_at DESC, im.id DESC`);
const getStmt = db.prepare(`${SELECT} WHERE im.id = ?`);
const existsStmt = db.prepare(`SELECT 1 FROM images WHERE id = ?`);
const insertStmt = db.prepare(
  `INSERT INTO images (storage, storage_key, filename, mime_type, size_bytes, created_by_user_id, shared) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
);
const clearUsesStmt = db.prepare(`UPDATE set_lists SET image_id = NULL WHERE image_id = ?`);
const deleteStmt = db.prepare(`DELETE FROM images WHERE id = ?`);
const bySharedKeyStmt = db.prepare(`${SELECT} WHERE im.shared = 1 AND im.storage_key = ?`);

function toDto(r: ImageWithUse): ImageDTO {
  return {
    id: r.id,
    url: r.shared ? sharedUrl(r.storage_key) : storageUrl(r.storage, r.storage_key),
    filename: r.filename,
    mimeType: r.mime_type,
    sizeBytes: r.size_bytes,
    usedBy: r.used_by,
    createdAt: r.created_at,
    sharedKey: r.shared ? r.storage_key : null,
  };
}

export function listImages(): ImageDTO[] {
  return (listStmt.all() as unknown as ImageWithUse[]).map(toDto);
}

export function getImage(id: number): ImageDTO | null {
  const row = getStmt.get(id) as ImageWithUse | undefined;
  return row ? toDto(row) : null;
}

export function imageExists(id: number): boolean {
  return existsStmt.get(id) !== undefined;
}

/** The raw storage location, for deleting the object. */
export function getImageStorage(id: number): { storage: ImageStorage; storageKey: string; shared: boolean } | null {
  const row = db.prepare(`SELECT storage, storage_key, shared FROM images WHERE id = ?`).get(id) as
    | { storage: ImageStorage; storage_key: string; shared: number }
    | undefined;
  return row ? { storage: row.storage, storageKey: row.storage_key, shared: Boolean(row.shared) } : null;
}

export function createImage(input: {
  storage: ImageStorage;
  storageKey: string;
  filename: string;
  mimeType: string;
  sizeBytes?: number | null;
  createdByUserId?: number | null;
  shared?: boolean;
}): ImageDTO {
  const { id } = insertStmt.get(
    input.storage,
    input.storageKey,
    input.filename,
    input.mimeType,
    input.sizeBytes ?? null,
    input.createdByUserId ?? null,
    input.shared ? 1 : 0,
  ) as { id: number };
  return getImage(id)!;
}

/** An already-adopted website picture, if any. */
export function getImageBySharedKey(key: string): ImageDTO | null {
  const row = bySharedKeyStmt.get(key) as ImageWithUse | undefined;
  return row ? toDto(row) : null;
}

/** Remove a picture; set lists wearing it go back to the plain cover. */
export function deleteImage(id: number): boolean {
  db.exec('BEGIN');
  try {
    clearUsesStmt.run(id);
    const changes = deleteStmt.run(id).changes as number;
    db.exec('COMMIT');
    return changes > 0;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
