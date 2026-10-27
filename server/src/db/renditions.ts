/**
 * Flowing-score renditions: the cleaned MusicXML made from each editable
 * score. See scores/render.ts for the conversion itself.
 */

import { db } from './index.ts';
import { resolveFileUrl, type FileRow } from './pieces.ts';

export type RenditionStatus = 'pending' | 'ready' | 'failed';

export interface RenditionRow {
  file_id: number;
  status: RenditionStatus;
  source_key: string;
  storage: 'b2' | 'local' | null;
  storage_key: string | null;
  size_bytes: number | null;
  error: string | null;
  updated_at: number;
}

/** What the client gets for each score: members only see ready ones. */
export interface FlowingScoreDTO {
  /** The editable score this was made from. */
  fileId: number;
  title: string;
  status: RenditionStatus;
  /** MusicXML to engrave; null until ready. */
  url: string | null;
  error: string | null;
}

const getStmt = db.prepare(`SELECT * FROM score_renditions WHERE file_id = ?`);
const forPieceStmt = db.prepare(`
  SELECT r.*, f.label AS file_label, f.filename AS file_filename
  FROM score_renditions r JOIN files f ON f.id = r.file_id
  WHERE f.piece_id = ? AND f.kind = 'score'
  ORDER BY f.sort_order, f.id
`);
const upsertPendingStmt = db.prepare(`
  INSERT INTO score_renditions (file_id, status, source_key) VALUES (?, 'pending', ?)
  ON CONFLICT (file_id) DO UPDATE SET status = 'pending', source_key = excluded.source_key, error = NULL, updated_at = unixepoch()
`);
const readyStmt = db.prepare(`
  UPDATE score_renditions SET status = 'ready', storage = ?, storage_key = ?, size_bytes = ?, error = NULL, updated_at = unixepoch()
  WHERE file_id = ?
`);
const failedStmt = db.prepare(`
  UPDATE score_renditions SET status = 'failed', error = ?, updated_at = unixepoch() WHERE file_id = ?
`);
/** Score files with no rendition, an unfinished one, a failed one, or one
 *  made from bytes that have since been replaced. */
const staleStmt = db.prepare(`
  SELECT f.id FROM files f LEFT JOIN score_renditions r ON r.file_id = f.id
  WHERE f.kind = 'score' AND (r.file_id IS NULL OR r.status != 'ready' OR r.source_key != f.storage_key)
  ORDER BY f.id
`);

export function getRendition(fileId: number): RenditionRow | null {
  return (getStmt.get(fileId) as RenditionRow | undefined) ?? null;
}

export function markRenditionPending(fileId: number, sourceKey: string): void {
  upsertPendingStmt.run(fileId, sourceKey);
}

export function markRenditionReady(fileId: number, storage: 'b2' | 'local', storageKey: string, sizeBytes: number): void {
  readyStmt.run(storage, storageKey, sizeBytes, fileId);
}

export function markRenditionFailed(fileId: number, error: string): void {
  failedStmt.run(error, fileId);
}

export function staleRenditionFileIds(): number[] {
  return (staleStmt.all() as Array<{ id: number }>).map((r) => r.id);
}

/** A score's display title: its label, else the filename without extension. */
function scoreTitle(label: string | null, filename: string): string {
  return label?.trim() || filename.replace(/\.(mscz|mscx|musicxml|mxl|xml)$/i, '');
}

/** Flowing scores for a piece. `includeUnready` is for people who can manage
 *  scores, so they see conversions in progress and why one failed. */
export function listFlowingScores(pieceId: number, includeUnready: boolean): FlowingScoreDTO[] {
  const rows = forPieceStmt.all(pieceId) as Array<RenditionRow & { file_label: string | null; file_filename: string }>;
  return rows
    .filter((r) => includeUnready || r.status === 'ready')
    .map((r) => ({
      fileId: r.file_id,
      title: scoreTitle(r.file_label, r.file_filename),
      status: r.status,
      url:
        r.status === 'ready' && r.storage && r.storage_key
          ? resolveFileUrl({ storage: r.storage, storage_key: r.storage_key } as FileRow)
          : null,
      error: r.error,
    }));
}
