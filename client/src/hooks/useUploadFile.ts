/**
 * Three-step upload to Backblaze B2 via the server's presign endpoint.
 *
 *   1. POST /api/pieces/:id/files/sign-upload   → { url, storageKey }
 *   2. PUT file.bytes to `url` directly to B2
 *   3. POST /api/pieces/:id/files/complete-upload to create the DB row
 *
 * The browser never proxies large bytes through our server — keeps the
 * API free of multipart, large request bodies, and timeout games. The
 * `fetch` PUT doesn't report progress; an XHR upgrade is easy if/when we
 * want a real progress bar.
 */

import { useCallback, useState } from 'react';
import type { PieceFile } from './usePiece.ts';

export type UploadStatus =
  | { phase: 'idle' }
  | { phase: 'signing'; filename: string }
  | { phase: 'uploading'; filename: string }
  | { phase: 'completing'; filename: string }
  | { phase: 'done'; filename: string }
  | { phase: 'error'; filename: string; message: string };

export interface UseUploadFileResult {
  status: UploadStatus;
  upload: (file: File, kind: 'pdf' | 'audio', label?: string) => Promise<PieceFile | null>;
}

interface SignResponse {
  url: string;
  storageKey: string;
  expiresIn: number;
}

export function useUploadFile(pieceId: number | null): UseUploadFileResult {
  const [status, setStatus] = useState<UploadStatus>({ phase: 'idle' });

  const upload = useCallback(
    async (file: File, kind: 'pdf' | 'audio', label?: string): Promise<PieceFile | null> => {
      if (pieceId === null) return null;
      const mimeType = file.type || (kind === 'pdf' ? 'application/pdf' : 'application/octet-stream');

      try {
        setStatus({ phase: 'signing', filename: file.name });
        const signRes = await fetch(`/api/pieces/${pieceId}/files/sign-upload`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            filename: file.name,
            kind,
            mimeType,
            sizeBytes: file.size,
          }),
        });
        if (!signRes.ok) {
          const body = (await signRes.json().catch(() => ({}))) as { error?: string; message?: string };
          throw new Error(body.message ?? body.error ?? `sign failed (HTTP ${signRes.status})`);
        }
        const signed = (await signRes.json()) as SignResponse;

        setStatus({ phase: 'uploading', filename: file.name });
        const putRes = await fetch(signed.url, {
          method: 'PUT',
          headers: { 'Content-Type': mimeType },
          body: file,
        });
        if (!putRes.ok) {
          throw new Error(`upload to B2 failed (HTTP ${putRes.status})`);
        }

        setStatus({ phase: 'completing', filename: file.name });
        const completeRes = await fetch(`/api/pieces/${pieceId}/files/complete-upload`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            storageKey: signed.storageKey,
            filename: file.name,
            kind,
            mimeType,
            sizeBytes: file.size,
            label: label ?? undefined,
          }),
        });
        if (!completeRes.ok) {
          const body = (await completeRes.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `complete failed (HTTP ${completeRes.status})`);
        }
        const created = (await completeRes.json()) as PieceFile;

        setStatus({ phase: 'done', filename: file.name });
        // Clear after a beat so the UI can settle.
        setTimeout(() => setStatus({ phase: 'idle' }), 1500);
        return created;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        setStatus({ phase: 'error', filename: file.name, message });
        return null;
      }
    },
    [pieceId],
  );

  return { status, upload };
}

/** Convenience: pick the right `kind` from the File's MIME type. */
export function inferKind(file: File): 'pdf' | 'audio' | null {
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) return 'pdf';
  if (file.type.startsWith('audio/') || /\.(mp3|m4a|aac|ogg|wav|flac)$/i.test(file.name)) return 'audio';
  return null;
}
