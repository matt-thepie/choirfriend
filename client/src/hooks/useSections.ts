/**
 * Choir voice parts. Fetched once per app session; tiny list, rarely changes.
 */

import { useEffect, useMemo, useState } from 'react';

export interface Section {
  id: number;
  label: string;
  badge: string;
  sortOrder: number;
}

export interface UseSectionsResult {
  sections: Section[];
  byId: Map<number, Section>;
  loading: boolean;
}

export function useSections(): UseSectionsResult {
  const [sections, setSections] = useState<Section[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/sections', { credentials: 'include' })
      .then((r) => (r.ok ? (r.json() as Promise<Section[]>) : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data) => {
        if (!cancelled) setSections(data);
      })
      .catch((e) => console.error('[sections] load failed:', e))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const byId = useMemo(() => new Map(sections.map((s) => [s.id, s])), [sections]);
  return { sections, byId, loading };
}

/** Save the signed-in member's own voice part (null to clear). */
export async function saveMySection(sectionId: number | null): Promise<void> {
  const res = await fetch('/api/me', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ sectionId }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}
