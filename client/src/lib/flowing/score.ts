/**
 * What a flowing score needs to know about its MusicXML beyond the notes
 * Verovio draws: which part and voice each note belongs to, where it sits in
 * the score, and the markings that shape how it is played — dynamics,
 * hairpins, articulations, fermatas and tempo.
 *
 * Every <note> gets an id here before Verovio sees the file. Verovio keeps
 * MusicXML ids, so the notes it draws and times (its SVG and timemap) can be
 * looked up in this model directly.
 *
 * Positions ("pos") are in quarter notes from the start of the score, in
 * written order (repeats not played out); Verovio's timemap gives the played
 * order, and playback maps one onto the other.
 */

export interface ScorePart {
  id: string;
  name: string;
  abbreviation: string;
  /** Staves in this part (a piano part has two). */
  staves: number;
  /** Index of its first stave among all staves, top to bottom (0-based). */
  firstStave: number;
}

export type Articulation =
  | 'staccato'
  | 'staccatissimo'
  | 'spiccato'
  | 'accent'
  | 'strong-accent'
  | 'tenuto'
  | 'detached-legato'
  | 'breath-mark'
  | 'caesura';

export interface ScoreNote {
  part: number;
  /** Stave within the part, 1-based as in MusicXML. */
  staff: number;
  voice: string;
  pos: number;
  /** Written length in quarters (0 for grace notes). */
  dur: number;
  pitched: boolean;
  artic: Articulation[];
  fermata: boolean;
  /** No other voice on the same stave sounds alongside it, so a section
   *  singing either voice of that stave sings this note. */
  alone: boolean;
}

/** MIDI-style velocity (0–127) at a score position, for one part. Linear
 *  between breakpoints; two at the same position make a step. */
export interface DynPoint {
  pos: number;
  vel: number;
}

export type TempoEvent =
  | { pos: number; kind: 'set'; bpm: number }
  | { pos: number; kind: 'rit' }
  | { pos: number; kind: 'a-tempo' };

export interface ScoreMeasure {
  number: string;
  pos: number;
  len: number;
}

export interface ScoreModel {
  /** The MusicXML with note ids added and per-system stave hiding removed. */
  xml: string;
  parts: ScorePart[];
  notes: Map<string, ScoreNote>;
  dynamics: DynPoint[][];
  tempo: TempoEvent[];
  /** Quarter-note bpm of the first tempo marking, or null when there is none. */
  markedTempo: number | null;
  measures: ScoreMeasure[];
  rehearsals: Array<{ label: string; measure: number }>;
  /** Where each page of the MuseScore layout starts (page 1 at bar 0), or
   *  empty when the file carries no page breaks. */
  pages: Array<{ label: string; measure: number }>;
  /** The file carries its own line breaks (MuseScore's layout). */
  hasLayout: boolean;
  /** Width of the original page's music, in staff spaces. */
  layoutWidth: number | null;
  /** Title and creators from the file's header, where it has them. */
  credits: ScoreCredits;
}

export interface ScoreCredits {
  title: string | null;
  composer: string | null;
  arranger: string | null;
  lyricist: string | null;
}

function readCredits(doc: Document): ScoreCredits {
  const text = (sel: string) => doc.querySelector(sel)?.textContent?.trim() || null;
  return {
    title: text('work > work-title') ?? text('movement-title'),
    composer: text('identification > creator[type="composer"]'),
    arranger: text('identification > creator[type="arranger"]'),
    lyricist: text('identification > creator[type="lyricist"]') ?? text('identification > creator[type="poet"]'),
  };
}

/** The original page's printable width in staff spaces (MusicXML tenths
 *  are tenths of a staff space). */
function readLayoutWidth(doc: Document): number | null {
  const layout = doc.querySelector('defaults > page-layout');
  const width = Number(layout?.querySelector('page-width')?.textContent);
  if (!layout || !(width > 0)) return null;
  const margins = layout.querySelector('page-margins');
  const left = Number(margins?.querySelector('left-margin')?.textContent) || 0;
  const right = Number(margins?.querySelector('right-margin')?.textContent) || 0;
  return (width - left - right) / 10;
}

