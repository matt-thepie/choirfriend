/**
 * Bulk importer (admin only).
 *
 * Drop a folder / loose files / a .zip. We treat **one folder = one song**:
 * everything inside a folder is grouped, and the wizard walks song-by-song.
 *
 * Per song we figure out, from each file's first page / name:
 *   - the SCORE pdf  → becomes the piece (AI guesses title/composer/arranger,
 *                      and will fill a well-known composer from knowledge when
 *                      it isn't printed, flagged at lower confidence).
 *   - LYRICS pdf(s)  → attached to the song, labelled "Lyrics".
 *   - AUDIO tracks   → attached, with a voice-part label guessed from the
 *                      filename; a player lets you confirm by ear.
 *
 * On confirm we create the piece, then attach its files (score first). New
 * songs land in "All other songs", not the active repertoire.
 *
 * Memory: only the song you're on is read off disk / decompressed; it's
 * released when you move on, so a multi-GB library stays flat.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import JSZip from 'jszip';
import { Button } from '@/components/ui/button.tsx';
import { cn } from '@/lib/utils.ts';
import { openPdf } from '@/lib/pdfjs.ts';

interface ImportScreenProps {
  onClose: () => void;
}

type FileStatus = 'pending' | 'analyzing' | 'ready' | 'error';

interface SongFile {
  id: string;
  name: string;
  folder: string;
  kind: 'pdf' | 'audio';
  load: () => Promise<Blob>;
  blob?: Blob;
  url?: string;
  status: FileStatus;
  // PDF analysis
  docType?: 'score' | 'lyrics';
  pdfTitle?: string;
  pdfComposer?: string;
  pdfArranger?: string;
  pdfConfidence?: 'high' | 'medium' | 'low';
  // Audio
  voicePart?: string;
  /** For an unplaced track: the group id the user chose to attach it to
   *  (null/undefined = held for later / not imported). */
  assignToGroupId?: string | null;
  /** "Sort later": excluded from this import (the file stays on disk). */
  setAside?: boolean;
  error?: string;
}

type GroupStatus = 'pending' | 'analyzing' | 'ready' | 'committing' | 'done' | 'skipped' | 'error';

interface SongGroup {
  id: string; // folder path (or a synthetic key for a loose file)
  label: string; // shown to the user
  status: GroupStatus;
  files: SongFile[];
  scoreFileId: string | null;
  title: string;
  composer: string;
  arranger: string;
  confidence?: 'high' | 'medium' | 'low';
  error?: string;
  /** True for the synthetic "Unplaced tracks" group (manual placement step). */
  unplaced?: boolean;
  /** Set once the piece has been created on commit, so unplaced tracks can
   *  attach to it. */
  pieceId?: number;
}

interface PickedFile {
  file: File;
  path: string;
}

interface RawFile {
  id: string;
  name: string;
  folder: string;
  kind: 'pdf' | 'audio';
  load: () => Promise<Blob>;
}

const AUDIO_RE = /\.(mp3|m4a|aac|ogg|opus|wav|flac|webm)$/i;

function isJunk(p: string): boolean {
  return p.startsWith('__MACOSX/') || p.split('/').some((s) => s.startsWith('.'));
}

function stripExt(name: string): string {
  return name.replace(/\.[a-z0-9]+$/i, '');
}

/** Guess a voice part / track label from a filename. Deterministic and free;
 *  the human confirms by ear via the player, so we stay conservative and
 *  return '' rather than guess wildly. */
function guessVoicePart(filename: string): string {
  const n = stripExt(filename).toLowerCase().replace(/[_-]+/g, ' ');
  if (/\b(full|all\s*parts|tutti|mix|satb|everyone|choir)\b/.test(n)) return 'Full mix';
  if (/\b(piano|pno)\b/.test(n)) return 'Piano';
  if (/\b(backing|accompaniment|accomp|instrumental|karaoke)\b/.test(n)) return 'Backing';
  const tests: [RegExp, string][] = [
    [/\b(soprano|sopr|sop)\s*([12])?\b/, 'Soprano'],
    [/\b(alto|alt|contralto)\s*([12])?\b/, 'Alto'],
    [/\b(tenor|ten)\s*([12])?\b/, 'Tenor'],
    [/\b(baritone|bari)\b/, 'Baritone'],
    [/\bb\s*1\b/, 'Baritone'], // Bass 1 / B1 ≡ Baritone
    [/\b(bass|bas)\s*([12])?\b/, 'Bass'],
    [/\bs\s*([12])\b/, 'Soprano'],
    [/\ba\s*([12])\b/, 'Alto'],
    [/\bt\s*([12])\b/, 'Tenor'],
    [/\bb\s*([12])\b/, 'Bass'],
  ];
  for (const [re, label] of tests) {
    const m = n.match(re);
    if (m) return m[2] ? `${label} ${m[2]}` : label;
  }
  return '';
}

const TITLE_SMALL_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in', 'nor', 'of', 'on', 'or', 'the', 'to', 'vs', 'with',
]);

/** Tidy a title's case. Only re-cases SHOUTING titles (no lowercase letters at
 *  all — e.g. "DISCO FEVER" from a score printed in caps); leaves anything that
 *  already has mixed case alone, so deliberate styling isn't clobbered. */
