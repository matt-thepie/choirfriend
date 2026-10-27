/**
 * Flowing scores: convert each uploaded editable score (MuseScore or
 * MusicXML) to cleaned MusicXML, which the browser engraves with Verovio to
 * fit whatever screen it's on.
 *
 * MuseScore itself does the conversion — its file format has no spec and
 * changes between versions, so nothing else reads it reliably. It is a
 * desktop app run headless, and it is heavy (~160 MB per run on a small
 * VPS), so conversions run one at a time through a single queue. They only
 * happen on upload/replace and once at startup for anything missed; reading
 * a score never runs MuseScore.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getConfig } from '../config.ts';
import { getFileRowById, type FileRow } from '../db/pieces.ts';
import {
  getRendition,
  markRenditionFailed,
  markRenditionPending,
  markRenditionReady,
  staleRenditionFileIds,
} from '../db/renditions.ts';
import { deleteObject, getObject, isB2Configured } from '../storage/b2.ts';
import { deleteLocalFile, readLocalFile, storeImportedFile } from '../import/storage.ts';
import { cleanMusicXml } from './musicxml.ts';

const TIMEOUT_MS = 180_000;
const MAC_APP = '/Applications/MuseScore 4.app/Contents/MacOS/mscore';

function mscoreCommand(): string {
  const configured = getConfig().mscoreCommand;
  if (configured) return configured;
  if (process.platform === 'darwin' && fs.existsSync(MAC_APP)) return MAC_APP;
  return 'mscore';
}

/** MuseScore's converter exits with its internal error code mod 256. */
function explainExit(code: number | string | null | undefined, stderr: string): string {
  if (code === 'ENOENT') return 'MuseScore is not installed on the server (set MSCORE_COMMAND).';
  if (code === 40) {
    return 'This file was saved in a newer MuseScore than the server has. Export it as MusicXML from MuseScore and upload that instead, or ask for the server copy to be updated.';
  }
  if (code === 30) return 'MuseScore could not read this file. It may be damaged, or not a score.';
  if (code === 'ETIMEDOUT' || code === null) return 'MuseScore took too long converting this score.';
  const last = stderr.trim().split('\n').filter(Boolean).pop();
  return `MuseScore failed (code ${String(code)})${last ? `: ${last.slice(0, 200)}` : ''}`;
}

function runMscore(input: string, output: string): Promise<void> {
  // MuseScore forces the xcb (X11) platform on Linux unless told otherwise
  // through its own variable; QT_QPA_PLATFORM alone is ignored.
  const env = process.platform === 'linux'
    ? { ...process.env, MU_QT_QPA_PLATFORM: 'offscreen', QT_QPA_PLATFORM: 'offscreen' }
    : process.env;
  return new Promise((resolve, reject) => {
    execFile(mscoreCommand(), ['-o', output, input], { env, timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, _out, stderr) => {
      if (!err) return resolve();
      const e = err as NodeJS.ErrnoException & { code?: number | string; killed?: boolean };
      reject(new Error(explainExit(e.killed ? 'ETIMEDOUT' : e.code, String(stderr ?? ''))));
    });
  });
}

async function readSource(row: FileRow): Promise<Uint8Array> {
  if (row.storage === 'local') return readLocalFile(row.storage_key);
  return getObject(row.storage_key);
}

async function removeStored(storage: 'b2' | 'local' | null, key: string | null): Promise<void> {
  if (!key) return;
  if (storage === 'b2' && isB2Configured()) await deleteObject(key);
  else if (storage === 'local') await deleteLocalFile(key);
}

async function convert(fileId: number): Promise<void> {
  const row = getFileRowById(fileId);
  if (!row || row.kind !== 'score') return;
  const previous = getRendition(fileId);
  markRenditionPending(fileId, row.storage_key);

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'choirfriend-score-'));
  try {
    const ext = path.extname(row.filename).toLowerCase() || '.mscz';
    const input = path.join(dir, `in${ext}`);
    const output = path.join(dir, 'out.musicxml');
    await fsp.writeFile(input, await readSource(row));
    let raw: string;
    try {
      await runMscore(input, output);
      raw = await fsp.readFile(output, 'utf8');
    } catch (err) {
      // Uncompressed MusicXML can still be shown without MuseScore.
      if ((ext === '.musicxml' || ext === '.xml') && /not installed/.test((err as Error).message)) {
        raw = await fsp.readFile(input, 'utf8');
      } else {
        throw err;
      }
    }
    const cleaned = cleanMusicXml(raw);
    const base = row.filename.replace(/\.[^.]+$/, '') || 'score';
    const bytes = Buffer.from(cleaned.xml, 'utf8');
    const stored = await storeImportedFile({
      pieceId: row.piece_id,
      bytes,
      filename: `${base}.xml`, // the stored-name sanitiser keeps extensions of up to 5 chars
      contentType: 'application/vnd.recordare.musicxml+xml',
    });
    // The score may have been replaced or deleted while MuseScore ran.
    const now = getFileRowById(fileId);
    if (!now || now.storage_key !== row.storage_key) {
      await removeStored(stored.storage, stored.storageKey);
      return;
    }
    markRenditionReady(fileId, stored.storage, stored.storageKey, bytes.length);
    if (previous?.storage_key && previous.storage_key !== stored.storageKey) {
      await removeStored(previous.storage, previous.storage_key);
    }
    console.log(
      `[scores] file ${fileId} converted` +
        (cleaned.duplicateLyrics ? `, ${cleaned.duplicateLyrics} duplicate lyrics removed` : '') +
        (cleaned.droppedParts.length ? `, empty parts dropped: ${cleaned.droppedParts.join(', ')}` : ''),
    );
  } catch (err) {
    const message = (err as Error).message;
    console.error(`[scores] file ${fileId} failed: ${message}`);
    markRenditionFailed(fileId, message);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

// --- One-at-a-time queue ----------------------------------------------------

let tail: Promise<void> = Promise.resolve();
const queued = new Set<number>();

/** Queue a score for conversion. A score already waiting isn't queued twice. */
export function queueRendition(fileId: number): void {
  const row = getFileRowById(fileId);
  if (!row || row.kind !== 'score') return;
  markRenditionPending(fileId, row.storage_key);
  if (queued.has(fileId)) return;
  queued.add(fileId);
  tail = tail.then(async () => {
    queued.delete(fileId);
    await convert(fileId);
  });
}

/** Startup: convert any score that has no up-to-date rendition. Failed ones
 *  are retried too, since a MuseScore update on the server may fix them. */
export function resumeRenditions(): void {
  const ids = staleRenditionFileIds();
  if (ids.length) console.log(`[scores] converting ${ids.length} score(s) in the background`);
  for (const id of ids) queueRendition(id);
}

/** When a score file is deleted: remove its MusicXML too. The row itself goes
 *  with the file (ON DELETE CASCADE), so read it first. */
export async function deleteRenditionFor(fileId: number): Promise<void> {
  const r = getRendition(fileId);
  if (r) await removeStored(r.storage, r.storage_key);
}
