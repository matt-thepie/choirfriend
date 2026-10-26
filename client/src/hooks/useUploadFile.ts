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
import type { FileKind, PieceFile } from './usePiece.ts';

export type UploadStatus =
  | { phase: 'idle' }
  | { phase: 'signing'; filename: string }
  | { phase: 'uploading'; filename: string }
  | { phase: 'completing'; filename: string }
  | { phase: 'done'; filename: string }
  | { phase: 'error'; filename: string; message: string };

export interface UseUploadFileResult {
  status: UploadStatus;
  upload: (file: File, kind: FileKind, label?: string) => Promise<PieceFile | null>;
}

interface SignResponse {
  url: string;
  storageKey: string;
  expiresIn: number;
}

export function useUploadFile(pieceId: number | null): UseUploadFileResult {
  const [status, setStatus] = useState<UploadStatus>({ phase: 'idle' });

  const upload = useCallback(
    async (file: File, kind: FileKind, label?: string): Promise<PieceFile | null> => {
      if (pieceId === null) return null;
      const mimeType = guessMime(file, kind);

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

/**
 * Replace an existing file's bytes in place: sign-replace → PUT to B2 →
 * complete-replace. The file keeps its id/label/kind so annotations stay
 * attached. Throws on failure; the caller manages its own busy/error UI.
 */
export async function replaceFile(fileId: number, file: File, kind: FileKind): Promise<PieceFile> {
  const mimeType = guessMime(file, kind);

  const signRes = await fetch(`/api/files/${fileId}/sign-replace`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ filename: file.name, mimeType, sizeBytes: file.size }),
  });
  if (!signRes.ok) {
    const body = (await signRes.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new Error(body.message ?? body.error ?? `sign failed (HTTP ${signRes.status})`);
  }
  const signed = (await signRes.json()) as SignResponse;

  const putRes = await fetch(signed.url, {
    method: 'PUT',
    headers: { 'Content-Type': mimeType },
    body: file,
  });
  if (!putRes.ok) throw new Error(`upload to B2 failed (HTTP ${putRes.status})`);

  const completeRes = await fetch(`/api/files/${fileId}/complete-replace`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ storageKey: signed.storageKey, filename: file.name, mimeType, sizeBytes: file.size }),
  });
  if (!completeRes.ok) {
    const body = (await completeRes.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `replace failed (HTTP ${completeRes.status})`);
  }
  return (await completeRes.json()) as PieceFile;
}

/** The browser leaves `type` empty for MuseScore/RTF/Markdown files; fill in
 *  something the server's allowlist recognises. */
function guessMime(file: File, kind: FileKind): string {
  if (file.type) return file.type;
  if (kind === 'pdf' || /\.pdf$/i.test(file.name)) return 'application/pdf';
  if (/\.docx$/i.test(file.name)) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (/\.rtf$/i.test(file.name)) return 'application/rtf';
  if (/\.txt$/i.test(file.name)) return 'text/plain';
  if (/\.md$/i.test(file.name)) return 'text/markdown';
  return 'application/octet-stream';
}

export const SCORE_EXT = /\.(mscz|mscx|musicxml|mxl)$/i;
export const LYRICS_EXT = /\.(docx?|rtf|txt|md|odt)$/i;

/** Accept string for the file picker, covering every kind an admin can add. */
export const UPLOAD_ACCEPT =
  'application/pdf,audio/*,.pdf,.mp3,.m4a,.aac,.ogg,.wav,.flac,.docx,.doc,.rtf,.txt,.md,.odt,.mscz,.mscx,.musicxml,.mxl';

/**
 * Best-guess kind from the picked file. A PDF is sheet music unless its name
 * says it's a lyric sheet; the upload panel lets the admin flip that before
 * sending.
 */
export function inferKind(file: File): FileKind | null {
  if (SCORE_EXT.test(file.name)) return 'score';
  if (LYRICS_EXT.test(file.name)) return 'lyrics';
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
    return /lyric|crib|words/i.test(file.name) ? 'lyrics' : 'pdf';
  }
  if (file.type.startsWith('audio/') || /\.(mp3|m4a|aac|ogg|wav|flac)$/i.test(file.name)) return 'audio';
  return null;
}
