/**
 * One-off ChoirMate migration importer.
 *
 * Reads the manifest.json produced by the ChoirMate scrape (plus the files it
 * references, laid out as <export>/<song folder>/<file>) and loads everything
 * into choirfriend: pieces, PDFs and lyric sheets, audio tagged with its voice
 * part and duration, section remarks, links, and the set lists. Files go to B2 (or client/public when B2 isn't
 * configured, same as the bulk importer).
 *
 *   node --env-file=../.env src/import/choirmate.ts <export dir> [--dry-run] [--limit N]
 *
 * Resumable: progress is written to <export dir>/.choirfriend-import.json
 * after every file, keyed by ChoirMate ids, so a re-run skips what's done.
 * A re-run also fills in durations, remarks and links that are missing from
 * pieces imported earlier, without overwriting anything already there.
 *
 * Choices (see README "ChoirMate migration"):
 *  - songs whose titles match case/punctuation-insensitively are merged into
 *    one piece; near-misses are only reported
 *  - ChoirMate's free-text "artist" lands in `composer` verbatim
 *  - songs on the "Rehearsal" set list are current repertoire, the rest are
 *    archived (is_current = 0)
 *  - Word documents and lyric-named PDFs are filed as lyrics
 *  - remarks for a voice part go to that part's remark; remarks for a part we
 *    don't have go into the piece notes
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { db } from '../db/index.ts';
import { createFile, createPiece, listPieces, updatePiece, type FileKind } from '../db/pieces.ts';
import { listSections, seedSectionsIfEmpty } from '../db/sections.ts';
import { addLink, guessLinkType, listLinks, listRemarks, setRemark, type LinkType } from '../db/pieceExtras.ts';
import { createSetList, listSetLists } from '../db/setlists.ts';
import { storeImportedFile, storageMode } from './storage.ts';

// ---- manifest shape (only what we use) ------------------------------------

interface CmSheet { id: string; label: string | null; type: string; bytes?: number; created_at?: string; file: string }
interface CmAudio {
  id: string;
  name: string | null;
  sections: string[];
  visibility: string;
  duration_ms?: number;
  created_at?: string;
  uploaded_by?: { nickname?: string } | null;
  notes?: string | null;
  files: string[];
}
interface CmRemark { text?: string; updated_by?: { first_name?: string; last_name?: string } | null }
interface CmSong {
  id: string;
  title: string;
  artist: string | null;
  created_at?: string;
  created_by?: string;
  links: Array<{ type?: string; url?: string; label?: string }>;
  remarks: Record<string, CmRemark>;
  sheet_music: CmSheet[];
  audios: CmAudio[];
}
interface CmSetListItem { id: string; rank: number; title: string }
interface Manifest { exported_at: string; songs: CmSong[]; setlists: Record<string, CmSetListItem[]> }

interface Progress {
  /** ChoirMate song id → choirfriend piece id */
  pieces: Record<string, number>;
  /** ChoirMate sheet/audio id → choirfriend file id */
  files: Record<string, number>;
  setlists: Record<string, number>;
}

// ---- helpers --------------------------------------------------------------

const CM_SECTION_TO_LABEL: Record<string, string> = {
  'v:tenor_1': 'Tenor 1',
  'v:tenor_2': 'Tenor 2',
  'v:baritone': 'Baritone',
  'v:bass': 'Bass',
  musician: 'Musician',
};

function normTitle(t: string): string {
  return t.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
}

