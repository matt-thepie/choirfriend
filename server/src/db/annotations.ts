/**
 * Annotation queries. The wire format pulls kind-specific fields up to the
 * top of the DTO, but on disk those live inside the `payload` JSON column
 * so adding new kinds doesn't require schema changes.
 *
 * Two kinds today: `ink` (drawn strokes) and `marker` (navigation marks
 * like Segno, Coda, D.S. al Coda, etc.). The traversal logic that turns a
 * placed marker set into "the bar order to actually play" lives on the
 * client and isn't a server concern.
 *
 * Visibility rule for reads:
 *   - shared annotations: anyone in the choir sees them
 *   - private annotations: only the owner
 *
 * Edit rule:
 *   - private layer: only the owner can edit/delete
 *   - shared layer: anyone authenticated (per matt's call)
 */

import { db } from './index.ts';

export type AnnotationLayer = 'private' | 'shared';

export type MarkerKind =
  | 'segno' // 𝄋
  | 'coda' // 𝄌
  | 'ds' // D.S. — qualifier in `label` (e.g. "al Coda")
  | 'dc' // D.C. — qualifier in `label` (e.g. "al Fine")
  | 'fine'
  | 'to-coda' // → 𝄌
  | 'repeat-start' // 𝄆
  | 'repeat-end' // 𝄇
  | 'volta-1'
  | 'volta-2'
  | 'bar' // bar number / rehearsal letter ("bar 24", "Letter B")
  | 'custom';

interface AnnotationCommon {
  id: string;
  pieceId: number;
  fileId: number;
  layer: AnnotationLayer;
  page: number;
  /** Email of the creator. Useful in the shared layer for attribution. */
  authorEmail: string;
  /** Whether the requesting user owns this annotation. Server-computed. */
  isMine: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface InkAnnotationDTO extends AnnotationCommon {
  kind: 'ink';
  color: string;
  width: number;
  points: Array<{ x: number; y: number }>;
}

export interface MarkerAnnotationDTO extends AnnotationCommon {
  kind: 'marker';
  markerKind: MarkerKind;
  /** Override / qualifier text. Required for `custom` and `bar`; optional
   *  for D.S./D.C. to carry "al Coda" / "al Fine". */
  label: string | null;
  position: { x: number; y: number };
}

export type AnnotationDTO = InkAnnotationDTO | MarkerAnnotationDTO;

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
  const payload = JSON.parse(row.payload) as Record<string, unknown>;
  const common: AnnotationCommon = {
    id: row.id,
    pieceId: row.piece_id,
    fileId: row.file_id,
    layer: row.layer,
    page: row.page,
    authorEmail: row.author_email,
    isMine: row.user_id === requesterId,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.kind === 'ink') {
    return {
      ...common,
      kind: 'ink',
      color: payload.color as string,
      width: payload.width as number,
      points: payload.points as Array<{ x: number; y: number }>,
    };
  }
  if (row.kind === 'marker') {
    return {
      ...common,
      kind: 'marker',
      markerKind: payload.markerKind as MarkerKind,
      label: (payload.label as string | null | undefined) ?? null,
      position: payload.position as { x: number; y: number },
    };
  }
  throw new Error(`Unknown annotation kind: ${row.kind}`);
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

interface CreateCommon {
  id: string;
  pieceId: number;
  fileId: number;
  userId: number;
  layer: AnnotationLayer;
  page: number;
}

export type CreateAnnotationInput =
  | (CreateCommon & {
      kind: 'ink';
      color: string;
      width: number;
      points: Array<{ x: number; y: number }>;
    })
  | (CreateCommon & {
      kind: 'marker';
      markerKind: MarkerKind;
      label: string | null;
      position: { x: number; y: number };
    });

export function createAnnotation(input: CreateAnnotationInput): AnnotationDTO {
  const payload =
    input.kind === 'ink'
      ? JSON.stringify({ color: input.color, width: input.width, points: input.points })
      : JSON.stringify({ markerKind: input.markerKind, label: input.label, position: input.position });

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

export function deleteAnnotation(id: string): boolean {
  const info = deleteStmt.run(id);
  return (info.changes as number) > 0;
}
