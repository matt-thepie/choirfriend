/**
 * Server-backed annotation state for one piece.
 *
 * - Loads existing annotations on mount.
 * - `add()` does optimistic insert + background POST; rolls back on failure.
 * - `remove()` does optimistic delete + background DELETE; rolls back on failure.
 *
 * Conflict model is last-writer-wins for now.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Annotation, AnnotationLayer, InkPen, MarkerKind, MarkerAnnotation } from '@/types/annotations.ts';

interface NewInkInput {
  fileId: number;
  layer: AnnotationLayer;
  page: number;
  sectionIds?: number[] | null;
  kind: 'ink';
  pen: InkPen;
  color: string;
  width: number;
  points: Array<{ x: number; y: number }>;
}

interface NewMarkerInput {
  fileId: number;
  layer: AnnotationLayer;
  page: number;
  sectionIds?: number[] | null;
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
  add: (input: NewAnnotationInput) => Promise<boolean>;
  remove: (id: string) => Promise<void>;
  redo: () => Promise<void>;
  canRedo: boolean;
  saving: boolean;
  updateMarker: (marker: MarkerAnnotation) => Promise<void>;
}

function makeOptimistic(id: string, pieceId: number, input: NewAnnotationInput): Annotation {
  const common = {
    id,
    layer: input.layer,
    page: input.page,
    pieceId,
    fileId: input.fileId,
    isMine: true,
    sectionIds: input.layer === 'shared' && input.sectionIds?.length ? input.sectionIds : null,
  };
  if (input.kind === 'ink') {
    return {
      ...common,
      kind: 'ink',
      pen: input.pen,
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
  const [saving, setSaving] = useState(false);
  const [deleted, setDeleted] = useState<Annotation[]>([]);
  // Mutations run in order: a quick Undo must never delete before POST finishes.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const pending = useRef(0);
  const enqueue = useCallback(<T,>(operation: () => Promise<T>) => {
    pending.current++;
    setSaving(true);
    const next = queue.current.then(operation);
    queue.current = next.catch(() => {}).finally(() => {
      if (--pending.current === 0) setSaving(false);
    });
    return next;
  }, []);

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
    async (input: NewAnnotationInput): Promise<boolean> => {
      if (pieceId === null) return false;
      setError(null);
      const id = crypto.randomUUID();
      const optimistic = makeOptimistic(id, pieceId, input);
      setDeleted([]);
      setAnnotations((prev) => [...prev, optimistic]);
      return enqueue(async () => {
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
          return true;
        } catch (e) {
          setAnnotations((prev) => prev.filter((a) => a.id !== id));
          console.error('[annotations] save failed, rolled back:', e);
          setError(e instanceof Error ? e.message : String(e));
          return false;
        }
      });
    },
    [pieceId, enqueue],
  );

  const remove = useCallback(
    async (id: string): Promise<void> => {
      setError(null);
      const removed = annotations.find((a) => a.id === id);
      setAnnotations((prev) => prev.filter((a) => a.id !== id));
      return enqueue(async () => {
        try {
          const res = await fetch(`/api/annotations/${id}`, {
            method: 'DELETE',
            credentials: 'include',
          });
          // A 404 means the mark has already gone (or its POST failed).
          if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`);
          if (removed) setDeleted((prev) => [...prev, removed]);
        } catch (e) {
          if (removed) setAnnotations((prev) => [...prev, removed]);
          console.error('[annotations] delete failed, rolled back:', e);
          setError(e instanceof Error ? e.message : String(e));
        }
      });
    },
    [annotations, enqueue],
  );

  const redo = async () => {
    const a = deleted.at(-1);
    if (!a || a.fileId == null || saving) return;
    const remaining = deleted.slice(0, -1);
    const common = { fileId: a.fileId, page: a.page, layer: a.layer, sectionIds: a.sectionIds };
    const input: NewAnnotationInput = a.kind === 'ink'
      ? { ...common, kind: 'ink', pen: a.pen ?? 'pen', color: a.color, width: a.width, points: a.points }
      : { ...common, kind: 'marker', markerKind: a.markerKind, label: a.label, position: a.position };
    const ok = await add(input);
    setDeleted(ok ? remaining : deleted);
  };

  const updateMarker = async (marker: MarkerAnnotation) => enqueue(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/annotations/${marker.id}`, {
        method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ page: marker.page, markerKind: marker.markerKind, label: marker.label, position: marker.position }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const saved = await res.json() as Annotation;
      setAnnotations((prev) => prev.map((a) => a.id === saved.id ? saved : a));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  });

  return { annotations, loading, error, add, remove, redo, canRedo: deleted.length > 0, saving, updateMarker };
}
