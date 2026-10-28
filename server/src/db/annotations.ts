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
  /** Shared layer only: the voice parts it's for. Null = everyone. */
  sectionIds: number[] | null;
  createdAt: number;
  updatedAt: number;
}

/** `highlighter` strokes are wide and drawn so notes show through them. */
export type InkPen = 'pen' | 'highlighter';

export interface InkAnnotationDTO extends AnnotationCommon {
  kind: 'ink';
  pen: InkPen;
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
  section_ids: string | null;
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
    sectionIds: row.section_ids ? (JSON.parse(row.section_ids) as number[]) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.kind === 'ink') {
    return {
      ...common,
      kind: 'ink',
      pen: payload.pen === 'highlighter' ? 'highlighter' : 'pen',
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
    AND a.deleted_at IS NULL
    AND (a.user_id = ? OR (a.layer = 'shared' AND (
      a.section_ids IS NULL
      OR EXISTS (SELECT 1 FROM json_each(a.section_ids) WHERE value = (SELECT section_id FROM users WHERE id = ?))
    )))
  ORDER BY a.created_at, a.id
`);

const insertStmt = db.prepare(`
  INSERT INTO annotations (id, piece_id, file_id, user_id, layer, page, kind, payload, section_ids)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const getByIdStmt = db.prepare(`
  SELECT a.*, u.email AS author_email
  FROM annotations a
  JOIN users u ON u.id = a.user_id
  WHERE a.id = ? AND a.deleted_at IS NULL
`);

const deleteStmt = db.prepare(`
  UPDATE annotations SET deleted_at = unixepoch(), deleted_by_user_id = ?
  WHERE id = ? AND deleted_at IS NULL
`);
const restoreStmt = db.prepare(`
  UPDATE annotations SET deleted_at = NULL, deleted_by_user_id = NULL
  WHERE id = ? AND deleted_by_user_id = ? AND deleted_at IS NOT NULL
`);
const purgeStmt = db.prepare(`DELETE FROM annotations WHERE deleted_at < unixepoch() - 86400`);

export function listAnnotationsForPiece(pieceId: number, requesterId: number): AnnotationDTO[] {
  return (listForPieceStmt.all(pieceId, requesterId, requesterId) as AnnotationRow[]).map((r) => rowToDTO(r, requesterId));
}

interface CreateCommon {
  id: string;
  pieceId: number;
  fileId: number;
  userId: number;
  layer: AnnotationLayer;
  page: number;
  /** Shared layer only; null or empty = everyone. */
  sectionIds: number[] | null;
}

export type CreateAnnotationInput =
  | (CreateCommon & {
      kind: 'ink';
      pen: InkPen;
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
      ? JSON.stringify({ pen: input.pen, color: input.color, width: input.width, points: input.points })
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
    input.layer === 'shared' && input.sectionIds?.length ? JSON.stringify(input.sectionIds) : null,
  );
  const row = getByIdStmt.get(input.id) as AnnotationRow;
  return rowToDTO(row, input.userId);
}

/** Whether a member in `sectionId` can see this annotation (see the list query). */
export function canSeeAnnotation(a: AnnotationDTO, sectionId: number | null): boolean {
  if (a.isMine) return true;
  if (a.layer === 'private') return false;
  return a.sectionIds === null || (sectionId !== null && a.sectionIds.includes(sectionId));
}

export function getAnnotationById(id: string, requesterId: number): AnnotationDTO | null {
  const row = getByIdStmt.get(id) as AnnotationRow | undefined;
  if (!row) return null;
  return rowToDTO(row, requesterId);
}

/** Soft-delete, so the person who deleted it can restore it (redo). */
export function deleteAnnotation(id: string, userId: number): boolean {
  purgeStmt.run();
  const info = deleteStmt.run(userId, id);
  return (info.changes as number) > 0;
}

/** Undo a deletion made by `userId`. Author, audience and timestamps are unchanged. */
export function restoreAnnotation(id: string, userId: number): AnnotationDTO | null {
  const info = restoreStmt.run(id, userId);
  return (info.changes as number) > 0 ? getAnnotationById(id, userId) : null;
}

/** Move or change a navigation marker without changing its author or audience. */
export function updateMarker(id: string, requesterId: number, marker: {
  markerKind: MarkerKind; label: string | null; position: { x: number; y: number }; page: number;
}): AnnotationDTO | null {
  db.prepare(`UPDATE annotations SET page = ?, payload = ?, updated_at = unixepoch() WHERE id = ? AND kind = 'marker'`)
    .run(marker.page, JSON.stringify({ markerKind: marker.markerKind, label: marker.label, position: marker.position }), id);
  return getAnnotationById(id, requesterId);
}
