/**
 * File upload endpoints.
 *
 * The flow is the standard "presign + complete":
 *   1. Client POSTs file metadata to /pieces/:id/files/sign-upload.
 *      Server returns a presigned PUT URL pointing at B2.
 *   2. Client PUTs the file bytes directly to B2 (never through us — keeps
 *      the API free of multipart, large bodies, timeouts, etc.).
 *   3. Client POSTs to /pieces/:id/files/complete-upload to create the row.
 *
 * If the client fails between (1) and (3) we leak an object in B2; B2's
 * lifecycle rules can clean those up. The DB is the source of truth for
 * what files actually exist as far as choirfriend is concerned.
 */

import type { FastifyPluginAsync } from 'fastify';
import {
  createFile,
  deleteFileRow,
  getFileRowById,
  getPieceWithFiles,
  isFileKind,
  replaceFileStorage,
  updateFile,
  type FileKind,
} from '../db/pieces.ts';
import { requireAdmin } from '../auth/middleware.ts';
import { guessSectionId, sectionExists } from '../db/sections.ts';
import { deleteObject, isB2Configured, presignPut } from '../storage/b2.ts';
import { deleteLocalFile, readableStoredName } from '../import/storage.ts';

/**
 * Strict MIME allowlist by kind. Server is the source of truth — the client
 * can claim any Content-Type but we refuse to *sign* a URL for anything
 * outside this set, so an attacker can't upload an image as a "PDF" and
 * smuggle bytes into the bucket. Defence in depth alongside the role gate.
 */
const ALLOWED_PDF_MIME = new Set(['application/pdf']);
const ALLOWED_AUDIO_MIME = new Set([
  'audio/mpeg', // .mp3
  'audio/mp3',
  'audio/mp4', // .m4a (often), .mp4
  'audio/aac',
  'audio/x-m4a',
  'audio/ogg',
  'audio/opus',
  'audio/wav',
  'audio/wave',
  'audio/x-wav',
  'audio/flac',
  'audio/x-flac',
  'audio/webm',
]);

/** Lyrics: "any reasonable text format". Browsers often report an empty or
 *  generic type for .rtf/.md/.odt, so the extension is accepted as well. */
const ALLOWED_LYRICS_MIME = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  'application/msword', // .doc
  'application/rtf',
  'text/rtf',
  'text/plain',
  'text/markdown',
  'application/vnd.oasis.opendocument.text', // .odt
]);
const LYRICS_EXT = /\.(pdf|docx?|rtf|txt|md|odt)$/i;
/** Editable notation: MuseScore and MusicXML. MIME types for these are all
 *  over the place (often application/octet-stream or a zip type), so the
 *  extension is what we trust. */
const SCORE_EXT = /\.(mscz|mscx|musicxml|mxl)$/i;

function mimeMatchesKind(kind: FileKind, mimeType: string, filename: string): boolean {
  const m = mimeType.toLowerCase();
  switch (kind) {
    case 'pdf':
      return ALLOWED_PDF_MIME.has(m);
    case 'audio':
      return ALLOWED_AUDIO_MIME.has(m);
    case 'lyrics':
      return ALLOWED_LYRICS_MIME.has(m) || LYRICS_EXT.test(filename);
    case 'score':
      return SCORE_EXT.test(filename);
  }
}

interface SignUploadBody {
  filename: string;
  kind: FileKind;
  mimeType: string;
  sizeBytes?: number;
  /** Optional label for audio parts (e.g. "Tenor 1"). */
  label?: string;
}

interface CompleteUploadBody {
  /** Voice part for audio. Omit to let the server guess from label/filename. */
  sectionId?: number | null;
  storageKey: string;
  filename: string;
  kind: FileKind;
  mimeType: string;
  sizeBytes?: number;
  label?: string;
  sortOrder?: number;
  /** Measured in the browser for audio. */
  durationMs?: number | null;
}

