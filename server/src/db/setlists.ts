/**
 * Set lists: ordered selections of pieces. The detail DTO carries each
 * piece's audio files so the client can build a practice queue (one track
 * per song for a chosen section) without a request per song.
 */

import { db } from './index.ts';
import { getPieceWithFiles, type FileDTO } from './pieces.ts';

export type SetListStatus = 'active' | 'archived';

interface SetListRow {
  id: number;
  name: string;
  status: SetListStatus;
  sort_order: number;
  pinned: number;
  created_at: number;
  updated_at: number;
}

export interface SetListSummaryDTO {
  id: number;
  name: string;
  status: SetListStatus;
  sortOrder: number;
  /** "This week's rehearsal" — shown first on the home screen. */
  pinned: boolean;
  songCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface SetListSongDTO {
  position: number;
  id: number;
  title: string;
  composer: string | null;
  arranger: string | null;
  /** Audio tracks only — what the practice queue needs. */
  audio: FileDTO[];
}

export interface SetListDTO extends SetListSummaryDTO {
  songs: SetListSongDTO[];
}

function toSummary(r: SetListRow & { song_count: number }): SetListSummaryDTO {
  return {
    id: r.id,
    name: r.name,
    status: r.status,
    sortOrder: r.sort_order,
    pinned: r.pinned === 1,
    songCount: r.song_count,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const SUMMARY_SELECT = `
  SELECT s.*, (SELECT COUNT(*) FROM set_list_items i WHERE i.set_list_id = s.id) AS song_count
  FROM set_lists s
`;
const listStmt = db.prepare(`${SUMMARY_SELECT} ORDER BY s.status, s.pinned DESC, s.sort_order, s.name COLLATE NOCASE, s.id`);
const getStmt = db.prepare(`${SUMMARY_SELECT} WHERE s.id = ?`);
const itemsStmt = db.prepare(`
  SELECT i.position, p.id, p.title, p.composer, p.arranger
  FROM set_list_items i JOIN pieces p ON p.id = i.piece_id
  WHERE i.set_list_id = ? ORDER BY i.position, p.id
`);
const insertStmt = db.prepare(`INSERT INTO set_lists (name, status, sort_order) VALUES (?, ?, ?) RETURNING id`);
const nextOrderStmt = db.prepare(`SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM set_lists`);
const deleteItemsStmt = db.prepare(`DELETE FROM set_list_items WHERE set_list_id = ?`);
const insertItemStmt = db.prepare(`INSERT OR IGNORE INTO set_list_items (set_list_id, piece_id, position) VALUES (?, ?, ?)`);
const touchStmt = db.prepare(`UPDATE set_lists SET updated_at = unixepoch() WHERE id = ?`);
const deleteStmt = db.prepare(`DELETE FROM set_lists WHERE id = ?`);
const unpinAllStmt = db.prepare(`UPDATE set_lists SET pinned = 0 WHERE pinned = 1`);
const pieceExistsStmt = db.prepare(`SELECT 1 FROM pieces WHERE id = ?`);

/** Thrown when a pieceIds list references a piece that doesn't exist. Routes
 *  turn it into a 400 rather than letting the FK failure surface as a 500. */
export class UnknownPieceError extends Error {
  readonly pieceId: number;
  constructor(pieceId: number) {
    super(`unknown piece id ${pieceId}`);
    this.pieceId = pieceId;
  }
}

function assertPiecesExist(pieceIds: number[]): void {
  for (const id of pieceIds) {
    if (!pieceExistsStmt.get(id)) throw new UnknownPieceError(id);
  }
}

export function listSetLists(): SetListSummaryDTO[] {
  return (listStmt.all() as Array<SetListRow & { song_count: number }>).map(toSummary);
}

export function getSetList(id: number, viewerUserId?: number): SetListDTO | null {
  const row = getStmt.get(id) as (SetListRow & { song_count: number }) | undefined;
  if (!row) return null;
  const items = itemsStmt.all(id) as Array<{
    position: number;
    id: number;
    title: string;
    composer: string | null;
    arranger: string | null;
  }>;
  const songs: SetListSongDTO[] = items.map((it) => ({
    ...it,
    audio: getPieceWithFiles(it.id, viewerUserId)?.files.filter((f) => f.kind === 'audio') ?? [],
  }));
  return { ...toSummary(row), songs };
}

const allPiecesStmt = db.prepare(`SELECT id, title, composer, arranger FROM pieces ORDER BY title COLLATE NOCASE, id`);

/** The virtual "All songs" set list: the whole repertoire in title order.
 *  Never stored; id 0 marks it as virtual. */
export function getAllSongsSetList(viewerUserId?: number): SetListDTO {
  const items = allPiecesStmt.all() as Array<{ id: number; title: string; composer: string | null; arranger: string | null }>;
  const songs: SetListSongDTO[] = items.map((it, position) => ({
    position,
    ...it,
    audio: getPieceWithFiles(it.id, viewerUserId)?.files.filter((f) => f.kind === 'audio') ?? [],
  }));
  return {
    id: 0,
    name: 'All songs',
    status: 'active',
    sortOrder: -1,
    pinned: false,
    songCount: songs.length,
    createdAt: 0,
    updatedAt: 0,
    songs,
  };
}

export interface CreateSetListInput {
  name: string;
  status?: SetListStatus;
  pieceIds?: number[];
}

function writeItems(setListId: number, pieceIds: number[]): void {
  deleteItemsStmt.run(setListId);
  // Dedupe while preserving first occurrence — the PK would reject repeats.
  const seen = new Set<number>();
  let pos = 0;
  for (const pid of pieceIds) {
    if (seen.has(pid)) continue;
    seen.add(pid);
    insertItemStmt.run(setListId, pid, pos++);
  }
}

export function createSetList(input: CreateSetListInput): SetListDTO {
  if (input.pieceIds) assertPiecesExist(input.pieceIds);
  const order = (nextOrderStmt.get() as { n: number }).n;
  db.exec('BEGIN');
  try {
    const { id } = insertStmt.get(input.name, input.status ?? 'active', order) as { id: number };
    if (input.pieceIds) writeItems(id, input.pieceIds);
    db.exec('COMMIT');
    return getSetList(id)!;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export interface UpdateSetListInput {
  name?: string;
  status?: SetListStatus;
  sortOrder?: number;
  /** Pin as "this week". Pinning one list unpins any other. */
  pinned?: boolean;
  /** Full ordered list of piece ids; replaces the current contents. */
  pieceIds?: number[];
}

export function updateSetList(id: number, input: UpdateSetListInput): SetListDTO | null {
  if (!getStmt.get(id)) return null;
  if (input.pieceIds) assertPiecesExist(input.pieceIds);
  const sets: string[] = [];
  const params: Array<string | number> = [];
  if (input.name !== undefined) {
    sets.push('name = ?');
    params.push(input.name);
  }
  if (input.pinned !== undefined) {
    sets.push('pinned = ?');
    params.push(input.pinned ? 1 : 0);
  }
  if (input.status !== undefined) {
    sets.push('status = ?');
    params.push(input.status);
  }
  if (input.sortOrder !== undefined) {
    sets.push('sort_order = ?');
    params.push(input.sortOrder);
  }
  db.exec('BEGIN');
  try {
    if (input.pinned) unpinAllStmt.run();
    if (sets.length > 0) {
      db.prepare(`UPDATE set_lists SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
    }
    if (input.pieceIds) writeItems(id, input.pieceIds);
    touchStmt.run(id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return getSetList(id);
}

/** Duplicate a set list (and its songs) as "<name> (copy)", active. */
export function copySetList(id: number): SetListDTO | null {
  const src = getSetList(id);
  if (!src) return null;
  return createSetList({
    name: `${src.name} (copy)`,
    status: 'active',
    pieceIds: src.songs.map((s) => s.id),
  });
}

export function deleteSetList(id: number): boolean {
  return (deleteStmt.run(id).changes as number) > 0;
}
