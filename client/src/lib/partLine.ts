/**
 * "My line": which stave in each system is the member's own part.
 *
 * Best guess first, then the member's corrections win:
 *   1. A correction for that system (tap a stave in Adjust).
 *   2. A part name printed beside a stave ("Tenor 1", "T. I", "Tenors").
 *   3. The same stave position as the last system with as many staves, so
 *      names printed only on the first system carry through the piece.
 *
 * Scores switch between "Tenors" (one stave) and "Tenor 1"/"Tenor 2" (two)
 * mid-piece, so a combined label counts as a match, just a weaker one than
 * the exact part.
 */

import type { PageLayout } from './pageLayout.ts';

/** page:system → stave index, or -1 for "not in this system". */
export type PartLineOverrides = Record<string, number>;

export const overrideKey = (page: number, system: number): string => `${page}:${system}`;

type Family = 'soprano' | 'alto' | 'tenor' | 'baritone' | 'bass';

const FAMILY_WORDS: Record<Family, string[]> = {
  soprano: ['soprano', 'sopranos', 'sop', 's'],
  alto: ['alto', 'altos', 'a'],
  tenor: ['tenor', 'tenors', 'ten', 't'],
  baritone: ['baritone', 'baritones', 'bari', 'bar'],
  bass: ['bass', 'basses', 'bs', 'b'],
};

interface Part {
  family: Family;
  /** 1 or 2 for divided parts; null when the part isn't numbered. */
  num: number | null;
}

/** "Tenor I" → "tenor 1", "1st Tenors" → "1 tenors", "T.1" → "t 1". */
function normalise(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/\b1st\b/g, ' 1 ')
    .replace(/\b2nd\b/g, ' 2 ')
    .replace(/\bii\b/g, ' 2 ')
    .replace(/\bi\b/g, ' 1 ')
    .replace(/([a-z])(\d)/g, '$1 $2')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** The member's part from their section's label/badge ("Tenor 1", "T1", "Bar"). */
export function partFromSection(label: string, badge: string): Part | null {
  for (const text of [label, badge]) {
    const words = normalise(text);
    for (const [family, names] of Object.entries(FAMILY_WORDS) as Array<[Family, string[]]>) {
      if (words.some((w) => names.includes(w))) {
        const num = words.find((w) => w === '1' || w === '2');
        return { family, num: num ? Number(num) : null };
      }
    }
  }
  return null;
}

/**
 * How well a stave label fits the part: 3 exact ("Tenor 1"), 2 shared
 * ("Tenors", "Tenor 1 & 2"), 1 nearest ("Bass" for a baritone), 0 no.
 */
export function labelScore(label: string, part: Part): number {
  const words = normalise(label);
  if (!words.length) return 0;
  const families = (Object.entries(FAMILY_WORDS) as Array<[Family, string[]]>)
    .filter(([, names]) => words.some((w) => names.includes(w)))
    .map(([f]) => f);
  const nums = words.filter((w) => w === '1' || w === '2').map(Number);

  let best = 0;
  if (families.includes(part.family)) {
    if (part.num === null || nums.length === 0) best = nums.length === 0 && part.num === null ? 3 : 2;
    else if (nums.length === 1) best = nums[0] === part.num ? 3 : 0;
    else best = nums.includes(part.num) ? 2 : 0;
  }
  // A stave shared with another family ("Bar. B.") is a partial fit.
  if (families.length > 1) best = Math.min(best, 2);
  if (part.family === 'baritone' && families.includes('bass')) {
    // "Bass 1" in TTBB is the baritone line; a plain bass stave in a
    // two-stave reduction is the best a baritone will get.
    best = Math.max(best, nums.length === 1 && nums[0] === 1 ? 3 : 1);
  }
  return best;
}

export interface PartBand {
  page: number;
  system: number;
  stave: number;
}

/**
 * Pick the stave for each system across the whole file. `layouts` may be
 * missing pages still being analysed; those are skipped and the carry-over
 * continues past them.
 */
export function resolvePartLine(
  layouts: Map<number, PageLayout>,
  pageCount: number,
  part: Part | null,
  overrides: PartLineOverrides,
): PartBand[] {
  const out: PartBand[] = [];
  // Last chosen stave index for systems of each size.
  const lastBySize = new Map<number, number>();
  for (let page = 1; page <= pageCount; page++) {
    const L = layouts.get(page);
    if (!L) continue;
    L.systems.forEach((sys, system) => {
      const n = sys.staves.length;
      let pick: number | null = null;
      const o = overrides[overrideKey(page, system)];
      if (o !== undefined) pick = o >= 0 && o < n ? o : -1;
      else if (part) {
        let bestScore = 0;
        sys.staves.forEach((st, i) => {
          const s = labelScore(st.label, part);
          if (s > bestScore) {
            bestScore = s;
            pick = i;
          }
        });
      }
      if (pick === null && lastBySize.has(n)) pick = lastBySize.get(n)!;
      if (pick === null) return;
      lastBySize.set(n, pick);
      if (pick >= 0) out.push({ page, system, stave: pick });
    });
  }
  return out;
}