function niceTitle(s: string): string {
  const t = s.trim();
  if (!t || /[a-z]/.test(t)) return t;
  const words = t.toLowerCase().split(/\s+/);
  return words
    .map((w, i) => {
      const bare = w.replace(/[^a-z0-9']/g, '');
      if (i !== 0 && i !== words.length - 1 && TITLE_SMALL_WORDS.has(bare)) return w;
      return w.replace(/[a-z]/, (c) => c.toUpperCase());
    })
    .join(' ');
}

function rawToFile(r: RawFile): SongFile {
  return {
    id: r.id,
    name: r.name,
    folder: r.folder,
    kind: r.kind,
    load: r.load,
    status: 'pending',
    // Baseline voice-part guess; the per-song AI labelling overrides it.
    voicePart: r.kind === 'audio' ? guessVoicePart(r.name) : undefined,
  };
}

/** A folder segment that just sorts a song's files by type/media, not a song in
 *  its own right (matched loosely so "Backing Tracks", "Sheet Music", "MP3s" all
 *  count). Used only by the deterministic fallback grouping. */
const TYPE_FOLDER_RE =
  /\b(audio|tracks?|mp3s?|recordings?|backing|accompaniment|accomp|learning|practice|rehearsal|karaoke|sheet\s*music|sheets?|scores?|pdfs?|lyrics|words|parts)\b/i;

/** The song a file belongs to: its folder with trailing media-type subfolders
 *  (Audio, Sheet Music, Backing Tracks, …) stripped. */
function songKey(folder: string): { key: string; label: string } {
  const segs = folder.split('/').filter(Boolean);
  while (segs.length > 1 && TYPE_FOLDER_RE.test(segs[segs.length - 1]!)) segs.pop();
  return { key: segs.join('/'), label: segs[segs.length - 1] ?? folder };
}

function buildGroups(raw: RawFile[]): SongGroup[] {
  const byFolder = new Map<string, { label: string; files: RawFile[] }>();
  for (const r of raw) {
    const { key, label } =
      r.folder === '' ? { key: `loose:${r.id}`, label: stripExt(r.name) } : songKey(r.folder);
    const g = byFolder.get(key);
    if (g) g.files.push(r);
    else byFolder.set(key, { label, files: [r] });
  }
  const groups: SongGroup[] = [];
  for (const [key, { label, files }] of byFolder) {
    const sorted = [...files].sort((a, b) =>
      a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'pdf' ? -1 : 1,
    );
    groups.push({
      id: key,
      label,
      status: 'pending',
      files: sorted.map(rawToFile),
      scoreFileId: null,
      title: '',
      composer: '',
      arranger: '',
    });
  }
  groups.sort((a, b) => a.label.localeCompare(b.label));
  return groups;
}

/** Normalise a folder path for tolerant matching — the model echoes paths back
 *  with normalised punctuation (curly→straight quotes, NFC), so exact-string
 *  matching would drop accented/punctuated folders. */
function normPath(p: string): string {
  return p
    .normalize('NFC')
    .replace(/[‘’ʼ′]/g, "'")
    .replace(/[“”]/g, '"')
    .trim();
}

/** Primary path: reason about the WHOLE folder tree in one holistic call. We
 *  describe the library by FOLDER (path + count + sample names) — compact enough
 *  that the model never truncates and can see everything at once. It returns a
 *  folder→piece grouping (merging a song's score/rehearsal/backing subfolders)
 *  and flags gig/setlist folders. Per-song detail (score vs lyrics, voice parts)
 *  happens later, locally. Falls back to deterministic grouping if the call fails. */
async function planGroups(raw: RawFile[], onProgress?: (msg: string) => void): Promise<SongGroup[]> {
  const byFolder = new Map<string, RawFile[]>();
  for (const r of raw) {
    const arr = byFolder.get(r.folder);
    if (arr) arr.push(r);
    else byFolder.set(r.folder, [r]);
  }
  const folders = [...byFolder.entries()].map(([path, fs]) => ({
    path,
    count: fs.length,
    samples: fs.slice(0, 6).map((f) => f.name),
  }));

  onProgress?.(`Examining ${folders.length} folders and working out the songs…`);
  let pieces: { title: string; folders: string[] }[] = [];
  let unplacedFolders: string[] = [];
  try {
    const res = await fetch('/api/import/plan-structure', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ folders }),
    });
    if (res.ok) {
      const j = (await res.json()) as { pieces?: typeof pieces; unplacedFolders?: string[] };
      pieces = j.pieces ?? [];
      unplacedFolders = j.unplacedFolders ?? [];
    }
  } catch {
    // fall back below
  }
  if (pieces.length === 0 && unplacedFolders.length === 0) return reassignDetachedAudio(buildGroups(raw));

  // Folder (normalised) → piece index.
  const folderToPiece = new Map<string, number>();
  pieces.forEach((p, i) => {
    for (const f of p.folders) {
      const k = normPath(f);
      if (!folderToPiece.has(k)) folderToPiece.set(k, i);
    }
  });
  const unplacedSet = new Set(unplacedFolders.map(normPath));

  const used = new Set<string>();
  const groups: SongGroup[] = [];
  pieces.forEach((p, i) => {
    const files = raw.filter((r) => folderToPiece.get(normPath(r.folder)) === i).map(rawToFile);
    if (files.length === 0) return;
    for (const f of files) used.add(f.id);
    files.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'pdf' ? -1 : 1));
    const label = niceTitle(p.title || stripExt(files[0]!.name));
    groups.push({ id: `plan:${i}`, label, status: 'pending', files, scoreFileId: null, title: label, composer: '', arranger: '' });
  });

  // Leftovers: audio in a flagged gig/setlist folder → the manual "Unplaced"
  // step; any PDF, or files in a folder the model somehow missed → their own
  // piece(s) via folder grouping, so nothing is lost.
  const stillUnplaced: SongFile[] = [];
  const forFolderGrouping: RawFile[] = [];
  for (const r of raw) {
    if (used.has(r.id)) continue;
    if (r.kind === 'audio' && unplacedSet.has(normPath(r.folder))) stillUnplaced.push(rawToFile(r));
    else forFolderGrouping.push(r);
  }

  const result = [...groups, ...(forFolderGrouping.length > 0 ? buildGroups(forFolderGrouping) : [])];
  result.sort((a, b) => a.label.localeCompare(b.label));
  if (stillUnplaced.length > 0) {
    result.push({
      id: '__unplaced__',
      label: 'Unplaced tracks',
      status: 'pending',
      files: stillUnplaced,
      scoreFileId: null,
      title: 'Unplaced tracks',
      composer: '',
      arranger: '',
      unplaced: true,
    });
  }
  return result.length > 0 ? result : reassignDetachedAudio(buildGroups(raw));
}