function epoch(iso: string | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function mimeFor(file: string): string {
  const ext = path.extname(file).toLowerCase();
  return (
    { '.pdf': 'application/pdf', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.flac': 'audio/flac' }[ext] ??
    'application/octet-stream'
  );
}

/** Lyric sheets after proper scores, so the viewer opens the music first. */
function sheetSortKey(label: string | null, file: string): number {
  const s = `${label ?? ''} ${path.basename(file)}`.toLowerCase();
  if (/lyric|words|crib/.test(s)) return 10;
  return 0;
}

function sectionLabelFor(cm: string[]): string | null {
  return cm.length === 1 ? (CM_SECTION_TO_LABEL[cm[0]!] ?? null) : null;
}

const LINK_TYPES: LinkType[] = ['spotify', 'youtube', 'appleMusic', 'other'];

// ---- main -----------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith('--'));
  if (!dir) {
    console.error('usage: choirmate.ts <export dir> [--dry-run] [--limit N]');
    process.exit(2);
  }
  const dryRun = args.includes('--dry-run');
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : Infinity;

  const manifest = JSON.parse(await fsp.readFile(path.join(dir, 'manifest.json'), 'utf8')) as Manifest;
  const progressPath = path.join(dir, '.choirfriend-import.json');
  const progress: Progress = fs.existsSync(progressPath)
    ? (JSON.parse(await fsp.readFile(progressPath, 'utf8')) as Progress)
    : { pieces: {}, files: {}, setlists: {} };
  const save = async () => {
    if (!dryRun) await fsp.writeFile(progressPath, JSON.stringify(progress, null, 2));
  };

  seedSectionsIfEmpty();
  const sectionIdByLabel = new Map(listSections().map((s) => [s.label, s.id]));

  console.log(`storage: ${storageMode()}${dryRun ? ' (DRY RUN — nothing written)' : ''}`);
  console.log(`manifest: ${manifest.songs.length} songs exported ${manifest.exported_at}`);

  // -- 1. group songs by normalised title -----------------------------------
  const groups = new Map<string, CmSong[]>();
  for (const s of manifest.songs) {
    const k = normTitle(s.title);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(s);
  }
  const merged = [...groups.values()].filter((g) => g.length > 1);
  for (const g of merged) console.log(`merge: ${g.map((s) => JSON.stringify(s.title)).join(' + ')}`);

  // Near-duplicates: report only.
  const keys = [...groups.keys()];
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const a = keys[i]!, b = keys[j]!;
      if (a.length >= 6 && b.length >= 6 && (a.includes(b) || b.includes(a))) {
        console.log(`possible duplicate (not merged): ${JSON.stringify(groups.get(a)![0]!.title)} ~ ${JSON.stringify(groups.get(b)![0]!.title)}`);
      }
    }
  }

  // Set list membership decides is_current.
  const rehearsalIds = new Set((manifest.setlists['Rehearsal'] ?? []).map((i) => i.id));
  // Some set list items carry a song id that is not in songs[] (ChoirMate
  // re-created the song), so also match by normalised title.
  const rehearsalKeys = new Set((manifest.setlists['Rehearsal'] ?? []).map((i) => normTitle(i.title)));
  const pieceByKey = new Map<string, number>();

  // Existing pieces, for matching by title (e.g. "One Day Like This" already there).
  const existingByTitle = new Map(listPieces().map((p) => [normTitle(p.title), p.id]));

  // -- 2. pieces + files -----------------------------------------------------
  const missing: string[] = [];
  const dirCache = new Map<string, Map<string, string>>();
  let pieceCount = 0, fileCount = 0, bytes = 0, remarkCount = 0, linkCount = 0, durationCount = 0;
  const fillDuration = db.prepare('UPDATE files SET duration_ms = ? WHERE id = ? AND duration_ms IS NULL');
  let processed = 0;

  for (const [key, songs] of groups) {
    if (processed >= limit) break;
    processed++;

    // Prefer the title spelling that is on the rehearsal list, else the first.
    const primary = songs.find((s) => rehearsalIds.has(s.id)) ?? songs[0]!;
    const isCurrent = songs.some((s) => rehearsalIds.has(s.id)) || rehearsalKeys.has(key);
    const composer = songs.map((s) => s.artist?.trim()).find(Boolean) ?? null;
    const createdAt = Math.min(...songs.map((s) => epoch(s.created_at) ?? Number.MAX_SAFE_INTEGER));

    // Remarks for one of our voice parts become that part's remark; anything
    // else (a ChoirMate section we have no equivalent for) goes into notes.
    const remarks: Array<{ sectionId: number; label: string; text: string }> = [];
    const noteLines: string[] = [];
    for (const s of songs) {
      for (const [sec, r] of Object.entries(s.remarks ?? {})) {
        const text = r.text?.trim();
        if (!text) continue;
        const label = CM_SECTION_TO_LABEL[sec];
        const sectionId = label ? sectionIdByLabel.get(label) : undefined;
        if (label && sectionId !== undefined) {
          remarks.push({ sectionId, label, text });
        } else {
          const who = [r.updated_by?.first_name, r.updated_by?.last_name].filter(Boolean).join(' ');
          noteLines.push(`${label ?? sec} remark${who ? ` (${who})` : ''}: ${text}`);
        }
      }
    }
    const notes = noteLines.length ? noteLines.join('\n') : null;

    // Resolve piece id: progress → existing by title → create.
    let pieceId: number | undefined = songs.map((s) => progress.pieces[s.id]).find((v) => v !== undefined) ?? existingByTitle.get(key);
    if (pieceId === undefined) {
      if (dryRun) {
        pieceId = -1;
      } else {
        const p = createPiece({ title: primary.title.trim(), composer, notes });
        pieceId = p.id;
        updatePiece(pieceId, { isCurrent });
        if (Number.isFinite(createdAt) && createdAt !== Number.MAX_SAFE_INTEGER) {
          db.prepare('UPDATE pieces SET created_at = ?, updated_at = ? WHERE id = ?').run(createdAt, createdAt, pieceId);
        }
      }
      pieceCount++;
    } else if (!dryRun) {

      // Matched an existing piece: fill in blanks only, never overwrite.
      const row = db.prepare('SELECT composer, notes FROM pieces WHERE id = ?').get(pieceId) as { composer: string | null; notes: string | null } | undefined;
      if (row) {
        const patch: { composer?: string | null; notes?: string | null; isCurrent?: boolean } = {};
        if (!row.composer && composer) patch.composer = composer;
        if (!row.notes && notes) patch.notes = notes;
        if (isCurrent) patch.isCurrent = true;
        if (Object.keys(patch).length) updatePiece(pieceId, patch);
      }
    }
    for (const s of songs) progress.pieces[s.id] = pieceId;
    pieceByKey.set(key, pieceId);
    await save();

    console.log(`\n[${pieceId}] ${primary.title}${composer ? ` — ${composer}` : ''}${isCurrent ? ' (current)' : ''}${songs.length > 1 ? ` [merged ${songs.length}]` : ''}`);

    // Remarks and links: add what the piece doesn't have yet.
    const haveRemarks = new Set(pieceId > 0 ? listRemarks(pieceId).map((r) => r.sectionId) : []);
    for (const r of remarks) {
      if (haveRemarks.has(r.sectionId)) continue;
      haveRemarks.add(r.sectionId);
      console.log(`  + remark [${r.label}] ${r.text.slice(0, 60)}`);
      remarkCount++;
      if (!dryRun) setRemark(pieceId, r.sectionId, r.text, null);
    }
    const haveUrls = new Set(pieceId > 0 ? listLinks(pieceId).map((l) => l.url) : []);
    for (const l of songs.flatMap((s) => s.links ?? [])) {
      const url = l.url?.trim();
      if (!url || haveUrls.has(url)) continue;
      haveUrls.add(url);
      const type = LINK_TYPES.includes(l.type as LinkType) ? (l.type as LinkType) : guessLinkType(url);
      console.log(`  + link ${type} ${url}`);
      linkCount++;
      if (!dryRun) addLink(pieceId, type, url, l.label?.trim() || null);
    }

    // Sheet music: all songs in the group, scores before lyric sheets.
    const sheets = songs
      .flatMap((s) => s.sheet_music)
      .map((sm, i) => ({ sm, i, sort: sheetSortKey(sm.label, sm.file) }))
      .sort((a, b) => a.sort - b.sort || a.i - b.i);
    let sortOrder = 0;
    for (const { sm } of sheets) {
      const ext = path.extname(sm.file).toLowerCase();
      // ChoirMate lumps lyric sheets in with sheet music. Word documents are
      // always lyrics/cribs; a PDF is lyrics when its name says so.
      const isLyrics = ext === '.docx' || ext === '.doc' || ext === '.rtf' || ext === '.txt'
        || /lyric|crib|words/i.test(`${sm.label ?? ''} ${path.basename(sm.file)}`);
      if (ext !== '.pdf' && !isLyrics) {
        console.log(`  skip unsupported sheet: ${sm.file}`);
        continue;
      }
      await importFile({
        cmId: sm.id,
        pieceId,
        kind: isLyrics ? 'lyrics' : 'pdf',
        label: sm.label?.trim() || null,
        sectionId: null,
        relPath: sm.file,
        createdAt: epoch(sm.created_at),
        sortOrder: sortOrder++,
      });
    }

    // Audio: ChoirMate order (date created) within the group.
    const audios = songs.flatMap((s) => s.audios).sort((a, b) => (epoch(a.created_at) ?? 0) - (epoch(b.created_at) ?? 0));
    sortOrder = 0;
    for (const a of audios) {
      const label = sectionLabelFor(a.sections);
      const sectionId = label ? (sectionIdByLabel.get(label) ?? null) : null;
      for (const f of a.files) {
        await importFile({
          cmId: a.files.length === 1 ? a.id : `${a.id}:${f}`,
          pieceId,
          kind: 'audio',
          label: a.name?.trim() || null,
          sectionId,
          relPath: f,
          createdAt: epoch(a.created_at),
          sortOrder: sortOrder++,
          durationMs: a.duration_ms && a.duration_ms > 0 ? Math.round(a.duration_ms) : null,
        });
      }
    }
  }

  // The manifest's folder/file casing came from a case-insensitive macOS disk
  // and does not always match what is on a Linux filesystem.
  function resolveCaseInsensitive(root: string, rel: string): string {
    let cur = root;
    for (const part of rel.split('/')) {
      const direct = path.join(cur, part);
      if (fs.existsSync(direct)) { cur = direct; continue; }
      let names = dirCache.get(cur);
      if (!names) {
        names = new Map();
        try { for (const n of fs.readdirSync(cur)) names.set(n.toLowerCase(), n); } catch { /* fall through */ }
        dirCache.set(cur, names);
      }
      cur = path.join(cur, names.get(part.toLowerCase()) ?? part);
    }
    return cur;
  }

  async function importFile(opts: {
    cmId: string;
    pieceId: number;
    kind: FileKind;
    label: string | null;
    sectionId: number | null;
    relPath: string;
    createdAt: number | null;
    sortOrder: number;
    durationMs?: number | null;
  }): Promise<void> {
    const done = progress.files[opts.cmId];
    if (done !== undefined) {
      console.log(`  = ${opts.kind} ${path.basename(opts.relPath)} (already imported as #${done})`);
      // Imports from before durations were copied over: fill the gap.
      if (opts.durationMs && !dryRun && fillDuration.run(opts.durationMs, done).changes) durationCount++;
      return;
    }
    const abs = resolveCaseInsensitive(dir!, opts.relPath);
    let stat: fs.Stats;
    try {
      stat = await fsp.stat(abs);
    } catch {
      missing.push(opts.relPath);
      console.log(`  ! missing ${opts.relPath}`);
      return;
    }
    const sec = opts.sectionId ? ` [${[...sectionIdByLabel.entries()].find(([, id]) => id === opts.sectionId)?.[0]}]` : '';
    console.log(`  + ${opts.kind} ${path.basename(opts.relPath)}${opts.label ? ` "${opts.label}"` : ''}${sec} ${(stat.size / 1024 / 1024).toFixed(1)}MB`);
    fileCount++;
    bytes += stat.size;
    if (dryRun) return;

    const body = await fsp.readFile(abs);
    const filename = path.basename(opts.relPath);
    const contentType = mimeFor(filename);
    const stored = await storeImportedFile({ pieceId: opts.pieceId, bytes: body, filename, contentType });
    const row = createFile({
      pieceId: opts.pieceId,
      kind: opts.kind,
      label: opts.label,
      storage: stored.storage,
      storageKey: stored.storageKey,
      filename,
      sizeBytes: stat.size,
      mimeType: contentType,
      sortOrder: opts.sortOrder,
      sectionId: opts.sectionId,
      durationMs: opts.durationMs ?? null,
    });
    if (opts.createdAt) db.prepare('UPDATE files SET created_at = ? WHERE id = ?').run(opts.createdAt, row.id);
    progress.files[opts.cmId] = row.id;
    await save();
  }

  // -- 3. set lists -----------------------------------------------------------
  if (!Number.isFinite(limit)) {
    const existingNames = new Set(listSetLists().map((s) => s.name));
    for (const [name, items] of Object.entries(manifest.setlists)) {
      if (progress.setlists[name] !== undefined || existingNames.has(name)) {
        console.log(`\nset list "${name}" already exists — skipped`);
        continue;
      }
      const pieceIds: number[] = [];
      for (const it of [...items].sort((a, b) => a.rank - b.rank)) {
        const pid = progress.pieces[it.id] ?? pieceByKey.get(normTitle(it.title));
        if (pid === undefined) {
          console.log(`  set list "${name}": no piece for ${JSON.stringify(it.title)}`);
          continue;
        }
        if (pid < 0) {
          // dry run: count the entry but there is no real id
          pieceIds.push(-pieceIds.length - 1);
          continue;
        }
        if (!pieceIds.includes(pid)) pieceIds.push(pid);
      }
      console.log(`\nset list "${name}": ${pieceIds.length} songs`);
      if (!dryRun) {
        const sl = createSetList({ name, pieceIds });
        progress.setlists[name] = sl.id;
        await save();
      }
    }
  }

  // -- 4. report --------------------------------------------------------------
  console.log(`\n${dryRun ? 'would create' : 'created'}: ${pieceCount} pieces, ${fileCount} files, ${(bytes / 1024 / 1024).toFixed(0)}MB, ${remarkCount} remarks, ${linkCount} links`);
  if (durationCount) console.log(`filled in ${durationCount} missing durations on earlier imports`);
  if (missing.length) {
    console.log(`\nMISSING ${missing.length} files:`);
    for (const f of missing) console.log(`  ${f}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
