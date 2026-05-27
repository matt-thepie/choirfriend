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
  created_at: number;
  updated_at: number;
}

export interface FileRow {
  id: number;
  piece_id: number;
  kind: 'pdf' | 'audio';
  label: string | null;
  storage: 'b2' | 'local';
  storage_key: string;
  filename: string;
  size_bytes: number | null;
  mime_type: string | null;
  sort_order: number;
  created_at: number;
}


export interface PieceDTO {
  id: number;
  title: string;
  composer: string | null;
  arranger: string | null;
  notes: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface FileDTO {
  id: number;
  pieceId: number;
  kind: 'pdf' | 'audio';
  label: string | null;
  filename: string;
  sizeBytes: number | null;
  mimeType: string | null;
  sortOrder: number;
  /** Browser-resolvable URL. Local files served by the client dev server;
   *  B2 files served via the public CDN domain. */
  url: string;
  createdAt: number;
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

function toFileDTO(row: FileRow): FileDTO {
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
  };
}

const listPiecesStmt = db.prepare(`
  SELECT * FROM pieces ORDER BY updated_at DESC, id DESC
`);
const getPieceStmt = db.prepare(`SELECT * FROM pieces WHERE id = ?`);
const listFilesForPieceStmt = db.prepare(`
  SELECT * FROM files WHERE piece_id = ? ORDER BY kind, sort_order, id
`);
const insertPieceStmt = db.prepare(`
  INSERT INTO pieces (title, composer, arranger, notes)
  VALUES (?, ?, ?, ?)
  RETURNING *
`);
const insertFileStmt = db.prepare(`
  INSERT INTO files (piece_id, kind, label, storage, storage_key, filename, size_bytes, mime_type, sort_order)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  RETURNING *
`);
const countPiecesStmt = db.prepare(`SELECT COUNT(*) AS n FROM pieces`);
const getFileByIdStmt = db.prepare(`SELECT * FROM files WHERE id = ?`);
const deleteFileStmt = db.prepare(`DELETE FROM files WHERE id = ?`);
const touchPieceStmt = db.prepare(`UPDATE pieces SET updated_at = unixepoch() WHERE id = ?`);

export function listPieces(): PieceDTO[] {
  return (listPiecesStmt.all() as PieceRow[]).map(toPieceDTO);
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

export interface CreateFileInput {
  pieceId: number;
  kind: 'pdf' | 'audio';
  label?: string | null;
  storage: 'b2' | 'local';
  storageKey: string;
  filename: string;
  sizeBytes?: number | null;
  mimeType?: string | null;
  sortOrder?: number;
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
