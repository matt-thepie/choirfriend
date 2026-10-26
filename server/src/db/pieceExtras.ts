/**
 * The bits that hang off a song besides its files: per-section remarks,
 * external links, and each member's own confidence rating and private notes.
 */

import { db } from './index.ts';

// --- Remarks ----------------------------------------------------------------

export interface RemarkDTO {
  sectionId: number;
  text: string;
  updatedByName: string | null;
  updatedAt: number;
}

const listRemarksStmt = db.prepare(`
  SELECT r.section_id, r.text, r.updated_at, u.display_name AS updated_by_name
  FROM piece_remarks r LEFT JOIN users u ON u.id = r.updated_by_user_id
  WHERE r.piece_id = ? ORDER BY r.section_id
`);
const upsertRemarkStmt = db.prepare(`
  INSERT INTO piece_remarks (piece_id, section_id, text, updated_by_user_id, updated_at)
  VALUES (?, ?, ?, ?, unixepoch())
  ON CONFLICT(piece_id, section_id) DO UPDATE SET
    text = excluded.text, updated_by_user_id = excluded.updated_by_user_id, updated_at = unixepoch()
`);
const deleteRemarkStmt = db.prepare(`DELETE FROM piece_remarks WHERE piece_id = ? AND section_id = ?`);

export function listRemarks(pieceId: number): RemarkDTO[] {
  return (listRemarksStmt.all(pieceId) as Array<{ section_id: number; text: string; updated_at: number; updated_by_name: string | null }>).map((r) => ({
    sectionId: r.section_id,
    text: r.text,
    updatedByName: r.updated_by_name,
    updatedAt: r.updated_at,
  }));
}

/** Empty text removes the remark. */
export function setRemark(pieceId: number, sectionId: number, text: string, userId: number | null): void {
  const t = text.trim();
  if (t) upsertRemarkStmt.run(pieceId, sectionId, t, userId);
  else deleteRemarkStmt.run(pieceId, sectionId);
}

// --- Links ------------------------------------------------------------------

export type LinkType = 'spotify' | 'youtube' | 'appleMusic' | 'other';
export const LINK_TYPES: readonly LinkType[] = ['spotify', 'youtube', 'appleMusic', 'other'];

export interface LinkDTO {
  id: number;
  type: LinkType;
  url: string;
  label: string | null;
}

const listLinksStmt = db.prepare(`SELECT id, type, url, label FROM piece_links WHERE piece_id = ? ORDER BY sort_order, id`);
const insertLinkStmt = db.prepare(`
  INSERT INTO piece_links (piece_id, type, url, label, sort_order)
  VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM piece_links WHERE piece_id = ?))
  RETURNING id, type, url, label
`);
const deleteLinkStmt = db.prepare(`DELETE FROM piece_links WHERE id = ? AND piece_id = ?`);

export function listLinks(pieceId: number): LinkDTO[] {
  return listLinksStmt.all(pieceId) as unknown as LinkDTO[];
}

export function addLink(pieceId: number, type: LinkType, url: string, label: string | null): LinkDTO {
  return insertLinkStmt.get(pieceId, type, url, label, pieceId) as unknown as LinkDTO;
}

export function deleteLink(pieceId: number, linkId: number): boolean {
  return (deleteLinkStmt.run(linkId, pieceId).changes as number) > 0;
}

/** Guess the link type from its host, for "paste a URL" flows. */
export function guessLinkType(url: string): LinkType {
  const u = url.toLowerCase();
  if (u.includes('spotify.com')) return 'spotify';
  if (u.includes('youtube.com') || u.includes('youtu.be')) return 'youtube';
  if (u.includes('music.apple.com')) return 'appleMusic';
  return 'other';
}

// --- Member state -----------------------------------------------------------

export interface MemberPieceStateDTO {
  /** 1 sad, 2 neutral, 3 happy; null = not rated. */
  confidence: 1 | 2 | 3 | null;
  notes: string | null;
}

const getStateStmt = db.prepare(`SELECT confidence, notes FROM member_piece_state WHERE user_id = ? AND piece_id = ?`);
const upsertStateStmt = db.prepare(`
  INSERT INTO member_piece_state (user_id, piece_id, confidence, notes, updated_at)
  VALUES (?, ?, ?, ?, unixepoch())
  ON CONFLICT(user_id, piece_id) DO UPDATE SET
    confidence = excluded.confidence, notes = excluded.notes, updated_at = unixepoch()
`);

export function getMemberPieceState(userId: number, pieceId: number): MemberPieceStateDTO {
  const row = getStateStmt.get(userId, pieceId) as { confidence: 1 | 2 | 3 | null; notes: string | null } | undefined;
  return { confidence: row?.confidence ?? null, notes: row?.notes ?? null };
}

/** Only provided keys change. */
export function setMemberPieceState(
  userId: number,
  pieceId: number,
  patch: Partial<MemberPieceStateDTO>,
): MemberPieceStateDTO {
  const cur = getMemberPieceState(userId, pieceId);
  const next: MemberPieceStateDTO = {
    confidence: patch.confidence !== undefined ? patch.confidence : cur.confidence,
    notes: patch.notes !== undefined ? (patch.notes?.trim() || null) : cur.notes,
  };
  upsertStateStmt.run(userId, pieceId, next.confidence, next.notes);
  return next;
}
