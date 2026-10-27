/**
 * Which part of a flowing score each choir section sings. Unlike a PDF (where
 * the stave names have to be read off the page), MusicXML names every part,
 * so this decides once for the whole score.
 *
 * How arrangers label voices varies, so the rules follow singers' habits:
 *   - "Unison" / "Melody" / "Voice" is everyone's line;
 *   - "Tenors" or "Tenor 1 & 2" on one stave is both tenor sections;
 *   - "Bass 1" is the baritone line;
 *   - in a two-part score, "Basses" (or "Bass") is baritones and basses.
 * Each section takes its best-fitting part. When two sections end up on the
 * same stave and it has two voices, the higher section sings the upper voice.
 */

import { labelScore, partFromSection, type Family, type Part } from '@/lib/partLine.ts';
import type { ScoreModel } from './score.ts';

export interface SectionLike {
  id: number;
  label: string;
  badge: string;
}

export interface PartAssignment {
  /** Index into ScoreModel.parts. */
  part: number;
  /** For a stave shared by two sections: 0 = upper voice, 1 = lower. Null =
   *  the whole part. */
  voiceRank: 0 | 1 | null;
}

const FAMILY_ORDER: Family[] = ['soprano', 'alto', 'tenor', 'baritone', 'bass'];

/** Top to bottom: soprano before alto, Tenor 1 before Tenor 2. */
function rank(p: Part): number {
  return FAMILY_ORDER.indexOf(p.family) * 3 + (p.num ?? 1.5);
}

export function assignParts(model: ScoreModel, sections: SectionLike[]): Map<number, PartAssignment> {
  const out = new Map<number, PartAssignment>();
  const sung = sections
    .map((s) => ({ id: s.id, part: partFromSection(s.label, s.badge) }))
    .filter((s): s is { id: number; part: Part } => s.part !== null);

  const fit = (label: string, abbr: string, part: Part) =>
    Math.max(labelScore(label, part), abbr ? labelScore(abbr, part) : 0);
  const scores = sung.map((s) => model.parts.map((p) => fit(p.name, p.abbreviation, s.part)));

  // Each section's best part. A tie goes to a part no other section fits
  // exactly — so a plain "Bass" section takes "Bass 2" when the baritones
  // own "Bass 1" — and then to the topmost.
  const best = new Map<number, number>();
  sung.forEach((s, si) => {
    const row = scores[si]!;
    const top = Math.max(0, ...row);
    if (top === 0) return;
    const tied = row.flatMap((v, i) => (v === top ? [i] : []));
    const free = tied.find((i) => !scores.some((other, oi) => oi !== si && other[i] === 3));
    best.set(s.id, free ?? tied[0]!);
  });

  // Sections sharing a part split its voices, upper to the higher section.
  const byPart = new Map<number, Array<{ id: number; part: Part }>>();
  for (const s of sung) {
    const p = best.get(s.id);
    if (p === undefined) continue;
    byPart.set(p, [...(byPart.get(p) ?? []), s]);
  }
  for (const [part, group] of byPart) {
    group.sort((a, b) => rank(a.part) - rank(b.part));
    group.forEach((s, i) => {
      out.set(s.id, { part, voiceRank: group.length === 2 ? (i as 0 | 1) : null });
    });
  }
  return out;
}

/** Does a note belong to this section's line? */
export function noteIsSections(
  assignment: PartAssignment,
  note: { part: number; staff: number; voice: string; alone: boolean },
  voicesByStaff: Map<string, string[]>,
): boolean {
  if (note.part !== assignment.part) return false;
  if (assignment.voiceRank === null || note.alone) return true;
  const voices = voicesByStaff.get(`${note.part}:${note.staff}`) ?? [];
  if (voices.length < 2) return true;
  return voices.indexOf(note.voice) === assignment.voiceRank;
}

/** The voices used on each stave, in the order MusicXML numbers them (voice 1
 *  is written as the upper voice). Keyed "part:staff". */
export function voicesByStaff(model: ScoreModel): Map<string, string[]> {
  const m = new Map<string, Set<string>>();
  for (const n of model.notes.values()) {
    if (!n.pitched) continue;
    const k = `${n.part}:${n.staff}`;
    const set = m.get(k) ?? new Set<string>();
    set.add(n.voice);
    m.set(k, set);
  }
  return new Map([...m].map(([k, v]) => [k, [...v].sort((a, b) => Number(a) - Number(b))]));
}
