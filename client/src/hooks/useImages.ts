/**
 * Cover pictures for set lists: the shared pool, and the admin upload
 * (sign → PUT to B2 → complete, the same shape as file uploads).
 */

import { useCallback, useEffect, useState } from 'react';

export interface CoverImage {
  id: number;
  url: string;
  filename: string;
  mimeType: string;
  sizeBytes: number | null;
  usedBy: number;
  createdAt: number;
}

export const IMAGE_ACCEPT = 'image/jpeg,image/png,image/webp,image/gif,image/avif,.jpg,.jpeg,.png,.webp,.gif,.avif';

async function parseError(res: Response, fallback: string): Promise<Error> {
  const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
  return new Error(body.message ?? body.error ?? `${fallback} (HTTP ${res.status})`);
}

export function useImages(enabled: boolean) {
  const [images, setImages] = useState<CoverImage[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setLoading(true);
    fetch('/api/images', { credentials: 'include' })
      .then((r) => (r.ok ? (r.json() as Promise<CoverImage[]>) : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data) => {
        if (!cancelled) setImages(data);
      })
      .catch((e) => console.error('[images] load failed:', e))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, tick]);

  return { images, loading, refresh, setImages };
}

export async function uploadImage(file: File): Promise<CoverImage> {
  const mimeType = file.type || (/\.png$/i.test(file.name) ? 'image/png' : 'image/jpeg');
  const meta = { filename: file.name, mimeType, sizeBytes: file.size };

  const signRes = await fetch('/api/images/sign-upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(meta),
  });
  if (!signRes.ok) throw await parseError(signRes, 'sign failed');
  const signed = (await signRes.json()) as { url: string; storageKey: string };

  const putRes = await fetch(signed.url, { method: 'PUT', headers: { 'Content-Type': mimeType }, body: file });
  if (!putRes.ok) throw new Error(`upload to B2 failed (HTTP ${putRes.status})`);

  const completeRes = await fetch('/api/images/complete-upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ ...meta, storageKey: signed.storageKey }),
  });
  if (!completeRes.ok) throw await parseError(completeRes, 'complete failed');
  return (await completeRes.json()) as CoverImage;
}

export async function deleteImage(id: number): Promise<void> {
  const res = await fetch(`/api/images/${id}`, { method: 'DELETE', credentials: 'include' });
  if (!res.ok) throw await parseError(res, 'delete failed');
}
