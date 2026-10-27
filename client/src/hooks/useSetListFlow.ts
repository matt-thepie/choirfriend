/**
 * Moving through a set list from inside the score viewer: which song comes
 * before and after this one, and which sheet to open for it. Performing from
 * music, the set list should flow from the first song to the last.
 */

import { useEffect, useState } from 'react';
import type { SetList } from '@/hooks/useSetLists.ts';
import { isPdfFile, type FlowingScore, type PieceFile } from '@/hooks/usePiece.ts';

export interface FlowSong {
  id: number;
  title: string;
}

export interface SetListFlow {
  name: string;
  /** 1-based position of the open song in the list. */
  position: number;
  total: number;
  prev: FlowSong | null;
  next: FlowSong | null;
}

/** The sheet the viewer opens by default: the first sheet-music PDF, or a
 *  PDF lyric sheet when a song has no music. Null when there is neither. */
function defaultSheet(files: PieceFile[]): PieceFile | null {
  const bySort = [...files].sort((a, b) => a.sortOrder - b.sortOrder);
  return bySort.find((f) => f.kind === 'pdf') ?? bySort.find((f) => f.kind === 'lyrics' && isPdfFile(f)) ?? null;
}

export async function fetchDefaultSheet(pieceId: number): Promise<PieceFile | null> {
  const res = await fetch(`/api/pieces/${pieceId}`, { credentials: 'include' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const piece = (await res.json()) as { files: PieceFile[] };
  return defaultSheet(piece.files);
}

const PREFER_FLOWING_KEY = 'choirfriend.preferFlowing';

/** Remember whether the member last chose a flowing score or a PDF, so a set
 *  list carries on in the same kind of view. */
export function setPreferFlowing(on: boolean): void {
  try {
    localStorage.setItem(PREFER_FLOWING_KEY, on ? '1' : '0');
  } catch {
    /* storage blocked */
  }
}

function preferFlowing(): boolean {
  try {
    return localStorage.getItem(PREFER_FLOWING_KEY) === '1';
  } catch {
    return false;
  }
}

/** What to open a song on: a flowing score if the member prefers those and
 *  the song has one ready, else its default sheet (or a flowing score when
 *  there's no PDF at all). */
export async function fetchDefaultView(pieceId: number): Promise<{ fileId: number; flow: boolean } | null> {
  const res = await fetch(`/api/pieces/${pieceId}`, { credentials: 'include' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const piece = (await res.json()) as { files: PieceFile[]; flowing?: FlowingScore[] };
  const flowing = (piece.flowing ?? []).find((f) => f.status === 'ready');
  const sheet = defaultSheet(piece.files);
  if (flowing && (preferFlowing() || !sheet)) return { fileId: flowing.fileId, flow: true };
  return sheet ? { fileId: sheet.id, flow: false } : null;
}

/** Largest next-song PDF fetched ahead of time, so a page turn into it is
 *  instant (and works offline) without pulling huge scans over mobile data. */
const PREFETCH_MAX_BYTES = 8_000_000;

export function useSetListFlow(setListId: number | null, pieceId: number | null): SetListFlow | null {
  const [list, setList] = useState<SetList | null>(null);

  useEffect(() => {
    if (setListId === null) {
      setList(null);
      return;
    }
    let cancelled = false;
    fetch(setListId === 0 ? '/api/setlists/all' : `/api/setlists/${setListId}`, { credentials: 'include' })
      .then((r) => (r.ok ? (r.json() as Promise<SetList>) : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => {
        if (!cancelled) setList(d);
      })
      .catch((e) => console.error('[setlist flow] load failed:', e));
    return () => {
      cancelled = true;
    };
  }, [setListId]);

  const index = list && pieceId !== null ? list.songs.findIndex((s) => s.id === pieceId) : -1;
  const song = (i: number): FlowSong | null => {
    const s = list?.songs[i];
    return s ? { id: s.id, title: s.title } : null;
  };
  const flow: SetListFlow | null =
    list && index >= 0
      ? { name: list.name, position: index + 1, total: list.songs.length, prev: song(index - 1), next: song(index + 1) }
      : null;

  // Warm the next song's piece data and sheet so turning into it is instant.
  const nextId = flow?.next?.id ?? null;
  useEffect(() => {
    if (nextId === null) return;
    let cancelled = false;
    const t = setTimeout(() => {
      fetchDefaultSheet(nextId)
        .then((sheet) => {
          if (!cancelled && sheet && (sheet.sizeBytes ?? 0) <= PREFETCH_MAX_BYTES) return fetch(sheet.url);
        })
        .catch(() => {
          /* best effort */
        });
    }, 3000);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [nextId]);

  return flow;
}
