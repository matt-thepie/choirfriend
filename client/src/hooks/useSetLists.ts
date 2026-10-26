/**
 * Set lists: list + detail hooks and the admin mutations.
 */

import { useCallback, useEffect, useState } from 'react';
import type { PieceFile } from '@/hooks/usePiece.ts';

export type SetListStatus = 'active' | 'archived';

export interface SetListSummary {
  id: number;
  name: string;
  status: SetListStatus;
  sortOrder: number;
  /** "This week's rehearsal" — shown first on the home screen. Only one at a time. */
  pinned: boolean;
  songCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface SetListSong {
  position: number;
  id: number;
  title: string;
  composer: string | null;
  arranger: string | null;
  audio: PieceFile[];
}

export interface SetList extends SetListSummary {
  songs: SetListSong[];
}

async function parseError(res: Response): Promise<Error> {
  const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
  return new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
}

export function useSetLists() {
  const [setLists, setSetLists] = useState<SetListSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch('/api/setlists', { credentials: 'include' })
      .then((r) => (r.ok ? (r.json() as Promise<SetListSummary[]>) : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data) => {
        if (!cancelled) setSetLists(data);
      })
      .catch((e) => console.error('[setlists] load failed:', e))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tick]);

  return { setLists, loading, refresh };
}

export function useSetList(id: number | null) {
  const [setList, setSetList] = useState<SetList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (id === null) {
      setSetList(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/setlists/${id}`, { credentials: 'include' })
      .then((r) => (r.ok ? (r.json() as Promise<SetList>) : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data) => {
        if (!cancelled) setSetList(data);
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
  }, [id, tick]);

  return { setList, loading, error, refresh, setSetList };
}

export interface SetListPatch {
  name?: string;
  status?: SetListStatus;
  sortOrder?: number;
  pinned?: boolean;
  pieceIds?: number[];
}

export async function createSetList(input: { name: string; pieceIds?: number[] }): Promise<SetList> {
  const res = await fetch('/api/setlists', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as SetList;
}

export async function patchSetList(id: number, patch: SetListPatch): Promise<SetList> {
  const res = await fetch(`/api/setlists/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as SetList;
}

export async function copySetList(id: number): Promise<SetList> {
  const res = await fetch(`/api/setlists/${id}/copy`, { method: 'POST', credentials: 'include' });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as SetList;
}

export async function deleteSetList(id: number): Promise<void> {
  const res = await fetch(`/api/setlists/${id}`, { method: 'DELETE', credentials: 'include' });
  if (!res.ok) throw await parseError(res);
}

/**
 * Pick the one track to play for a song when practising as a given section.
 * Preference: a track tagged with that section → an untagged track (full
 * mix / piano) → the first track. Null when the song has no audio at all.
 */
export function pickTrackForSection(audio: PieceFile[], sectionId: number | null): PieceFile | null {
  if (audio.length === 0) return null;
  if (sectionId !== null) {
    const own = audio.find((f) => f.sectionId === sectionId);
    if (own) return own;
  }
  return audio.find((f) => f.sectionId === null) ?? audio[0] ?? null;
}