/** Velocities for the written dynamics, when MuseScore didn't export a
 *  <sound dynamics> alongside (it normally does: percent of forte, 90). */
const DYNAMIC_VEL: Record<string, number> = {
  pppppp: 5, ppppp: 8, pppp: 12, ppp: 22, pp: 36, p: 50, mp: 64, mf: 78, f: 92, ff: 106, fff: 118, ffff: 124, fffff: 126, ffffff: 127,
  fp: 92, sf: 100, sfz: 104, sffz: 112, sfp: 100, sfpp: 100, rf: 96, rfz: 96, fz: 100, n: 1, pf: 64,
};
/** Accent-like dynamics: loud for the note they sit on, then back. */
const ONE_NOTE_DYNAMICS = new Set(['sf', 'sfz', 'sffz', 'rf', 'rfz', 'fz']);
const DEFAULT_VEL = 78; // mf until the score says otherwise
/** A hairpin that ends without a new dynamic moves this far. */
const HAIRPIN_STEP = 16;

const ARTICULATIONS = new Set<string>([
  'staccato', 'staccatissimo', 'spiccato', 'accent', 'strong-accent', 'tenuto', 'detached-legato', 'breath-mark', 'caesura',
]);

const BEAT_UNIT_QUARTERS: Record<string, number> = {
  whole: 4, half: 2, quarter: 1, eighth: 0.5, '16th': 0.25, '32nd': 0.125, breve: 8,
};

const child = (el: Element, name: string): Element | null => {
  for (const c of Array.from(el.children)) if (c.localName === name) return c;
  return null;
};
const children = (el: Element, name: string): Element[] => Array.from(el.children).filter((c) => c.localName === name);
const num = (el: Element | null, fallback = 0): number => {
  const v = el ? Number(el.textContent) : NaN;
  return Number.isFinite(v) ? v : fallback;
};

/** Add an id to every <note>, in document order. */
function tagNotes(xml: string): string {
  let i = 0;
  return xml.replace(/<note(?=[\s>])(?![^>]*\sid=)/g, () => `<note id="n${i++}"`);
}

interface RawDirection {
  pos: number;
  kind: 'dyn' | 'cresc' | 'dim' | 'stop';
  vel?: number;
  oneNote?: boolean;
}

