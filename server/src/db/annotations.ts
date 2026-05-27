/**
 * Annotation queries. The wire format pulls kind-specific fields up to the
 * top of the DTO (color, width, points for ink), but on disk those live
 * inside the `payload` JSON so adding new kinds doesn't require schema
 * changes.
 *
 * Visibility rule for reads:
 *   - shared annotations: anyone in the choir sees them
 *   - private annotations: only the owner
 *
 * Edit rule for shared:
 *   - per matt's decision, anyone can delete/edit a shared annotation.
 *     Authorship is recorded for attribution but doesn't gate writes.
 */

import { db } from './index.ts';

export type AnnotationLayer = 'private' | 'shared';

export interface InkAnnotationDTO {
  id: string;
  pieceId: number;
  fileId: number;
  layer: AnnotationLayer;
  page: number;
  kind: 'ink';
  color: string;
  width: number;
  points: Array<{ x: number; y: number }>;
  /** Email of the creator/last-editor. Useful in the shared layer. */
  authorEmail: string;
  /** Whether the current request user owns this annotation. */
  isMine: boolean;
  createdAt: number;
  updatedAt: number;
}

export type AnnotationDTO = InkAnnotationDTO;

interface AnnotationRow {
  id: string;
  piece_id: number;
  file_id: number;
  user_id: number;
  layer: AnnotationLayer;
  page: number;
  kind: string;
  payload: string;
  created_at: number;
  updated_at: number;
  author_email: string;
}

function rowToDTO(row: AnnotationRow, requesterId: number): AnnotationDTO {
  // For now there's only ink. Future kinds branch here.
  if (row.kind !== 'ink') {
    throw new Error(`Unknown annotation kind: ${row.kind}`);
  }
  const payload = JSON.parse(row.payload) as {
    color: string;
    width: number;
    points: Array<{ x: number; y: number }>;
  };
  return {
    id: row.id,
    pieceId: row.piece_id,
    fileId: row.file_id,
    layer: row.layer,
    page: row.page,
    kind: 'ink',
    color: payload.color,
    width: payload.width,
    points: payload.points,
    authorEmail: row.author_email,
    isMine: row.user_id === requesterId,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const listForPieceStmt = db.prepare(`
  SELECT a.*, u.email AS author_email
  FROM annotations a
  JOIN users u ON u.id = a.user_id
  WHERE a.piece_id = ?
    AND (a.layer = 'shared' OR (a.layer = 'private' AND a.user_id = ?))
  ORDER BY a.created_at, a.id
`);

const insertStmt = db.prepare(`
  INSERT INTO annotations (id, piece_id, file_id, user_id, layer, page, kind, payload)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const getByIdStmt = db.prepare(`
  SELECT a.*, u.email AS author_email
  FROM annotations a
  JOIN users u ON u.id = a.user_id
  WHERE a.id = ?
`);

const deleteStmt = db.prepare(`DELETE FROM annotations WHERE id = ?`);

export function listAnnotationsForPiece(pieceId: number, requesterId: number): AnnotationDTO[] {
  return (listForPieceStmt.all(pieceId, requesterId) as AnnotationRow[]).map((r) => rowToDTO(r, requesterId));
}

export interface CreateAnnotationInput {
  id: string;
  pieceId: number;
  fileId: number;
  userId: number;
  layer: AnnotationLayer;
  page: number;
  kind: 'ink';
  color: string;
  width: number;
  points: Array<{ x: number; y: number }>;
}

export function createAnnotation(input: CreateAnnotationInput): AnnotationDTO {
  const payload = JSON.stringify({
    color: input.color,
    width: input.width,
    points: input.points,
  });
  insertStmt.run(
    input.id,
    input.pieceId,
    input.fileId,
    input.userId,
    input.layer,
    input.page,
    input.kind,
    payload,
  );
  const row = getByIdStmt.get(input.id) as AnnotationRow;
  return rowToDTO(row, input.userId);
}

export function getAnnotationById(id: string, requesterId: number): AnnotationDTO | null {
  const row = getByIdStmt.get(id) as AnnotationRow | undefined;
  if (!row) return null;
  return rowToDTO(row, requesterId);
}

/**
 * Returns true if the annotation was deleted, false if it didn't exist.
 * Caller is responsible for permission checks (see route).
 */
export function deleteAnnotation(id: string): boolean {
  const info = deleteStmt.run(id);
  return info.changes > 0;
}
