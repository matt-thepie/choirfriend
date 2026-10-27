/**
 * Voice parts ("sections"). One choir-wide ordered list. Seeded with SGMC's
 * parts on first boot; other choirs edit via the admin API.
 *
 * Also home to the label → section heuristic used to backfill section_id on
 * audio uploaded before sections existed, and to default the section on new
 * uploads from the filename.
 */

import { db } from './index.ts';

export interface SectionRow {
  id: number;
  label: string;
  badge: string;
  sort_order: number;
}

export interface SectionDTO {
  id: number;
  label: string;
  badge: string;
  sortOrder: number;
}

const DEFAULT_SECTIONS: Array<{ label: string; badge: string }> = [
  { label: 'Tenor 1', badge: 'T1' },
  { label: 'Tenor 2', badge: 'T2' },
  { label: 'Baritone', badge: 'Bar' },
  { label: 'Bass', badge: 'B' },
  { label: 'Musician', badge: 'M' },
];

function toDTO(r: SectionRow): SectionDTO {
  return { id: r.id, label: r.label, badge: r.badge, sortOrder: r.sort_order };
}

const listStmt = db.prepare(`SELECT * FROM sections ORDER BY sort_order, id`);
const countStmt = db.prepare(`SELECT COUNT(*) AS n FROM sections`);
const insertStmt = db.prepare(`INSERT INTO sections (label, badge, sort_order) VALUES (?, ?, ?) RETURNING *`);
const updateStmt = db.prepare(`UPDATE sections SET label = ?, badge = ?, sort_order = ? WHERE id = ? RETURNING *`);
const deleteStmt = db.prepare(`DELETE FROM sections WHERE id = ?`);
const getStmt = db.prepare(`SELECT * FROM sections WHERE id = ?`);

export function listSections(): SectionDTO[] {
  return (listStmt.all() as SectionRow[]).map(toDTO);
}

export function getSection(id: number): SectionDTO | null {
  const r = getStmt.get(id) as SectionRow | undefined;
  return r ? toDTO(r) : null;
}

export function sectionExists(id: number): boolean {
  return getStmt.get(id) !== undefined;
}

export function seedSectionsIfEmpty(): void {
  if ((countStmt.get() as { n: number }).n > 0) return;
  DEFAULT_SECTIONS.forEach((s, i) => insertStmt.run(s.label, s.badge, i));
  console.log(`[seed] Created ${DEFAULT_SECTIONS.length} default sections`);
}

export interface SectionInput {
  id?: number;
  label: string;
  badge: string;
}

/**
 * Replace the whole list in one go (admin settings form). Existing ids are
 * updated in place so files and users keep pointing at the right part; ids
 * missing from the input are deleted (their files/users fall back to NULL
 * via the nullable FK — SQLite won't cascade on ALTER-added columns, so we
 * null them out explicitly).
 */
export function replaceSections(input: SectionInput[]): SectionDTO[] {
  const existing = new Set((listStmt.all() as SectionRow[]).map((r) => r.id));
  const keep = new Set<number>();
  db.exec('BEGIN');
  try {
    input.forEach((s, i) => {
      if (s.id !== undefined && existing.has(s.id)) {
        updateStmt.get(s.label, s.badge, i, s.id);
        keep.add(s.id);
      } else {
        const row = insertStmt.get(s.label, s.badge, i) as SectionRow;
        keep.add(row.id);
      }
    });
    for (const id of existing) {
      if (keep.has(id)) continue;
      db.prepare(`UPDATE files SET section_id = NULL WHERE section_id = ?`).run(id);
      db.prepare(`UPDATE users SET section_id = NULL WHERE section_id = ?`).run(id);
      deleteStmt.run(id);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return listSections();
}

// --- Heuristic: guess a section from a label or filename -------------------

/** Patterns tried in order against a lowercased, punctuation-stripped string.
 *  First match wins. Ordered so "tenor 2" beats "tenor", and "baritone"
 *  beats "bass"/"bar". Keyed by default section label; a choir with custom
 *  sections just gets no match. */
const GUESS_RULES: Array<{ label: string; re: RegExp }> = [
  { label: 'Tenor 1', re: /\b(t1|tenor ?1|tenor ?i|1st tenor|first tenor|lead)\b/ },
  { label: 'Tenor 2', re: /\b(t2|tenor ?2|tenor ?ii|2nd tenor|second tenor)\b/ },
  { label: 'Baritone', re: /\b(bari(tone)?|bar|bt|b1)\b/ },
  { label: 'Bass', re: /\b(bass|b2|b)\b/ },
  { label: 'Musician', re: /\b(piano( only)?|accomp(animent)?|backing|instrumental|md)\b/ },
];

/** Returns a section id or null if nothing in the text looks like a part. */
export function guessSectionId(text: string | null | undefined): number | null {
  if (!text) return null;
  const norm = text
    .toLowerCase()
    .replace(/\.(mp3|m4a|aac|ogg|wav|flac)$/, '')
    .replace(/[_\-.,()[\]]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const byLabel = new Map((listStmt.all() as SectionRow[]).map((r) => [r.label.toLowerCase(), r.id]));
  for (const rule of GUESS_RULES) {
    if (rule.re.test(norm)) {
      const id = byLabel.get(rule.label.toLowerCase());
      if (id !== undefined) return id;
    }
  }
  return null;
}

/** One-off, idempotent: give unsectioned audio a best-guess section from its
 *  label, then filename. Runs on every boot but only touches NULL rows. */
export function backfillAudioSections(): void {
  const rows = db
    .prepare(`SELECT id, label, filename FROM files WHERE kind = 'audio' AND section_id IS NULL`)
    .all() as Array<{ id: number; label: string | null; filename: string }>;
  if (rows.length === 0) return;
  const set = db.prepare(`UPDATE files SET section_id = ? WHERE id = ?`);
  let n = 0;
  for (const r of rows) {
    const id = guessSectionId(r.label) ?? guessSectionId(r.filename);
    if (id !== null) {
      set.run(id, r.id);
      n++;
    }
  }
  if (n > 0) console.log(`[sections] Backfilled section on ${n} of ${rows.length} unsectioned audio files`);
}

// Identity's canonical voice parts → our section badges (SGMC defaults).
const VOICE_PART_BADGE: Record<string, string> = {
  t1: 'T1',
  t2: 'T2',
  baritone: 'Bar',
  bass: 'B',
  instrumentalist: 'M',
};

/** Section for an identity voice part, matched by badge, then by label. Null if none fits. */
export function sectionIdForVoicePart(voicePart: string): number | null {
  const key = voicePart.toLowerCase().trim();
  const badge = (VOICE_PART_BADGE[key] ?? '').toLowerCase();
  const all = listSections();
  const hit =
    (badge && all.find((s) => s.badge.toLowerCase() === badge)) ||
    all.find((s) => s.label.toLowerCase() === key || s.label.toLowerCase().replace(/\s+/g, '') === key);
  return hit ? hit.id : null;
}
