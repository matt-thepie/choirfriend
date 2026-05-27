import { useCallback, useEffect, useState } from 'react';

export interface PieceSummary {
  id: number;
  title: string;
  composer: string | null;
  arranger: string | null;
  notes: string | null;
  isCurrent: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface UsePiecesResult {
  pieces: PieceSummary[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/** Lists all pieces. Refetch by calling refresh() after a create/upload. */
export function usePieces(): UsePiecesResult {
  const [pieces, setPieces] = useState<PieceSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch('/api/pieces', { credentials: 'include' })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<PieceSummary[]>;
      })
      .then((data) => {
        if (!cancelled) setPieces(data);
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
  }, [tick]);

  return { pieces, loading, error, refresh };
}

export interface CreatePieceInput {
  title: string;
  composer?: string;
  arranger?: string;
  notes?: string;
}

export async function createPiece(input: CreatePieceInput): Promise<PieceSummary> {
  const res = await fetch('/api/pieces', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as PieceSummary;
}

export interface UpdatePieceInput {
  title?: string;
  composer?: string | null;
  arranger?: string | null;
  notes?: string | null;
  isCurrent?: boolean;
}

/** Admin-only on the server. Caller is responsible for hiding the UI when
 *  the current user isn't an admin; this function reports 403s as errors. */
export async function patchPiece(id: number, input: UpdatePieceInput): Promise<PieceSummary> {
  const res = await fetch(`/api/pieces/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as PieceSummary;
}
