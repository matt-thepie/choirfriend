/**
 * Loads a single piece (with its files) from the API. Returns null until
 * loaded, an Error on failure.
 */

import { useCallback, useEffect, useState } from 'react';

/**
 *  pdf    sheet music (rendered in the viewer)
 *  audio  learning tracks
 *  lyrics words / crib sheets — pdf, docx, rtf, txt… (a PDF opens in the viewer, the rest download)
 *  score  editable notation (MuseScore, MusicXML) — only sent to MD / committee / section admins
 */
export type FileKind = 'pdf' | 'audio' | 'lyrics' | 'score';

export const FILE_KIND_LABEL: Record<FileKind, string> = {
  pdf: 'Sheet music',
  audio: 'Audio',
  lyrics: 'Lyrics',
  score: 'Score',
};

export function isPdfFile(f: Pick<PieceFile, 'mimeType' | 'filename'>): boolean {
  return f.mimeType === 'application/pdf' || /\.pdf$/i.test(f.filename);
}

export interface PieceFile {
  id: number;
  pieceId: number;
  kind: FileKind;
  label: string | null;
  filename: string;
  sizeBytes: number | null;
  mimeType: string | null;
  sortOrder: number;
  url: string;
  createdAt: number;
  createdByUserId: number | null;
  /** Uploader's display name, or null for seeded/legacy files. */
  createdByName: string | null;
  /** Voice part (audio only). Null = not part-specific, e.g. a full mix. */
  sectionId: number | null;
  /** Track length in ms (audio). Null = unknown. */
  durationMs: number | null;
  /** Private files are only returned to their uploader. */
  visibility: 'private' | 'shared';
  /** Uploaded by the signed-in member. */
  mine?: boolean;
  /** The signed-in member may rename, share, replace or delete it. */
  canManage?: boolean;
}

export interface Remark {
  sectionId: number;
  text: string;
  updatedByName: string | null;
  updatedAt: number;
}

export type LinkType = 'spotify' | 'youtube' | 'appleMusic' | 'other';
export const LINK_TYPE_LABEL: Record<LinkType, string> = {
  spotify: 'Spotify',
  youtube: 'YouTube',
  appleMusic: 'Apple Music',
  other: 'Link',
};

export interface PieceLink {
  id: number;
  type: LinkType;
  url: string;
  label: string | null;
}

export interface MemberPieceState {
  /** 1 sad, 2 neutral, 3 happy; null = not rated. */
  confidence: 1 | 2 | 3 | null;
  notes: string | null;
}

/** A flowing score: MusicXML made on the server from an editable score,
 *  engraved in the browser to fit the screen. Members get ready ones only;
 *  score managers also see conversions in progress and failures. */
export interface FlowingScore {
  /** The editable score it was made from. */
  fileId: number;
  title: string;
  status: 'pending' | 'ready' | 'failed';
  url: string | null;
  error: string | null;
}

export interface Piece {
  id: number;
  title: string;
  composer: string | null;
  arranger: string | null;
  notes: string | null;
  lyrics: string | null;
  files: PieceFile[];
  flowing?: FlowingScore[];
  remarks: Remark[];
  links: PieceLink[];
  /** The signed-in member's own rating and private notes. */
  me: MemberPieceState;
  createdAt: number;
  updatedAt: number;
}

export async function saveMemberPieceState(pieceId: number, patch: Partial<MemberPieceState>): Promise<MemberPieceState> {
  const res = await fetch(`/api/pieces/${pieceId}/me`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as MemberPieceState;
}

export async function saveRemark(pieceId: number, sectionId: number, text: string): Promise<Remark[]> {
  const res = await fetch(`/api/pieces/${pieceId}/remarks/${sectionId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as Remark[];
}

export async function addPieceLink(pieceId: number, input: { url: string; type?: LinkType; label?: string }): Promise<PieceLink> {
  const res = await fetch(`/api/pieces/${pieceId}/links`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as PieceLink;
}

export async function deletePieceLink(pieceId: number, linkId: number): Promise<void> {
  const res = await fetch(`/api/pieces/${pieceId}/links/${linkId}`, { method: 'DELETE', credentials: 'include' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export interface UsePieceResult {
  piece: Piece | null;
  loading: boolean;
  error: string | null;
  /** Refetch the piece — call after upload/delete so the file list updates. */
  refresh: () => void;
}

/**
 * @param pieceId — which piece to load (null = idle).
 * @param externalRefreshKey — when this changes, refetch. Lets a parent
 *   component drive multiple consumers (e.g. PdfViewer + AudioPlayer) to
 *   refetch in lockstep after a mutation like a file upload.
 */
export function usePiece(pieceId: number | null, externalRefreshKey = 0): UsePieceResult {
  const [piece, setPiece] = useState<Piece | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (pieceId === null) {
      setPiece(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/pieces/${pieceId}`, { credentials: 'include' })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<Piece>;
      })
      .then((p) => {
        if (!cancelled) setPiece(p);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [pieceId, tick, externalRefreshKey]);

  // A just-uploaded score is converted on the server; check back quietly
  // (no loading state) until its flowing score is ready or has failed.
  const converting = piece?.id === pieceId && (piece?.flowing ?? []).some((f) => f.status === 'pending');
  useEffect(() => {
    if (!converting || pieceId === null) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      fetch(`/api/pieces/${pieceId}`, { credentials: 'include' })
        .then((r) => (r.ok ? (r.json() as Promise<Piece>) : null))
        .then((p) => {
          if (p && !cancelled) setPiece(p);
        })
        .catch(() => {});
    }, 3000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [converting, pieceId, piece]);

  return { piece, loading, error, refresh };
}
