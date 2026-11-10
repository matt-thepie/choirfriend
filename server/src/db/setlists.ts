/**
 * Set lists: ordered selections of pieces. The detail DTO carries each
 * piece's audio files so the client can build a practice queue (one track
 * per song for a chosen section) without a request per song.
 *
 * Two kinds share the table: choir lists (owner_user_id NULL — admins manage
 * them, every member sees them) and personal lists (owner_user_id set — only
 * the owner sees or edits them, admins included). Every read is scoped to the
 * viewer so a personal list never leaks past its owner.
 */

import { db } from './index.ts';
import { getPieceWithFiles, storageUrl, type FileDTO } from './pieces.ts';
import { imageExists } from './images.ts';
import { sharedUrl } from '../storage/b2.ts';

export type SetListStatus = 'active' | 'archived';

interface SetListRow {
  id: number;
  name: string;
  status: SetListStatus;
  sort_order: number;
  pinned: number;
  owner_user_id: number | null;
  image_id: number | null;
  created_at: number;
  updated_at: number;
}

export interface SetListSummaryDTO {
  id: number;
  name: string;
  status: SetListStatus;
  sortOrder: number;
  /** "This week's rehearsal" — shown first on the home screen. Choir lists only. */
  pinned: boolean;
  /** A member's own list rather than one of the choir's. */
  personal: boolean;
  /** Owned by the viewer. Always true for personal lists the viewer can see. */
  mine: boolean;
  /** Cover picture from the shared pool, if one is set. */
  imageId: number | null;
  imageUrl: string | null;
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

type SummaryRow = SetListRow & { song_count: number; image_storage: 'b2' | 'local' | null; image_key: string | null; image_shared: number | null };

function toSummary(r: SummaryRow, viewerUserId: number | undefined): SetListSummaryDTO {
  return {
    id: r.id,
    name: r.name,
    status: r.status,
    sortOrder: r.sort_order,
    pinned: r.pinned === 1,
    personal: r.owner_user_id !== null,
    mine: r.owner_user_id !== null && r.owner_user_id === viewerUserId,
    imageId: r.image_id,
    imageUrl: r.image_id !== null && r.image_storage && r.image_key
      ? (r.image_shared ? sharedUrl(r.image_key) : storageUrl(r.image_storage, r.image_key))
      : null,
    songCount: r.song_count,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const SUMMARY_SELECT = `
  SELECT s.*, (SELECT COUNT(*) FROM set_list_items i WHERE i.set_list_id = s.id) AS song_count,
         im.storage AS image_storage, im.storage_key AS image_key, im.shared AS image_shared
  FROM set_lists s LEFT JOIN images im ON im.id = s.image_id
`;
/** Choir lists plus the viewer's own. Personal lists sort after choir ones. */
const listStmt = db.prepare(`${SUMMARY_SELECT}
  WHERE s.owner_user_id IS NULL OR s.owner_user_id = ?
  ORDER BY s.status, s.owner_user_id IS NOT NULL, s.pinned DESC, s.sort_order, s.name COLLATE NOCASE, s.id`);
const getStmt = db.prepare(`${SUMMARY_SELECT} WHERE s.id = ?`);
const itemsStmt = db.prepare(`
  SELECT i.position, p.id, p.title, p.composer, p.arranger
  FROM set_list_items i JOIN pieces p ON p.id = i.piece_id
  WHERE i.set_list_id = ? ORDER BY i.position, p.id
`);
const insertStmt = db.prepare(`INSERT INTO set_lists (name, status, sort_order, owner_user_id, image_id) VALUES (?, ?, ?, ?, ?) RETURNING id`);
const nextOrderStmt = db.prepare(`SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM set_lists WHERE owner_user_id IS ?`);
const deleteItemsStmt = db.prepare(`DELETE FROM set_list_items WHERE set_list_id = ?`);
const insertItemStmt = db.prepare(`INSERT OR IGNORE INTO set_list_items (set_list_id, piece_id, position) VALUES (?, ?, ?)`);
const touchStmt = db.prepare(`UPDATE set_lists SET updated_at = unixepoch() WHERE id = ?`);
const deleteStmt = db.prepare(`DELETE FROM set_lists WHERE id = ?`);
const unpinAllStmt = db.prepare(`UPDATE set_lists SET pinned = 0 WHERE pinned = 1`);
const pieceExistsStmt = db.prepare(`SELECT 1 FROM pieces WHERE id = ?`);

/** Thrown when imageId names a picture that isn't in the pool. */
export class UnknownImageError extends Error {
  constructor(imageId: number) {
    super(`unknown image id ${imageId}`);
  }
}

function assertImageExists(imageId: number | null | undefined): void {
  if (typeof imageId === 'number' && !imageExists(imageId)) throw new UnknownImageError(imageId);
}

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

/** The raw row if the viewer may see it: choir lists for everyone, personal
 *  lists for their owner only. Undefined viewer = a server-side caller (the
 *  importer) that only deals in choir lists. */
function visibleRow(id: number, viewerUserId: number | undefined): SummaryRow | null {
  const row = getStmt.get(id) as SummaryRow | undefined;
  if (!row) return null;
  if (row.owner_user_id !== null && row.owner_user_id !== viewerUserId) return null;
  return row;
}

/** Who owns set list `id` (null = the choir), or undefined if it doesn't exist.
 *  Routes use this for the edit check without leaking the row to non-owners. */
export function getSetListOwner(id: number): number | null | undefined {
  const row = db.prepare(`SELECT owner_user_id FROM set_lists WHERE id = ?`).get(id) as { owner_user_id: number | null } | undefined;
  return row ? row.owner_user_id : undefined;
}

export function listSetLists(viewerUserId?: number): SetListSummaryDTO[] {
  return (listStmt.all(viewerUserId ?? null) as unknown as SummaryRow[]).map((r) => toSummary(r, viewerUserId));
}

export function getSetList(id: number, viewerUserId?: number): SetListDTO | null {
  const row = visibleRow(id, viewerUserId);
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
  return { ...toSummary(row, viewerUserId), songs };
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
    personal: false,
    mine: false,
    imageId: null,
    imageUrl: null,
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
  /** Owner of a personal list. Omit (or null) for a choir list. */
  ownerUserId?: number | null;
  /** Cover picture from the shared pool. */
  imageId?: number | null;
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
  assertImageExists(input.imageId);
  const owner = input.ownerUserId ?? null;
  const order = (nextOrderStmt.get(owner) as { n: number }).n;
  db.exec('BEGIN');
  try {
    const { id } = insertStmt.get(input.name, input.status ?? 'active', order, owner, input.imageId ?? null) as { id: number };
    if (input.pieceIds) writeItems(id, input.pieceIds);
    db.exec('COMMIT');
    return getSetList(id, owner ?? undefined)!;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export interface UpdateSetListInput {
  name?: string;
  status?: SetListStatus;
  sortOrder?: number;
  /** Pin as "this week". Pinning one list unpins any other. Choir lists only. */
  pinned?: boolean;
  /** Full ordered list of piece ids; replaces the current contents. */
  pieceIds?: number[];
  /** Cover picture from the shared pool; null clears it. */
  imageId?: number | null;
}

/** Update a set list the caller has already been checked to own/manage. The
 *  viewer id only shapes the returned DTO. */
export function updateSetList(id: number, input: UpdateSetListInput, viewerUserId?: number): SetListDTO | null {
  if (!getStmt.get(id)) return null;
  if (input.pieceIds) assertPiecesExist(input.pieceIds);
  assertImageExists(input.imageId);
  const sets: string[] = [];
  const params: Array<string | number | null> = [];
  if (input.imageId !== undefined) {
    sets.push('image_id = ?');
    params.push(input.imageId);
  }
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
  return getSetList(id, viewerUserId);
}

/** Duplicate a set list (and its songs) as "<name> (copy)", active, owned by
 *  `ownerUserId` (null = a choir list). A member copying a choir list gets
 *  their own personal copy of it. Returns null if the source isn't visible to
 *  the viewer. */
export function copySetList(id: number, viewerUserId: number | undefined, ownerUserId: number | null): SetListDTO | null {
  const src = getSetList(id, viewerUserId);
  if (!src) return null;
  return createSetList({
    name: `${src.name} (copy)`,
    status: 'active',
    pieceIds: src.songs.map((s) => s.id),
    ownerUserId,
    imageId: src.imageId,
  });
}

export function deleteSetList(id: number): boolean {
  return (deleteStmt.run(id).changes as number) > 0;
}