export function parseScore(rawXml: string): ScoreModel {
  const doc = new DOMParser().parseFromString(tagNotes(rawXml), 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('This score is not valid MusicXML.');
  // MuseScore hides empty staves system by system. Our systems reflow, so a
  // hidden stave would vanish mid-line; show every stave throughout.
  doc.querySelectorAll('staff-details[print-object="no"]').forEach((s) => s.remove());

  const root = doc.documentElement;
  const partEls = children(root, 'part');
  const names = new Map<string, { name: string; abbreviation: string }>();
  doc.querySelectorAll('part-list > score-part').forEach((sp) => {
    names.set(sp.getAttribute('id') ?? '', {
      name: child(sp, 'part-name')?.textContent?.trim() ?? '',
      abbreviation: child(sp, 'part-abbreviation')?.textContent?.trim() ?? '',
    });
  });

  const parts: ScorePart[] = [];
  const notes = new Map<string, ScoreNote>();
  const dynamics: DynPoint[][] = [];
  const tempo: TempoEvent[] = [];
  const measures: ScoreMeasure[] = [];
  const rehearsals: Array<{ label: string; measure: number }> = [];
  const pages: Array<{ label: string; measure: number }> = [];
  let hasLayout = false;
  let staveCount = 0;

  partEls.forEach((partEl, partIndex) => {
    const id = partEl.getAttribute('id') ?? `P${partIndex + 1}`;
    let staves = 1;
    let divisions = 1;
    let measureStart = 0;
    const directions: RawDirection[] = [];
    const partNotes: Array<{ id: string; note: ScoreNote }> = [];

    children(partEl, 'measure').forEach((m, mi) => {
      let cursor = 0; // in divisions, from the start of the measure
      let longest = 0;
      let lastStart = 0;
      for (const el of Array.from(m.children)) {
        switch (el.localName) {
          case 'attributes': {
            const d = child(el, 'divisions');
            if (d) divisions = num(d, 1) || 1;
            const s = child(el, 'staves');
            if (s) staves = Math.max(staves, num(s, 1));
            break;
          }
          case 'backup':
            cursor -= num(child(el, 'duration'));
            break;
          case 'forward':
            cursor += num(child(el, 'duration'));
            break;
          case 'note': {
            const grace = !!child(el, 'grace');
            const isChord = !!child(el, 'chord');
            const start = isChord ? lastStart : cursor;
            const d = grace ? 0 : num(child(el, 'duration'));
            if (!isChord) {
              lastStart = cursor;
              cursor += d;
            }
            const nid = el.getAttribute('id');
            if (!nid) break;
            const notations = child(el, 'notations');
            const artic: Articulation[] = [];
            let fermata = false;
            if (notations) {
              for (const a of children(notations, 'articulations')) {
                for (const c of Array.from(a.children)) if (ARTICULATIONS.has(c.localName)) artic.push(c.localName as Articulation);
              }
              fermata = children(notations, 'fermata').length > 0;
            }
            const note: ScoreNote = {
              part: partIndex,
              staff: num(child(el, 'staff'), 1) || 1,
              voice: child(el, 'voice')?.textContent?.trim() || '1',
              pos: measureStart + start / divisions,
              dur: d / divisions,
              pitched: !!child(el, 'pitch') || !!child(el, 'unpitched'),
              artic,
              fermata,
              alone: true,
            };
            notes.set(nid, note);
            partNotes.push({ id: nid, note });
            break;
          }
          case 'direction': {
            const offset = num(child(el, 'offset'));
            const pos = measureStart + (cursor + offset) / divisions;
            const sound = child(el, 'sound');
            const soundDyn = sound?.getAttribute('dynamics');
            const soundTempo = sound?.getAttribute('tempo');
            let tempoSet = false;
            for (const dt of children(el, 'direction-type')) {
              for (const c of Array.from(dt.children)) {
                if (c.localName === 'dynamics') {
                  const mark = c.firstElementChild?.localName ?? '';
                  const vel = soundDyn != null && Number.isFinite(Number(soundDyn))
                    ? Math.min(127, (Number(soundDyn) * 90) / 100)
                    : DYNAMIC_VEL[mark];
                  if (vel !== undefined) directions.push({ pos, kind: 'dyn', vel, oneNote: ONE_NOTE_DYNAMICS.has(mark) });
                } else if (c.localName === 'wedge') {
                  const t = c.getAttribute('type');
                  if (t === 'crescendo') directions.push({ pos, kind: 'cresc' });
                  else if (t === 'diminuendo') directions.push({ pos, kind: 'dim' });
                  else if (t === 'stop') directions.push({ pos, kind: 'stop' });
                } else if (c.localName === 'words') {
                  const w = (c.textContent ?? '').trim().toLowerCase();
                  if (/^cresc/.test(w)) directions.push({ pos, kind: 'cresc' });
                  else if (/^(dim|decresc)/.test(w)) directions.push({ pos, kind: 'dim' });
                  if (partIndex === 0) {
                    if (/^(rit|rall|allarg|slowing)/.test(w)) tempo.push({ pos, kind: 'rit' });
                    else if (/^(a tempo|tempo i|tempo primo)/.test(w)) tempo.push({ pos, kind: 'a-tempo' });
                  }
                } else if (c.localName === 'metronome' && partIndex === 0 && !soundTempo) {
                  const unit = BEAT_UNIT_QUARTERS[child(c, 'beat-unit')?.textContent?.trim() ?? ''] ?? 1;
                  const dotted = children(c, 'beat-unit-dot').length > 0 ? 1.5 : 1;
                  const per = num(child(c, 'per-minute'));
                  if (per > 0) {
                    tempo.push({ pos, kind: 'set', bpm: per * unit * dotted });
                    tempoSet = true;
                  }
                } else if (c.localName === 'rehearsal' && partIndex === 0) {
                  const label = (c.textContent ?? '').trim();
                  if (label) rehearsals.push({ label, measure: mi });
                }
              }
            }
            if (partIndex === 0 && soundTempo && !tempoSet && Number(soundTempo) > 0) {
              tempo.push({ pos, kind: 'set', bpm: Number(soundTempo) });
            }
            break;
          }
          case 'print': {
            if (partIndex !== 0) break;
            if (el.getAttribute('new-system') === 'yes') hasLayout = true;
            if (el.getAttribute('new-page') === 'yes') {
              hasLayout = true;
              if (!pages.length) pages.push({ label: '1', measure: 0 });
              pages.push({ label: el.getAttribute('page-number') || String(pages.length + 1), measure: mi });
            }
            break;
          }
          case 'sound': {
            // A bare <sound tempo> straight under the measure.
            const t = Number(el.getAttribute('tempo'));
            if (partIndex === 0 && t > 0) tempo.push({ pos: measureStart + cursor / divisions, kind: 'set', bpm: t });
            break;
          }
        }
        longest = Math.max(longest, cursor);
      }
      const len = longest / divisions;
      if (partIndex === 0) measures.push({ number: m.getAttribute('number') ?? String(mi + 1), pos: measureStart, len });
      // Every part has the same bars; the first part's lengths are the score's.
      measureStart = partIndex === 0 ? measureStart + len : (measures[mi + 1]?.pos ?? measureStart + len);
    });

    markAlone(partNotes.map((p) => p.note));
    dynamics.push(buildDynamics(directions));
    const nm = names.get(id) ?? { name: '', abbreviation: '' };
    parts.push({ id, name: nm.name, abbreviation: nm.abbreviation, staves, firstStave: staveCount });
    staveCount += staves;
  });

  tempo.sort((a, b) => a.pos - b.pos);
  const firstSet = tempo.find((t): t is Extract<TempoEvent, { kind: 'set' }> => t.kind === 'set');
  return {
    xml: new XMLSerializer().serializeToString(doc),
    parts,
    notes,
    dynamics,
    tempo,
    markedTempo: firstSet && firstSet.pos <= 4 ? firstSet.bpm : null,
    measures,
    rehearsals,
    pages,
    hasLayout,
    layoutWidth: readLayoutWidth(doc),
    credits: readCredits(doc),
  };
}

/** A note is "alone" when no other voice on its stave has a pitched note
 *  sounding at the same time (a divided stave in unison, say). */
function markAlone(list: ScoreNote[]): void {
  const byStaff = new Map<number, ScoreNote[]>();
  for (const n of list) {
    if (!n.pitched) continue;
    const arr = byStaff.get(n.staff) ?? [];
    arr.push(n);
    byStaff.set(n.staff, arr);
  }
  for (const arr of byStaff.values()) {
    arr.sort((a, b) => a.pos - b.pos);
    for (let i = 0; i < arr.length; i++) {
      const a = arr[i]!;
      const end = a.pos + Math.max(a.dur, 1e-6);
      // Overlaps can come from earlier notes still sounding, or later ones.
      for (let j = i - 1; j >= 0 && arr[j]!.pos + 8 > a.pos; j--) {
        const b = arr[j]!;
        if (b.voice !== a.voice && b.pos + b.dur > a.pos) { a.alone = false; break; }
      }
      if (!a.alone) continue;
      for (let j = i + 1; j < arr.length && arr[j]!.pos < end; j++) {
        if (arr[j]!.voice !== a.voice) { a.alone = false; break; }
      }
    }
  }
}

/** Turn a part's dynamics, hairpins and cresc./dim. into velocity breakpoints. */
function buildDynamics(dirs: RawDirection[]): DynPoint[] {
  dirs.sort((a, b) => a.pos - b.pos || order(a.kind) - order(b.kind));
  const pts: DynPoint[] = [{ pos: 0, vel: DEFAULT_VEL }];
  let level = DEFAULT_VEL;
  const point = (pos: number, vel: number) => pts.push({ pos, vel: Math.max(1, Math.min(127, vel)) });

  for (let i = 0; i < dirs.length; i++) {
    const d = dirs[i]!;
    if (d.kind === 'dyn') {
      point(d.pos, level); // hold until here, then step
      if (d.oneNote) {
        // sfz and friends: a jolt on the note, then the previous level.
        point(d.pos, d.vel!);
        point(d.pos + 0.5, level);
      } else {
        level = d.vel!;
        point(d.pos, level);
      }
    } else if (d.kind === 'cresc' || d.kind === 'dim') {
      // Runs to its stop (or the next dynamic), arriving at the next dynamic's
      // level if one follows straight after, otherwise a step louder/softer.
      let end: number | null = null;
      let target: number | null = null;
      for (let j = i + 1; j < dirs.length; j++) {
        const e = dirs[j]!;
        if (e.kind === 'stop' && end === null) end = e.pos;
        else if (e.kind === 'dyn' && !e.oneNote) {
          if (end === null || e.pos - end <= 1) {
            end ??= e.pos;
            target = e.vel!;
          }
          break;
        } else if (e.kind === 'cresc' || e.kind === 'dim') {
          end ??= e.pos;
          break;
        }
      }
      end ??= d.pos + 8;
      target ??= level + (d.kind === 'cresc' ? HAIRPIN_STEP : -HAIRPIN_STEP);
      if (end <= d.pos) continue;
      point(d.pos, level);
      level = Math.max(1, Math.min(127, target));
      point(end, level);
    }
  }
  return pts.sort((a, b) => a.pos - b.pos);
}

function order(kind: RawDirection['kind']): number {
  // At one position: a stop, then a new dynamic, then a new hairpin.
  return kind === 'stop' ? 0 : kind === 'dyn' ? 1 : 2;
}

/** Velocity for a part at a score position. */
export function velocityAt(points: DynPoint[], pos: number): number {
  let lo = 0;
  let hi = points.length - 1;
  if (pos <= points[0]!.pos) return points[0]!.vel;
  // Last breakpoint at or before pos.
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (points[mid]!.pos <= pos) lo = mid;
    else hi = mid - 1;
  }
  const a = points[lo]!;
  const b = points[lo + 1];
  if (!b || b.pos === a.pos) return a.vel;
  return a.vel + ((b.vel - a.vel) * (pos - a.pos)) / (b.pos - a.pos);
}

/** Quarter-note bpm at a score position, before the reader's own speed. */
export function tempoAt(model: ScoreModel, pos: number, fallbackBpm: number): number {
  let bpm = model.markedTempo ?? fallbackBpm;
  let rit: number | null = null;
  let ritEnd = Infinity;
  for (let i = 0; i < model.tempo.length; i++) {
    const t = model.tempo[i]!;
    if (t.pos > pos) break;
    if (t.kind === 'set') {
      bpm = t.bpm;
      rit = null;
    } else if (t.kind === 'a-tempo') {
      rit = null;
    } else {
      rit = t.pos;
      const next = model.tempo.slice(i + 1).find((x) => x.kind !== 'rit');
      ritEnd = next ? next.pos : Infinity;
    }
  }
  if (rit === null) return bpm;
  // A rit. eases down to three-quarters speed over two bars' worth (or until
  // the next tempo marking), then holds.
  const span = Math.min(8, ritEnd - rit);
  const k = Math.min(1, (pos - rit) / Math.max(span, 1));
  return bpm * (1 - 0.25 * k);
}
