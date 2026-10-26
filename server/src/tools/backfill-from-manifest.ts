/**
 * Second pass over a ChoirMate export after the main import: fills in the
 * things the files table didn't have a home for at the time.
 *
 *   node --env-file=../.env src/tools/backfill-from-manifest.ts <export dir> [--dry-run]
 *
 *   - audio duration_ms from the manifest's duration_ms
 *   - per-section remarks → piece_remarks
 *   - links → piece_links
 *
 * Uses <export>/.choirfriend-import.json to map ChoirMate ids to our ids.
 */
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../db/index.ts';
import { listSections } from '../db/sections.ts';
import { addLink, guessLinkType, listLinks, listRemarks, setRemark, type LinkType } from '../db/pieceExtras.ts';

const [, , dir, ...rest] = process.argv;
const dryRun = rest.includes('--dry-run');
if (!dir) {
  console.error('usage: backfill-from-manifest.ts <export dir> [--dry-run]');
  process.exit(2);
}

interface Manifest {
  songs: Array<{
    id: string;
    title: string;
    links?: Array<{ type?: string; url?: string; label?: string }>;
    remarks?: Record<string, { text?: string }>;
    audios: Array<{ id: string; duration_ms?: number; files: string[] }>;
  }>;
}
interface Progress { pieces: Record<string, number>; files: Record<string, number> }

const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as Manifest;
const progress = JSON.parse(fs.readFileSync(path.join(dir, '.choirfriend-import.json'), 'utf8')) as Progress;

const CM_SECTION_TO_LABEL: Record<string, string> = {
  'v:tenor_1': 'Tenor 1',
  'v:tenor_2': 'Tenor 2',
  'v:baritone': 'Baritone',
  'v:bass': 'Bass',
  musician: 'Musician',
};
const sectionIdByLabel = new Map(listSections().map((s) => [s.label.toLowerCase(), s.id]));

const setDuration = db.prepare(`UPDATE files SET duration_ms = ? WHERE id = ? AND duration_ms IS NULL`);
const pieceExists = db.prepare(`SELECT 1 FROM pieces WHERE id = ?`);

let durations = 0, remarks = 0, links = 0, skipped = 0;
for (const song of manifest.songs) {
  const pieceId = progress.pieces[song.id];
  if (pieceId === undefined || !pieceExists.get(pieceId)) { skipped++; continue; }

  for (const a of song.audios) {
    if (!a.duration_ms || a.duration_ms <= 0) continue;
    const ids = a.files.length === 1 ? [progress.files[a.id]] : a.files.map((f) => progress.files[`${a.id}:${f}`]);
    for (const fid of ids) {
      if (fid === undefined) continue;
      if (!dryRun) setDuration.run(Math.round(a.duration_ms), fid);
      durations++;
    }
  }

  const existingRemarks = new Set(listRemarks(pieceId).map((r) => r.sectionId));
  for (const [sec, r] of Object.entries(song.remarks ?? {})) {
    const text = r.text?.trim();
    const label = CM_SECTION_TO_LABEL[sec];
    const sectionId = label ? sectionIdByLabel.get(label.toLowerCase()) : undefined;
    if (!text || sectionId === undefined || existingRemarks.has(sectionId)) continue;
    console.log(`remark #${pieceId} ${song.title} [${label}]: ${text.slice(0, 60)}`);
    if (!dryRun) setRemark(pieceId, sectionId, text, null);
    remarks++;
  }

  const existingUrls = new Set(listLinks(pieceId).map((l) => l.url));
  for (const l of song.links ?? []) {
    const url = l.url?.trim();
    if (!url || existingUrls.has(url)) continue;
    const type = (['spotify', 'youtube', 'appleMusic', 'other'] as LinkType[]).includes(l.type as LinkType) ? (l.type as LinkType) : guessLinkType(url);
    console.log(`link #${pieceId} ${song.title}: ${type} ${url}`);
    if (!dryRun) addLink(pieceId, type, url, l.label?.trim() || null);
    links++;
  }
}
console.log(`${dryRun ? 'would set' : 'set'} ${durations} durations, ${remarks} remarks, ${links} links; ${skipped} songs not in progress file`);
