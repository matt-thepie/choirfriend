/**
 * Loads a single piece (with its files) from the API. Returns null until
 * loaded, an Error on failure.
 */

import { useEffect, useState } from 'react';

export interface PieceFile {
  id: number;
  pieceId: number;
  kind: 'pdf' | 'audio';
  label: string | null;
  filename: string;
  sizeBytes: number | null;
  mimeType: string | null;
  sortOrder: number;
  url: string;
  createdAt: number;
}

export interface Piece {
  id: number;
  title: string;
  composer: string | null;
  arranger: string | null;
  notes: string | null;
  files: PieceFile[];
  createdAt: number;
  updatedAt: number;
}

export interface UsePieceResult {
  piece: Piece | null;
  loading: boolean;
  error: string | null;
}

export function usePiece(pieceId: number | null): UsePieceResult {
  const [piece, setPiece] = useState<Piece | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
  }, [pieceId]);

  return { piece, loading, error };
}