/** PDFs define the pieces; detached audio (in a folder with no score) is placed
 *  by the LLM into the piece it most likely belongs to. Audio that already sits
 *  with a score is trusted as-is. Anything the LLM can't place stays its own
 *  group so it's still visible. (Fallback for when the holistic plan fails.) */
async function reassignDetachedAudio(groups: SongGroup[]): Promise<SongGroup[]> {
  const pieceGroups = groups.filter((g) => g.files.some((f) => f.kind === 'pdf'));
  const audioOnly = groups.filter((g) => g.files.every((f) => f.kind === 'audio'));
  if (pieceGroups.length === 0 || audioOnly.length === 0) return groups;

  const detached = audioOnly.flatMap((g) => g.files.map((f) => ({ id: f.id, filename: f.name, folder: g.label })));
  const pieces = pieceGroups.map((g) => ({
    key: g.id,
    label: g.label,
    hints: g.files.filter((f) => f.kind === 'pdf').map((f) => f.name).slice(0, 4),
  }));

  const assignment = new Map<string, string | null>();
  try {
    const res = await fetch('/api/import/assign-tracks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ pieces, tracks: detached }),
    });
    if (res.ok) {
      const { assignments } = (await res.json()) as { assignments: { id: string; pieceKey: string | null }[] };
      for (const a of assignments) assignment.set(a.id, a.pieceKey);
    }
  } catch {
    // assignment failed — detached audio just stays as its own group
  }

  const byKey = new Map(pieceGroups.map((g) => [g.id, g] as const));
  const leftover: SongGroup[] = [];
  for (const g of audioOnly) {
    const unplaced: SongFile[] = [];
    for (const f of g.files) {
      const dest = assignment.get(f.id);
      const target = dest ? byKey.get(dest) : undefined;
      if (target) target.files.push(f);
      else unplaced.push(f);
    }
    if (unplaced.length > 0) leftover.push({ ...g, files: unplaced });
  }
  // Keep PDFs first within each merged piece.
  for (const g of byKey.values()) {
    g.files.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'pdf' ? -1 : 1));
  }
  return [...pieceGroups, ...leftover].sort((a, b) => a.label.localeCompare(b.label));
}

