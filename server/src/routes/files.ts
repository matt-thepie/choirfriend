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

import crypto from 'node:crypto';
import path from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import {
  createFile,
  deleteFileRow,
  getFileRowById,
  getPieceWithFiles,
} from '../db/pieces.ts';
import { requireAdmin } from '../auth/middleware.ts';
import { deleteObject, isB2Configured, presignPut } from '../storage/b2.ts';

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

function mimeMatchesKind(kind: 'pdf' | 'audio', mimeType: string): boolean {
  const m = mimeType.toLowerCase();
  if (kind === 'pdf') return ALLOWED_PDF_MIME.has(m);
  return ALLOWED_AUDIO_MIME.has(m);
}

interface SignUploadBody {
  filename: string;
  kind: 'pdf' | 'audio';
  mimeType: string;
  sizeBytes?: number;
  /** Optional label for audio parts (e.g. "Tenor 1"). */
  label?: string;
}

interface CompleteUploadBody {
  storageKey: string;
  filename: string;
  kind: 'pdf' | 'audio';
  mimeType: string;
  sizeBytes?: number;
  label?: string;
  sortOrder?: number;
}

/** Max file size we'll accept a sign for. Large enough for ~25min audio
 *  at sensible bitrate; sheet music PDFs are far smaller. Hard-coded for
 *  now; can become a config knob later. */
const MAX_FILE_BYTES = 200 * 1024 * 1024;

function sanitiseExt(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  // Strip anything weird. Two-letter to five-letter alphanumeric only.
  if (!/^\.[a-z0-9]{1,5}$/.test(ext)) return '';
  return ext;
}

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
        (body.kind !== 'pdf' && body.kind !== 'audio') ||
        typeof body.mimeType !== 'string'
      ) {
        return reply.code(400).send({ error: 'invalid payload' });
      }
      if (!mimeMatchesKind(body.kind, body.mimeType)) {
        return reply.code(415).send({
          error: 'unsupported_media_type',
          message: `${body.mimeType} is not allowed for kind=${body.kind}`,
        });
      }
      if (body.sizeBytes !== undefined && (typeof body.sizeBytes !== 'number' || body.sizeBytes > MAX_FILE_BYTES)) {
        return reply.code(413).send({ error: 'file too large' });
      }

      const ext = sanitiseExt(body.filename);
      // Random UUID keeps keys unguessable, avoids collisions, and lets the
      // client retry without needing a new key.
      const storageKey = `pieces/${pieceId}/files/${crypto.randomUUID()}${ext}`;
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
        (body.kind !== 'pdf' && body.kind !== 'audio') ||
        typeof body.mimeType !== 'string'
      ) {
        return reply.code(400).send({ error: 'invalid payload' });
      }
      if (!mimeMatchesKind(body.kind, body.mimeType)) {
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
        storage: 'b2',
        storageKey: body.storageKey,
        filename: body.filename,
        mimeType: body.mimeType,
        sizeBytes: body.sizeBytes ?? null,
        sortOrder: body.sortOrder ?? 0,
      });
      return reply.code(201).send(fileDto);
    },
  );

  /**
   * Delete a file. Admin-only — ordinary members shouldn't be able to
   * remove the MD's uploaded score. The B2 object is best-effort deleted
   * alongside. Local-storage files (the seeded sample) can't be removed
   * via this API.
   */
  app.delete<{ Params: { fileId: string } }>(
    '/files/:fileId',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const id = Number(req.params.fileId);
      if (!Number.isFinite(id)) return reply.code(400).send({ error: 'invalid file id' });

      const row = getFileRowById(id);
      if (!row) return reply.code(404).send({ error: 'not found' });

      if (row.storage === 'local') {
        return reply.code(403).send({ error: 'cannot delete local/seeded files via API' });
      }

      // Remove the DB row first so a failed B2 delete doesn't strand an
      // unreferenced file. The B2 delete is best-effort and just logs on
      // failure (see storage/b2.ts).
      deleteFileRow(id);
      if (row.storage === 'b2' && isB2Configured()) {
        await deleteObject(row.storage_key);
      }
      return reply.code(204).send();
    },
  );
};
