/**
 * Piece + file queries. The API serialises rows into JSON-friendly DTOs
 * (camelCase, computed `url`). Storage path resolution happens here so
 * routes don't need to know whether a file is on B2 or local.
 */

import { db } from './index.ts';
import { getConfig } from '../config.ts';

export interface PieceRow {
  id: number;
  title: string;
  composer: string | null;
  arranger: string | null;
  notes: string | null;
  is_current: number; // 0 | 1 — SQLite stores booleans as integers
  created_at: number;
  updated_at: number;
}

/** See the files table comment in db/index.ts. */
export type FileKind = 'pdf' | 'audio' | 'lyrics' | 'score';
export const FILE_KINDS: readonly FileKind[] = ['pdf', 'audio', 'lyrics', 'score'];
export function isFileKind(v: unknown): v is FileKind {
  return typeof v === 'string' && (FILE_KINDS as readonly string[]).includes(v);
}

export interface FileRow {
  id: number;
  piece_id: number;
  kind: FileKind;
  label: string | null;
  storage: 'b2' | 'local';
  storage_key: string;
  filename: string;
  size_bytes: number | null;
  mime_type: string | null;
  sort_order: number;
  created_at: number;
  created_by_user_id: number | null;
  section_id: number | null;
  duration_ms: number | null;
}

/** A FileRow joined to the uploader's display name. The list/get queries
 *  LEFT JOIN users so the DTO can show "uploaded by X" without a second
 *  round-trip. created_by_name is null for files with no recorded creator. */
interface FileRowWithCreator extends FileRow {
  created_by_name: string | null;
}


