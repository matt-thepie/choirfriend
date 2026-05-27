/**
 * Server-backed annotation state for one piece.
 *
 * - Loads existing annotations on mount.
 * - `add()` does optimistic insert + background POST; rolls back on failure.
 * - `remove()` does optimistic delete + background DELETE; rolls back on failure.
 *
 * Conflict model is last-writer-wins for now.
 */

import { useCallback, useEffect, useState } from 'react';
import type { Annotation, AnnotationLayer, MarkerKind } from '@/types/annotations.ts';

interface NewInkInput {
  fileId: number;
  layer: AnnotationLayer;
  page: number;
  kind: 'ink';
  color: string;
  width: number;
  points: Array<{ x: number; y: number }>;
}

interface NewMarkerInput {
  fileId: number;
  layer: AnnotationLayer;
  page: number;
  kind: 'marker';
  markerKind: MarkerKind;
  label: string | null;
  position: { x: number; y: number };
}

export type NewAnnotationInput = NewInkInput | NewMarkerInput;

export interface UseAnnotationsResult {
  annotations: Annotation[];
  loading: boolean;
  error: string | null;
  add: (input: NewAnnotationInput) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

function makeOptimistic(id: string, pieceId: number, input: NewAnnotationInput): Annotation {
  const common = {
    id,
    layer: input.layer,
    page: input.page,
    pieceId,
    fileId: input.fileId,
    isMine: true,
  };
  if (input.kind === 'ink') {
    return {
      ...common,
      kind: 'ink',
      color: input.color,
      width: input.width,
      points: input.points,
    };
  }
  return {
    ...common,
    kind: 'marker',
    markerKind: input.markerKind,
    label: input.label,
    position: input.position,
  };
}

export function useAnnotations(pieceId: number | null): UseAnnotationsResult {
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (pieceId === null) {
      setAnnotations([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/pieces/${pieceId}/annotations`, { credentials: 'include' })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<Annotation[]>;
      })
      .then((data) => {
        if (!cancelled) setAnnotations(data);
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

  const add = useCallback(
    async (input: NewAnnotationInput): Promise<void> => {
      if (pieceId === null) return;
      const id = crypto.randomUUID();
      const optimistic = makeOptimistic(id, pieceId, input);
      setAnnotations((prev) => [...prev, optimistic]);

      try {
        const res = await fetch(`/api/pieces/${pieceId}/annotations`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ id, ...input }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const saved = (await res.json()) as Annotation;
        setAnnotations((prev) => prev.map((a) => (a.id === id ? saved : a)));
      } catch (e) {
        setAnnotations((prev) => prev.filter((a) => a.id !== id));
        console.error('[annotations] save failed, rolled back:', e);
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [pieceId],
  );

  const remove = useCallback(
    async (id: string): Promise<void> => {
      const previous = annotations;
      setAnnotations((prev) => prev.filter((a) => a.id !== id));
      try {
        const res = await fetch(`/api/annotations/${id}`, {
          method: 'DELETE',
          credentials: 'include',
        });
        if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`);
      } catch (e) {
        setAnnotations(previous);
        console.error('[annotations] delete failed, rolled back:', e);
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [annotations],
  );

  return { annotations, loading, error, add, remove };
}