export function ImportScreen({ onClose }: ImportScreenProps) {
  const [groups, setGroups] = useState<SongGroup[]>([]);
  const [index, setIndex] = useState(0);
  const [phase, setPhase] = useState<'drop' | 'wizard' | 'done'>('drop');
  const [dropError, setDropError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyMessage, setBusyMessage] = useState('Working…');
  const urlsRef = useRef<string[]>([]);
  const startedRef = useRef<Set<string>>(new Set());

  useEffect(
    () => () => {
      for (const u of urlsRef.current) URL.revokeObjectURL(u);
    },
    [],
  );

  const updateGroup = useCallback((id: string, patch: Partial<SongGroup>) => {
    setGroups((prev) => prev.map((g) => (g.id === id ? { ...g, ...patch } : g)));
  }, []);

  const updateFile = useCallback((groupId: string, fileId: string, patch: Partial<SongFile>) => {
    setGroups((prev) =>
      prev.map((g) =>
        g.id !== groupId ? g : { ...g, files: g.files.map((f) => (f.id === fileId ? { ...f, ...patch } : f)) },
      ),
    );
  }, []);

  function start(next: SongGroup[]): void {
    if (next.length === 0) {
      setDropError('No PDFs or audio files found.');
      return;
    }
    startedRef.current.clear();
    setDropError(null);
    setGroups(next);
    setIndex(0);
    setPhase('wizard');
  }

  /** Hand the whole drop to the LLM to plan the grouping (folder fallback). */
  async function ingest(raw: RawFile[]): Promise<void> {
    setBusyMessage(
      `Reading ${raw.length} file${raw.length === 1 ? '' : 's'} and asking the AI to organise them into songs… ` +
        'this can take up to a minute for a big library.',
    );
    start(await planGroups(raw, setBusyMessage));
  }

  async function handleFiles(picked: PickedFile[]): Promise<void> {
    const raw: RawFile[] = [];
    picked.forEach(({ file, path }, i) => {
      const lower = file.name.toLowerCase();
      const isPdf = lower.endsWith('.pdf');
      const isAudio = AUDIO_RE.test(lower);
      if (!isPdf && !isAudio) return;
      const parts = path.split('/');
      raw.push({
        id: `${path}#${i}`,
        name: parts[parts.length - 1]!,
        folder: parts.slice(0, -1).join('/'),
        kind: isPdf ? 'pdf' : 'audio',
        load: () => Promise.resolve(file),
      });
    });
    setBusy(true);
    try {
      await ingest(raw);
    } finally {
      setBusy(false);
    }
  }

  async function handleZip(file: File): Promise<void> {
    setDropError(null);
    setBusyMessage('Unzipping…');
    setBusy(true);
    try {
      const zip = await JSZip.loadAsync(file);
      const entries = Object.values(zip.files).filter((e) => !e.dir && !isJunk(e.name));
      const raw: RawFile[] = [];
      for (const entry of entries) {
        const isPdf = /\.pdf$/i.test(entry.name);
        const isAudio = AUDIO_RE.test(entry.name);
        if (!isPdf && !isAudio) continue;
        const parts = entry.name.split('/');
        raw.push({
          id: entry.name,
          name: parts[parts.length - 1]!,
          folder: parts.slice(0, -1).join('/'),
          kind: isPdf ? 'pdf' : 'audio',
          load: () => entry.async('blob'),
        });
      }
      await ingest(raw);
    } catch (e) {
      setDropError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onPicked(picked: PickedFile[]): Promise<void> {
    if (picked.length === 1 && /\.zip$/i.test(picked[0]!.file.name)) {
      await handleZip(picked[0]!.file);
    } else {
      await handleFiles(picked);
    }
  }

  // Analyse every file in a song: PDFs via the AI (score/lyrics + metadata),
  // audio via a filename guess. Then pick the score and seed the song's fields.
  const analyzeGroup = useCallback(
    async (group: SongGroup): Promise<void> => {
      updateGroup(group.id, { status: 'analyzing', error: undefined });
      try {
        const pdfMeta: Record<string, { docType: 'score' | 'lyrics'; title: string; composer: string; arranger: string; confidence: 'high' | 'medium' | 'low' }> = {};
        for (const f of group.files) {
          let blob = f.blob;
          let url = f.url;
          if (!blob) {
            blob = await f.load();
            url = URL.createObjectURL(blob);
            urlsRef.current.push(url);
            updateFile(group.id, f.id, { blob, url });
          }
          if (f.kind === 'pdf') {
            const fd = new FormData();
            fd.append('file', blob, f.name);
            const res = await fetch('/api/import/analyze-pdf', { method: 'POST', credentials: 'include', body: fd });
            if (!res.ok) throw new Error(await errorText(res));
            const g = (await res.json()) as {
              docType: 'score' | 'lyrics';
              title: string;
              composer: string;
              arranger: string;
              confidence: 'high' | 'medium' | 'low';
            };
            pdfMeta[f.id] = { docType: g.docType, title: g.title ?? '', composer: g.composer ?? '', arranger: g.arranger ?? '', confidence: g.confidence };
            updateFile(group.id, f.id, {
              status: 'ready',
              docType: g.docType,
              pdfTitle: g.title ?? '',
              pdfComposer: g.composer ?? '',
              pdfArranger: g.arranger ?? '',
              pdfConfidence: g.confidence,
            });
          }
          // audio: materialised above; voice parts labelled in one batch below.
        }

        // Voice parts: one AI call labels all this song's tracks from their
        // filenames, with each track's parent subfolder as a hint (so a track in
        // a "Baritone/" folder is labelled even if its filename is generic). The
        // regex baseline (set in rawToFile) is the fallback.
        const audioFiles = group.files.filter((f) => f.kind === 'audio');
        if (audioFiles.length > 0) {
          const hintOf = (f: SongFile): string => {
            const seg = f.folder ? f.folder.split('/').filter(Boolean).slice(-1)[0] : '';
            return seg ? `${seg}/${f.name}` : f.name;
          };
          const byHint = new Map<string, string>();
          try {
            const res = await fetch('/api/import/analyze-tracks', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
              body: JSON.stringify({ folder: group.label, filenames: audioFiles.map(hintOf) }),
            });
            if (res.ok) {
              const { tracks } = (await res.json()) as { tracks: { filename: string; voicePart: string }[] };
              for (const t of tracks) byHint.set(t.filename, t.voicePart);
            }
          } catch {
            // keep the regex baseline
          }
          for (const f of audioFiles) {
            const ai = byHint.get(hintOf(f));
            updateFile(group.id, f.id, { status: 'ready', voicePart: ai && ai.trim() ? ai : f.voicePart || guessVoicePart(f.name) });
          }
        }

        // Choose the score from the analysis results (NOT the stale file objects
        // or alphabetical order): prefer a PDF the AI tagged 'score', highest
        // confidence first, so a "Lyrics" sheet can never win over a real score.
        const confRank = (c?: 'high' | 'medium' | 'low'): number => (c === 'high' ? 0 : c === 'medium' ? 1 : 2);
        const rankedPdfs = group.files
          .filter((f) => f.kind === 'pdf' && pdfMeta[f.id])
          .sort((a, b) => {
            const sa = pdfMeta[a.id]!.docType === 'score' ? 0 : 1;
            const sb = pdfMeta[b.id]!.docType === 'score' ? 0 : 1;
            return sa !== sb ? sa - sb : confRank(pdfMeta[a.id]!.confidence) - confRank(pdfMeta[b.id]!.confidence);
          });
        const best = rankedPdfs[0];
        // Only call it the score if it's actually tagged one; a lyrics-only
        // folder has no score (title still seeds from the best PDF / folder).
        const scoreId = best && pdfMeta[best.id]!.docType === 'score' ? best.id : null;
        const meta = best ? pdfMeta[best.id] : undefined;
        updateGroup(group.id, {
          status: 'ready',
          scoreFileId: scoreId,
          title: niceTitle(meta?.title || group.label),
          composer: meta?.composer || '',
          arranger: meta?.arranger || '',
          confidence: meta?.confidence,
        });
      } catch (e) {
        updateGroup(group.id, { status: 'error', error: e instanceof Error ? e.message : String(e) });
      }
    },
    [updateGroup, updateFile],
  );

  const current = groups[index];
  useEffect(() => {
    if (phase !== 'wizard' || !current) return;
    if (current.status === 'pending' && !startedRef.current.has(current.id)) {
      startedRef.current.add(current.id);
      void analyzeGroup(current);
    }
  }, [phase, current, analyzeGroup]);

  function advance(): void {
    if (current) {
      for (const f of current.files) if (f.url) URL.revokeObjectURL(f.url);
      updateGroup(current.id, { files: current.files.map((f) => ({ ...f, blob: undefined, url: undefined })) });
    }
    if (index + 1 < groups.length) setIndex(index + 1);
    else setPhase('done');
  }

  /** "This lyrics PDF is actually the score" — swap which PDF drives the song. */
  function makeScore(group: SongGroup, fileId: string): void {
    const f = group.files.find((x) => x.id === fileId);
    if (!f) return;
    updateGroup(group.id, {
      scoreFileId: fileId,
      title: niceTitle(f.pdfTitle || group.title),
      composer: f.pdfComposer ?? '',
      arranger: f.pdfArranger ?? '',
      confidence: f.pdfConfidence,
    });
  }

  async function confirmCurrent(): Promise<void> {
    if (!current || busy || !current.title.trim()) return;
    setBusy(true);
    updateGroup(current.id, { status: 'committing', error: undefined });
    try {
      const res = await fetch('/api/import/create-piece', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          title: current.title.trim(),
          composer: current.composer.trim() || undefined,
          arranger: current.arranger.trim() || undefined,
        }),
      });
      if (!res.ok) throw new Error(await errorText(res));
      const { pieceId } = (await res.json()) as { pieceId: number };

      // Score first (so it's the song's primary PDF), then other PDFs, then audio.
      const rank = (f: SongFile): number => (f.id === current.scoreFileId ? 0 : f.kind === 'pdf' ? 1 : 2);
      const ordered = [...current.files].sort((a, b) => rank(a) - rank(b));
      for (const f of ordered) {
        if (f.setAside) continue; // "sort later" — not imported now
        const blob = f.blob ?? (await f.load());
        const fd = new FormData();
        fd.append('file', blob, f.name);
        fd.append('kind', f.kind);
        fd.append('pieceId', String(pieceId));
        const label = f.kind === 'audio' ? f.voicePart?.trim() || '' : f.id === current.scoreFileId ? '' : 'Lyrics';
        if (label) fd.append('label', label);
        const cres = await fetch('/api/import/commit', { method: 'POST', credentials: 'include', body: fd });
        if (!cres.ok) throw new Error(await errorText(cres));
      }

      updateGroup(current.id, { status: 'done', pieceId });
      advance();
    } catch (e) {
      updateGroup(current.id, { status: 'error', error: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  /** Final step: attach each chosen unplaced track to the song the user picked.
   *  Tracks left on "hold for later" are simply not imported. */
  async function confirmUnplaced(): Promise<void> {
    if (!current || busy) return;
    setBusy(true);
    updateGroup(current.id, { status: 'committing', error: undefined });
    try {
      for (const f of current.files) {
        if (!f.assignToGroupId) continue; // held for later
        const target = groups.find((g) => g.id === f.assignToGroupId);
        if (!target?.pieceId) continue;
        const blob = f.blob ?? (await f.load());
        const fd = new FormData();
        fd.append('file', blob, f.name);
        fd.append('kind', 'audio');
        fd.append('pieceId', String(target.pieceId));
        if (f.voicePart?.trim()) fd.append('label', f.voicePart.trim());
        const cres = await fetch('/api/import/commit', { method: 'POST', credentials: 'include', body: fd });
        if (!cres.ok) throw new Error(await errorText(cres));
      }
      updateGroup(current.id, { status: 'done' });
      advance();
    } catch (e) {
      updateGroup(current.id, { status: 'error', error: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  function skipCurrent(): void {
    if (!current) return;
    updateGroup(current.id, { status: 'skipped' });
    advance();
  }

  const doneCount = groups.filter((g) => g.status === 'done').length;
  const skipCount = groups.filter((g) => g.status === 'skipped').length;
  // Songs already created this session — the targets an unplaced track can join.
  const committedSongs = groups
    .filter((g) => g.pieceId != null && !g.unplaced)
    .map((g) => ({ id: g.id, title: g.title.trim() || g.label }));

  return (
    <div className="h-full overflow-auto">
      <div className="max-w-3xl mx-auto px-4 py-6 space-y-5">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold">Import files</h1>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {phase === 'done' ? 'Close' : 'Cancel'}
          </Button>
        </div>

        {phase === 'drop' && <DropZone busy={busy} busyMessage={busyMessage} error={dropError} onPicked={onPicked} />}

        {phase === 'wizard' && current && (
          <div className="space-y-4">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>
                {current.unplaced ? 'Final step — unplaced tracks' : `Song ${index + 1} of ${groups.length}`}
              </span>
              <span className="font-mono truncate max-w-[60%]" title={current.id}>
                {current.label}
              </span>
            </div>

            {current.unplaced ? (
              <>
                <UnplacedCard
                  group={current}
                  songs={committedSongs}
                  onChangeFile={(fileId, patch) => updateFile(current.id, fileId, patch)}
                />
                <div className="flex items-center gap-2">
                  <Button
                    onClick={confirmUnplaced}
                    disabled={busy || current.status === 'analyzing' || !current.files.some((f) => f.assignToGroupId)}
                  >
                    {current.status === 'committing' ? 'Adding…' : 'Add selected tracks'}
                  </Button>
                  <Button variant="ghost" onClick={skipCurrent} disabled={busy}>
                    Hold all for later
                  </Button>
                </div>
              </>
            ) : (
              <>
                <SongCard
                  group={current}
                  onChange={(patch) => updateGroup(current.id, patch)}
                  onChangeFile={(fileId, patch) => updateFile(current.id, fileId, patch)}
                  onMakeScore={(fileId) => makeScore(current, fileId)}
                  onRetry={() => void analyzeGroup(current)}
                />

                <div className="flex items-center gap-2">
                  <Button onClick={confirmCurrent} disabled={busy || current.status === 'analyzing' || !current.title.trim()}>
                    {current.status === 'committing' ? 'Adding…' : 'Add song'}
                  </Button>
                  <Button variant="ghost" onClick={skipCurrent} disabled={busy}>
                    Skip
                  </Button>
                  {current.status === 'ready' && !current.title.trim() && (
                    <span className="text-xs text-amber-700">Give this song a title.</span>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {phase === 'done' && (
          <div className="rounded-lg border border-border bg-background p-6 text-center space-y-3">
            <p className="text-sm">
              Imported <strong>{doneCount}</strong> song{doneCount === 1 ? '' : 's'}
              {skipCount > 0 ? `, skipped ${skipCount}` : ''}.
            </p>
            <p className="text-xs text-muted-foreground">
              New songs were added to “All other songs”. Move the ones you're practising into the active repertoire from the home screen.
            </p>
            <Button onClick={onClose}>Done</Button>
          </div>
        )}
      </div>
    </div>
  );
}

// --- Unplaced tracks card --------------------------------------------------

function UnplacedCard({
  group,
  songs,
  onChangeFile,
}: {
  group: SongGroup;
  songs: { id: string; title: string }[];
  onChangeFile: (fileId: string, patch: Partial<SongFile>) => void;
}) {
  return (
    <div className="rounded-lg border border-border bg-background p-4 space-y-3">
      {group.status === 'analyzing' && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> Loading tracks…
        </div>
      )}
      <p className="text-sm text-muted-foreground">
        The AI wasn't sure where these belong. Have a listen and pick a song, or leave them on “hold for later”.
      </p>
      {songs.length === 0 && (
        <p className="text-xs text-amber-700">No songs added yet to attach these to — they'll be held for later.</p>
      )}
      <ul className="space-y-2">
        {group.files.map((f) => (
          <li key={f.id} className="rounded-md border border-border p-2 space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="flex-1 text-xs font-mono truncate min-w-40" title={f.name}>
                {f.name}
              </span>
              <input
                type="text"
                value={f.voicePart ?? ''}
                onChange={(e) => onChangeFile(f.id, { voicePart: e.target.value })}
                placeholder="Voice part"
                className="h-8 px-2 rounded-md border border-border bg-background text-sm w-32"
              />
              <select
                value={f.assignToGroupId ?? ''}
                onChange={(e) => onChangeFile(f.id, { assignToGroupId: e.target.value || null })}
                className="h-8 px-2 rounded-md border border-border bg-background text-sm"
              >
                <option value="">— hold for later —</option>
                {songs.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title}
                  </option>
                ))}
              </select>
            </div>
            {f.url ? (
              <audio controls src={f.url} className="w-full" />
            ) : (
              <p className="text-xs text-muted-foreground">Loading audio…</p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// --- Song card -------------------------------------------------------------

function SongCard({
  group,
  onChange,
  onChangeFile,
  onMakeScore,
  onRetry,
}: {
  group: SongGroup;
  onChange: (patch: Partial<SongGroup>) => void;
  onChangeFile: (fileId: string, patch: Partial<SongFile>) => void;
  onMakeScore: (fileId: string) => void;
  onRetry: () => void;
}) {
  const score = group.files.find((f) => f.id === group.scoreFileId) ?? null;
  const otherPdfs = group.files.filter((f) => f.kind === 'pdf' && f.id !== group.scoreFileId);
  const audio = group.files.filter((f) => f.kind === 'audio');

  return (
    <div className="rounded-lg border border-border bg-background p-4 space-y-4">
      {group.status === 'analyzing' && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> Reading the score and tracks…
        </div>
      )}
      {group.status === 'error' && (
        <div className="flex items-center gap-2">
          <p className="text-sm text-destructive flex-1">Error: {group.error}</p>
          <Button variant="outline" size="sm" onClick={onRetry}>
            Retry
          </Button>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        {score ? (
          <div className="space-y-1">
            <PdfThumb blob={score.blob} />
            {score.url && (
              <a href={score.url} target="_blank" rel="noreferrer" className="text-xs underline text-muted-foreground">
                Open full PDF
              </a>
            )}
          </div>
        ) : (
          <div className="w-full h-72 rounded border border-border bg-muted flex items-center justify-center text-center text-sm text-muted-foreground p-3">
            {group.status === 'analyzing' ? 'Loading…' : 'No score sheet found in this folder — set a title below.'}
          </div>
        )}

        <div className="space-y-3">
          {group.confidence && <ConfidenceBadge level={group.confidence} />}
          <Field label="Title">
            <input
              type="text"
              value={group.title}
              onChange={(e) => onChange({ title: e.target.value })}
              placeholder="(required)"
              className="w-full h-9 px-2 rounded-md border border-border bg-background text-sm"
            />
          </Field>
          <Field label="Composer">
            <input
              type="text"
              value={group.composer}
              onChange={(e) => onChange({ composer: e.target.value })}
              className="w-full h-9 px-2 rounded-md border border-border bg-background text-sm"
            />
          </Field>
          <Field label="Arranger">
            <input
              type="text"
              value={group.arranger}
              onChange={(e) => onChange({ arranger: e.target.value })}
              className="w-full h-9 px-2 rounded-md border border-border bg-background text-sm"
            />
          </Field>
        </div>
      </div>

      {otherPdfs.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">Also attached (lyrics / extra sheets):</p>
          <ul className="rounded-md border border-border divide-y divide-border">
            {otherPdfs.map((f) => (
              <li key={f.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                <span className="flex-1 truncate">
                  {f.name}
                  {f.docType === 'lyrics' && <span className="text-muted-foreground"> · lyrics</span>}
                </span>
                {f.url && (
                  <a href={f.url} target="_blank" rel="noreferrer" className="text-xs underline text-muted-foreground">
                    open
                  </a>
                )}
                <Button variant="ghost" size="sm" onClick={() => onMakeScore(f.id)}>
                  This is the score
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {audio.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">Learning tracks — have a listen and label the voice part:</p>
          <ul className="space-y-2">
            {audio.map((f) => (
              <li key={f.id} className={cn('rounded-md border border-border p-2 space-y-2', f.setAside && 'opacity-50')}>
                <div className="flex items-center gap-2">
                  <span className="flex-1 text-xs font-mono truncate" title={f.name}>
                    {f.name}
                  </span>
                  <input
                    type="text"
                    value={f.voicePart ?? ''}
                    disabled={f.setAside}
                    onChange={(e) => onChangeFile(f.id, { voicePart: e.target.value })}
                    placeholder="Voice part (e.g. Tenor 1)"
                    className="h-8 px-2 rounded-md border border-border bg-background text-sm w-44 disabled:opacity-60"
                  />
                  <Button variant="ghost" size="sm" onClick={() => onChangeFile(f.id, { setAside: !f.setAside })}>
                    {f.setAside ? 'Undo' : 'Sort later'}
                  </Button>
                </div>
                {f.setAside ? (
                  <p className="text-xs text-muted-foreground">Set aside — won't be imported now.</p>
                ) : f.url ? (
                  <audio controls src={f.url} className="w-full" />
                ) : (
                  <p className="text-xs text-muted-foreground">Loading audio…</p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// --- PDF thumbnail ---------------------------------------------------------

/** Render page 1 of a PDF blob to a canvas via PDF.js — a real preview, not
 *  the browser's flaky native <object> rendering of blob: URLs. */
function PdfThumb({ blob }: { blob: Blob | undefined }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!blob) return;
    let cancelled = false;
    setError(null);
    void (async () => {
      try {
        const data = new Uint8Array(await blob.arrayBuffer());
        if (cancelled) return;
        const doc = await openPdf({ data }).promise;
        const page = await doc.getPage(1);
        const canvas = canvasRef.current;
        if (cancelled || !canvas) {
          doc.destroy();
          return;
        }
        const scale = 600 / page.getViewport({ scale: 1 }).width;
        const viewport = page.getViewport({ scale });
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        // CPU canvas: GPU canvases garble pdf.js output on weak GPUs (see PdfPage).
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (ctx) await page.render({ canvas, canvasContext: ctx, viewport }).promise;
        doc.destroy();
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [blob]);

  return (
    <div className="h-72 rounded border border-border bg-muted flex items-center justify-center overflow-hidden">
      {!blob ? (
        <span className="text-sm text-muted-foreground">Loading…</span>
      ) : error ? (
        <span className="text-sm text-destructive p-3 text-center">Couldn't preview: {error}</span>
      ) : (
        <canvas ref={canvasRef} className="max-w-full max-h-full" />
      )}
    </div>
  );
}

// --- Drop zone -------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any -- FileSystemEntry drag API is loosely typed */
async function walkEntry(entry: any, prefix: string, out: PickedFile[]): Promise<void> {
  if (entry.isFile) {
    const file: File = await new Promise((res, rej) => entry.file(res, rej));
    out.push({ file, path: prefix + entry.name });
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    for (;;) {
      const batch: any[] = await new Promise((res, rej) => reader.readEntries(res, rej));
      if (batch.length === 0) break;
      for (const child of batch) await walkEntry(child, `${prefix}${entry.name}/`, out);
    }
  }
}

async function pickedFromDrop(dt: DataTransfer): Promise<PickedFile[]> {
  const entries = Array.from(dt.items)
    .filter((i) => i.kind === 'file')
    .map((i) => (i as any).webkitGetAsEntry?.())
    .filter(Boolean);
  if (entries.length > 0) {
    const out: PickedFile[] = [];
    for (const e of entries) await walkEntry(e, '', out);
    return out;
  }
  return Array.from(dt.files).map((f) => ({ file: f, path: f.webkitRelativePath || f.name }));
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function DropZone({
  busy,
  busyMessage,
  error,
  onPicked,
}: {
  busy: boolean;
  busyMessage: string;
  error: string | null;
  onPicked: (p: PickedFile[]) => void;
}) {
  const [over, setOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const dirRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    dirRef.current?.setAttribute('webkitdirectory', '');
  }, []);

  const fromInput = (list: FileList | null): void => {
    if (list) onPicked(Array.from(list).map((f) => ({ file: f, path: f.webkitRelativePath || f.name })));
  };

  return (
    <div className="space-y-3">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          void pickedFromDrop(e.dataTransfer).then(onPicked);
        }}
        className={cn(
          'flex flex-col items-center justify-center gap-3 h-48 rounded-lg border-2 border-dashed text-sm',
          over ? 'border-primary bg-accent/40' : 'border-border bg-background',
        )}
      >
        {busy ? (
          <div className="flex flex-col items-center gap-3 px-6 text-center">
            <Spinner />
            <span className="text-muted-foreground max-w-md">{busyMessage}</span>
          </div>
        ) : (
          <>
            <span className="font-medium">Drop a folder, files, or a .zip here</span>
            <span className="text-muted-foreground">The AI reads your whole folder structure and sorts it into songs.</span>
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
                Choose files
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => dirRef.current?.click()}>
                Choose folder
              </Button>
            </div>
          </>
        )}
      </div>
      <input
        ref={fileRef}
        type="file"
        multiple
        accept=".pdf,.zip,audio/*"
        className="hidden"
        onChange={(e) => fromInput(e.target.files)}
      />
      <input ref={dirRef} type="file" className="hidden" onChange={(e) => fromInput(e.target.files)} />
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

// --- bits ------------------------------------------------------------------

async function errorText(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
  return body.message ?? body.error ?? `HTTP ${res.status}`;
}

function Spinner() {
  return (
    <svg className="animate-spin h-6 w-6 text-muted-foreground" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 0 1 8-8v4a4 4 0 0 0-4 4H4z" />
    </svg>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs text-muted-foreground mb-1">{label}</span>
      {children}
    </label>
  );
}

function ConfidenceBadge({ level }: { level: 'high' | 'medium' | 'low' }) {
  const styles = {
    high: 'text-emerald-700 bg-emerald-50',
    medium: 'text-amber-700 bg-amber-50',
    low: 'text-rose-700 bg-rose-50',
  } as const;
  return (
    <span className={cn('inline-block text-xs uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded', styles[level])}>
      AI guess: {level} confidence
    </span>
  );
}