export interface PieceDTO {
  id: number;
  title: string;
  composer: string | null;
  arranger: string | null;
  notes: string | null;
  isCurrent: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface FileDTO {
  id: number;
  pieceId: number;
  kind: FileKind;
  label: string | null;
  filename: string;
  sizeBytes: number | null;
  mimeType: string | null;
  sortOrder: number;
  /** Browser-resolvable URL. Local files served by the client dev server;
   *  B2 files served via the public CDN domain. */
  url: string;
  createdAt: number;
  /** Internal id of the uploader, or null for seeded/legacy files. */
  createdByUserId: number | null;
  /** Uploader's display name, joined from users. Null if unknown. */
  createdByName: string | null;
  /** Voice part this track is for (audio only). Null = not part-specific. */
  sectionId: number | null;
  /** Track length in milliseconds (audio only). Null = unknown. */
  durationMs: number | null;
}

export interface PieceWithFiles extends PieceDTO {
  files: FileDTO[];
}

function toPieceDTO(row: PieceRow): PieceDTO {
  return {
    id: row.id,
    title: row.title,
    composer: row.composer,
    arranger: row.arranger,
    notes: row.notes,
    isCurrent: row.is_current === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function resolveFileUrl(row: FileRow): string {
  if (row.storage === 'local') {
    // Served by the client (Vite dev server in dev, the static-served
    // bundle in prod). Always rooted at /.
    return row.storage_key.startsWith('/') ? row.storage_key : `/${row.storage_key}`;
  }
  // B2: public URL behind the CDN domain, including the choirfriend prefix.
  const { b2 } = getConfig();
  const base = b2.publicBaseUrl.replace(/\/+$/, '');
  return `${base}/${b2.keyPrefix}${row.storage_key}`;
}

function toFileDTO(row: FileRow | FileRowWithCreator): FileDTO {
  return {
    id: row.id,
    pieceId: row.piece_id,
    kind: row.kind,
    label: row.label,
    filename: row.filename,
    sizeBytes: row.size_bytes,
    mimeType: row.mime_type,
    sortOrder: row.sort_order,
    url: resolveFileUrl(row),
    createdAt: row.created_at,
    createdByUserId: row.created_by_user_id,
    createdByName: 'created_by_name' in row ? row.created_by_name : null,
    sectionId: row.section_id ?? null,
    durationMs: row.duration_ms ?? null,
  };
}

const listPiecesStmt = db.prepare(`
  SELECT p.*,
    (SELECT COUNT(*) FROM files f WHERE f.piece_id = p.id AND f.kind = 'pdf') AS pdf_count,
    (SELECT COUNT(*) FROM files f WHERE f.piece_id = p.id AND f.kind = 'audio') AS audio_count
  FROM pieces p ORDER BY p.title COLLATE NOCASE, p.id
`);
const getPieceStmt = db.prepare(`SELECT * FROM pieces WHERE id = ?`);
const listFilesForPieceStmt = db.prepare(`
  SELECT f.*, u.display_name AS created_by_name
  FROM files f
  LEFT JOIN users u ON u.id = f.created_by_user_id
  WHERE f.piece_id = ?
  ORDER BY f.kind, f.sort_order, f.id
`);
const insertPieceStmt = db.prepare(`
  INSERT INTO pieces (title, composer, arranger, notes)
  VALUES (?, ?, ?, ?)
  RETURNING *
`);
const insertFileStmt = db.prepare(`
  INSERT INTO files (piece_id, kind, label, storage, storage_key, filename, size_bytes, mime_type, sort_order, created_by_user_id, section_id, duration_ms)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  RETURNING *
`);
const countPiecesStmt = db.prepare(`SELECT COUNT(*) AS n FROM pieces`);
const getFileByIdStmt = db.prepare(`SELECT * FROM files WHERE id = ?`);
const deleteFileStmt = db.prepare(`DELETE FROM files WHERE id = ?`);
const touchPieceStmt = db.prepare(`UPDATE pieces SET updated_at = unixepoch() WHERE id = ?`);

export interface PieceSummaryDTO extends PieceDTO {
  pdfCount: number;
  audioCount: number;
}

export function listPieces(): PieceSummaryDTO[] {
  return (listPiecesStmt.all() as Array<PieceRow & { pdf_count: number; audio_count: number }>).map((r) => ({
    ...toPieceDTO(r),
    pdfCount: r.pdf_count,
    audioCount: r.audio_count,
  }));
}

export function getPieceWithFiles(id: number): PieceWithFiles | null {
  const piece = getPieceStmt.get(id) as PieceRow | undefined;
  if (!piece) return null;
  const files = (listFilesForPieceStmt.all(piece.id) as FileRow[]).map(toFileDTO);
  return { ...toPieceDTO(piece), files };
}

export function pieceCount(): number {
  return (countPiecesStmt.get() as { n: number }).n;
}

export interface CreatePieceInput {
  title: string;
  composer?: string | null;
  arranger?: string | null;
  notes?: string | null;
}

export function createPiece(input: CreatePieceInput): PieceDTO {
  const row = insertPieceStmt.get(
    input.title,
    input.composer ?? null,
    input.arranger ?? null,
    input.notes ?? null,
  ) as PieceRow;
  return toPieceDTO(row);
}

export interface UpdatePieceInput {
  title?: string;
  composer?: string | null;
  arranger?: string | null;
  notes?: string | null;
  isCurrent?: boolean;
}

/**
 * Patch a piece. Only the provided fields are updated; everything else is
 * left alone. Always bumps updated_at. Returns null if the id doesn't exist.
 */
export function updatePiece(id: number, input: UpdatePieceInput): PieceDTO | null {
  const sets: string[] = [];
  const params: Array<string | number | null> = [];

  if (input.title !== undefined) {
    sets.push('title = ?');
    params.push(input.title);
  }
  if (input.composer !== undefined) {
    sets.push('composer = ?');
    params.push(input.composer);
  }
  if (input.arranger !== undefined) {
    sets.push('arranger = ?');
    params.push(input.arranger);
  }
  if (input.notes !== undefined) {
    sets.push('notes = ?');
    params.push(input.notes);
  }
  if (input.isCurrent !== undefined) {
    sets.push('is_current = ?');
    params.push(input.isCurrent ? 1 : 0);
  }

  if (sets.length === 0) {
    // Nothing to change — just return the current row.
    return (getPieceStmt.get(id) as PieceRow | undefined) ? toPieceDTO(getPieceStmt.get(id) as PieceRow) : null;
  }

  sets.push('updated_at = unixepoch()');
  const sql = `UPDATE pieces SET ${sets.join(', ')} WHERE id = ? RETURNING *`;
  params.push(id);

  const row = db.prepare(sql).get(...params) as PieceRow | undefined;
  return row ? toPieceDTO(row) : null;
}

export interface CreateFileInput {
  pieceId: number;
  kind: FileKind;
  label?: string | null;
  storage: 'b2' | 'local';
  storageKey: string;
  filename: string;
  sizeBytes?: number | null;
  mimeType?: string | null;
  sortOrder?: number;
  /** Internal id of the uploader (req.user.internalId). Null for system inserts. */
  createdByUserId?: number | null;
  /** Voice part (audio only). */
  sectionId?: number | null;
  durationMs?: number | null;
}

export function createFile(input: CreateFileInput): FileDTO {
  const row = insertFileStmt.get(
    input.pieceId,
    input.kind,
    input.label ?? null,
    input.storage,
    input.storageKey,
    input.filename,
    input.sizeBytes ?? null,
    input.mimeType ?? null,
    input.sortOrder ?? 0,
    input.createdByUserId ?? null,
    input.sectionId ?? null,
    input.durationMs ?? null,
  ) as FileRow;
  touchPieceStmt.run(input.pieceId);
  return toFileDTO(row);
}

/** Returns the raw row (with storage info) — callers that need to talk to
 *  B2 about the file need the unprefixed key, which isn't in the DTO. */
export function getFileRowById(id: number): FileRow | null {
  return (getFileByIdStmt.get(id) as FileRow | undefined) ?? null;
}

export function deleteFileRow(id: number): boolean {
  const info = deleteFileStmt.run(id);
  return (info.changes as number) > 0;
}

export interface UpdateFileInput {
  label?: string | null;
  sectionId?: number | null;
  /** Re-file a document: only pdf ↔ lyrics is meaningful (both are documents;
   *  annotations stay valid). Routes enforce that; this just writes it. */
  kind?: FileKind;
  durationMs?: number | null;
}

/** Patch a file's label, section, kind and/or duration. Only provided keys change. */
export function updateFile(id: number, input: UpdateFileInput): FileDTO | null {
  const sets: string[] = [];
  const params: Array<string | number | null> = [];
  if (input.label !== undefined) {
    sets.push('label = ?');
    params.push(input.label);
  }
  if (input.kind !== undefined) {
    sets.push('kind = ?');
    params.push(input.kind);
  }
  if (input.durationMs !== undefined) {
    sets.push('duration_ms = ?');
    params.push(input.durationMs);
  }
  if (input.sectionId !== undefined) {
    sets.push('section_id = ?');
    params.push(input.sectionId);
  }
  if (sets.length === 0) {
    const row = getFileByIdStmt.get(id) as FileRow | undefined;
    return row ? toFileDTO(row) : null;
  }
  params.push(id);
  const row = db.prepare(`UPDATE files SET ${sets.join(', ')} WHERE id = ? RETURNING *`).get(...params) as
    | FileRow
    | undefined;
  return row ? toFileDTO(row) : null;
}

/** Back-compat alias. */
export function updateFileLabel(id: number, label: string | null): FileDTO | null {
  return updateFile(id, { label });
}

const replaceFileStorageStmt = db.prepare(`
  UPDATE files
  SET storage = ?, storage_key = ?, filename = ?, size_bytes = ?, mime_type = ?, created_by_user_id = ?
  WHERE id = ?
  RETURNING *
`);

export interface ReplaceFileStorageInput {
  storage: 'b2' | 'local';
  storageKey: string;
  filename: string;
  sizeBytes?: number | null;
  mimeType?: string | null;
  /** The user performing the replacement — becomes the file's recorded owner,
   *  since they're responsible for the current bytes. */
  createdByUserId?: number | null;
}

/**
 * Swap a file's stored bytes in place — same row id, same kind, same label and
 * sort order. Used when an admin uploads a corrected version of a score/track.
 * Keeping the id means existing annotations (which reference fileId) stay
 * attached. Bumps the parent piece's updated_at. Returns null if id is unknown.
 */
export function replaceFileStorage(id: number, input: ReplaceFileStorageInput): FileDTO | null {
  const row = replaceFileStorageStmt.get(
    input.storage,
    input.storageKey,
    input.filename,
    input.sizeBytes ?? null,
    input.mimeType ?? null,
    input.createdByUserId ?? null,
    id,
  ) as FileRow | undefined;
  if (!row) return null;
  touchPieceStmt.run(row.piece_id);
  return toFileDTO(row);
}