/** Max file size we'll accept a sign for. Large enough for ~25min audio
 *  at sensible bitrate; sheet music PDFs are far smaller. Hard-coded for
 *  now; can become a config knob later. */
const MAX_FILE_BYTES = 200 * 1024 * 1024;

export const filesRoutes: FastifyPluginAsync = async (app) => {
  /** Returns a presigned PUT URL the browser will upload directly to B2.
   *  Admin-only so a random signed-in member can't smuggle bytes into the
   *  shared B2 bucket. */
  app.post<{ Params: { id: string }; Body: SignUploadBody }>(
    '/pieces/:id/files/sign-upload',
    { preHandler: requireAdmin },
    async (req, reply) => {
      if (!isB2Configured()) {
        return reply.code(503).send({
          error: 'b2_not_configured',
          message:
            'Backblaze B2 is not configured. Set B2_KEY_ID, B2_APPLICATION_KEY, B2_BUCKET, B2_ENDPOINT, B2_REGION.',
        });
      }

      const pieceId = Number(req.params.id);
      if (!Number.isFinite(pieceId)) return reply.code(400).send({ error: 'invalid piece id' });

      const piece = getPieceWithFiles(pieceId);
      if (!piece) return reply.code(404).send({ error: 'piece not found' });

      const body = req.body;
      if (
        !body ||
        typeof body.filename !== 'string' ||
        !isFileKind(body.kind) ||
        typeof body.mimeType !== 'string'
      ) {
        return reply.code(400).send({ error: 'invalid payload' });
      }
      if (!mimeMatchesKind(body.kind, body.mimeType, body.filename)) {
        return reply.code(415).send({
          error: 'unsupported_media_type',
          message: `${body.mimeType} (${body.filename}) is not allowed for kind=${body.kind}`,
        });
      }
      if (body.sizeBytes !== undefined && (typeof body.sizeBytes !== 'number' || body.sizeBytes > MAX_FILE_BYTES)) {
        return reply.code(413).send({ error: 'file too large' });
      }

      // Readable filename, with uniqueness from a short random subfolder (keeps
      // the name legible while still collision-proof and hard to guess).
      const storageKey = `pieces/${pieceId}/files/${readableStoredName(body.filename)}`;
      const signed = await presignPut({
        storageKey,
        contentType: body.mimeType,
      });

      return signed;
    },
  );

  /** After the browser's PUT to B2 succeeds, create the row in our DB.
   *  Same admin gate as sign-upload so we can't be tricked into creating
   *  a DB row that references an orphan some attacker dropped into B2. */
  app.post<{ Params: { id: string }; Body: CompleteUploadBody }>(
    '/pieces/:id/files/complete-upload',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const pieceId = Number(req.params.id);
      if (!Number.isFinite(pieceId)) return reply.code(400).send({ error: 'invalid piece id' });

      const piece = getPieceWithFiles(pieceId);
      if (!piece) return reply.code(404).send({ error: 'piece not found' });

      const body = req.body;
      if (
        !body ||
        typeof body.storageKey !== 'string' ||
        typeof body.filename !== 'string' ||
        !isFileKind(body.kind) ||
        typeof body.mimeType !== 'string'
      ) {
        return reply.code(400).send({ error: 'invalid payload' });
      }
      if (!mimeMatchesKind(body.kind, body.mimeType, body.filename)) {
        return reply.code(415).send({ error: 'unsupported_media_type' });
      }

      // Sanity: the storage key has to be in this piece's namespace.
      if (!body.storageKey.startsWith(`pieces/${pieceId}/files/`)) {
        return reply.code(400).send({ error: 'storage key outside piece namespace' });
      }

      const fileDto = createFile({
        pieceId,
        kind: body.kind,
        label: body.label ?? null,
        sectionId:
          body.kind === 'audio'
            ? (Number.isInteger(body.sectionId) && sectionExists(body.sectionId as number)
                ? (body.sectionId as number)
                : guessSectionId(body.label) ?? guessSectionId(body.filename))
            : null,
        storage: 'b2',
        storageKey: body.storageKey,
        filename: body.filename,
        mimeType: body.mimeType,
        sizeBytes: body.sizeBytes ?? null,
        sortOrder: body.sortOrder ?? 0,
        durationMs: body.kind === 'audio' && Number.isFinite(body.durationMs) && (body.durationMs as number) > 0 ? Math.round(body.durationMs as number) : null,
        // requireAdmin guarantees req.user is set.
        createdByUserId: req.user!.internalId,
      });
      return reply.code(201).send(fileDto);
    },
  );

  /**
   * Rename a file's label (admin) — e.g. an imported track from "Tenor 1" to
   * "Tenor 1 (with piano)". Send { label: string } or { label: null } to clear.
   */
  app.patch<{ Params: { id: string }; Body: { label?: string | null; sectionId?: number | null; kind?: FileKind; durationMs?: number | null } }>(
    '/files/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return reply.code(400).send({ error: 'invalid file id' });
      const body = req.body ?? {};
      const patch: { label?: string | null; sectionId?: number | null; kind?: FileKind; durationMs?: number | null } = {};
      if ('durationMs' in body) {
        const d = body.durationMs;
        if (d !== null && (typeof d !== 'number' || !Number.isFinite(d) || d <= 0)) {
          return reply.code(400).send({ error: 'durationMs must be a positive number or null' });
        }
        patch.durationMs = d === null ? null : Math.round(d);
      }
      if ('kind' in body) {
        // Re-filing is only allowed between the two document kinds — a PDF that
        // was uploaded as sheet music but is really a lyric sheet, or vice
        // versa. Audio and scores can't become something else.
        const row = getFileRowById(id);
        if (!row) return reply.code(404).send({ error: 'not found' });
        const docKinds: FileKind[] = ['pdf', 'lyrics'];
        if (!isFileKind(body.kind) || !docKinds.includes(body.kind) || !docKinds.includes(row.kind)) {
          return reply.code(400).send({ error: 'kind can only change between pdf and lyrics' });
        }
        if (body.kind === 'pdf' && !ALLOWED_PDF_MIME.has((row.mime_type ?? '').toLowerCase()) && !/\.pdf$/i.test(row.filename)) {
          return reply.code(400).send({ error: 'only a PDF can be filed as sheet music' });
        }
        patch.kind = body.kind;
      }
      if ('label' in body) {
        const raw = body.label;
        if (raw !== null && typeof raw !== 'string') {
          return reply.code(400).send({ error: 'label must be a string or null' });
        }
        patch.label = typeof raw === 'string' ? raw.trim() || null : null;
      }
      if ('sectionId' in body) {
        const sid = body.sectionId;
        if (sid !== null && (!Number.isInteger(sid) || !sectionExists(sid as number))) {
          return reply.code(400).send({ error: 'unknown section' });
        }
        patch.sectionId = sid as number | null;
      }
      const updated = updateFile(id, patch);
      if (!updated) return reply.code(404).send({ error: 'not found' });
      return updated;
    },
  );

  /**
   * Replace a file's bytes in place (admin) — e.g. a corrected score or a
   * re-recorded track. The DB row keeps its id, kind, label and sort order, so
   * existing annotations stay attached. Same presign + complete shape as a
   * fresh upload, but the kind is fixed to the existing file's kind.
   */
  app.post<{ Params: { id: string }; Body: { filename: string; mimeType: string; sizeBytes?: number } }>(
    '/files/:id/sign-replace',
    { preHandler: requireAdmin },
    async (req, reply) => {
      if (!isB2Configured()) {
        return reply.code(503).send({
          error: 'b2_not_configured',
          message:
            'Backblaze B2 is not configured. Set B2_KEY_ID, B2_APPLICATION_KEY, B2_BUCKET, B2_ENDPOINT, B2_REGION.',
        });
      }

      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return reply.code(400).send({ error: 'invalid file id' });

      const row = getFileRowById(id);
      if (!row) return reply.code(404).send({ error: 'not found' });

      const body = req.body;
      if (!body || typeof body.filename !== 'string' || typeof body.mimeType !== 'string') {
        return reply.code(400).send({ error: 'invalid payload' });
      }
      // The replacement must be the same kind as the original — you can't turn
      // a score PDF into an audio track and keep its annotations.
      if (!mimeMatchesKind(row.kind, body.mimeType, body.filename)) {
        return reply.code(415).send({
          error: 'unsupported_media_type',
          message: `${body.mimeType} is not allowed for kind=${row.kind}`,
        });
      }
      if (body.sizeBytes !== undefined && (typeof body.sizeBytes !== 'number' || body.sizeBytes > MAX_FILE_BYTES)) {
        return reply.code(413).send({ error: 'file too large' });
      }

      const storageKey = `pieces/${row.piece_id}/files/${readableStoredName(body.filename)}`;
      const signed = await presignPut({ storageKey, contentType: body.mimeType });
      return signed;
    },
  );

  /** After the browser PUTs the replacement bytes to B2, point the row at the
   *  new object and best-effort delete the old one. */
  app.post<{ Params: { id: string }; Body: { storageKey: string; filename: string; mimeType: string; sizeBytes?: number } }>(
    '/files/:id/complete-replace',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return reply.code(400).send({ error: 'invalid file id' });

      const row = getFileRowById(id);
      if (!row) return reply.code(404).send({ error: 'not found' });

      const body = req.body;
      if (
        !body ||
        typeof body.storageKey !== 'string' ||
        typeof body.filename !== 'string' ||
        typeof body.mimeType !== 'string'
      ) {
        return reply.code(400).send({ error: 'invalid payload' });
      }
      if (!mimeMatchesKind(row.kind, body.mimeType, body.filename)) {
        return reply.code(415).send({ error: 'unsupported_media_type' });
      }
      if (!body.storageKey.startsWith(`pieces/${row.piece_id}/files/`)) {
        return reply.code(400).send({ error: 'storage key outside piece namespace' });
      }

      // Remember where the old bytes lived so we can clean them up once the row
      // points at the new object.
      const oldStorage = row.storage;
      const oldKey = row.storage_key;

      const updated = replaceFileStorage(id, {
        storage: 'b2',
        storageKey: body.storageKey,
        filename: body.filename,
        mimeType: body.mimeType,
        sizeBytes: body.sizeBytes ?? null,
        createdByUserId: req.user!.internalId,
      });
      if (!updated) return reply.code(404).send({ error: 'not found' });

      if (oldKey !== body.storageKey) {
        if (oldStorage === 'b2' && isB2Configured()) {
          await deleteObject(oldKey);
        } else if (oldStorage === 'local') {
          await deleteLocalFile(oldKey);
        }
      }
      return updated;
    },
  );

  /**
   * Delete a file (admin). The stored object is best-effort removed alongside
   * the DB row — from B2 if that's where it lives, or from client/public for an
   * imported local file. The seeded sample (local, not under imported/) is left
   * on disk by deleteLocalFile, but its row can still be removed.
   */
  app.delete<{ Params: { fileId: string } }>(
    '/files/:fileId',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const id = Number(req.params.fileId);
      if (!Number.isFinite(id)) return reply.code(400).send({ error: 'invalid file id' });

      const row = getFileRowById(id);
      if (!row) return reply.code(404).send({ error: 'not found' });

      // Remove the DB row first so a failed object delete doesn't strand an
      // unreferenced file. Both object deletes are best-effort.
      deleteFileRow(id);
      if (row.storage === 'b2' && isB2Configured()) {
        await deleteObject(row.storage_key);
      } else if (row.storage === 'local') {
        await deleteLocalFile(row.storage_key);
      }
      return reply.code(204).send();
    },
  );
};
