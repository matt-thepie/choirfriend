/**
 * Playing a flowing score: a performance built from Verovio's timemap (which
 * plays repeats out in full) shaped by the markings in the score model.
 *
 *   tempo     the score's tempo marks, rit./rall. and a tempo; fermatas hold
 *             for longer; the reader's speed scales the lot
 *   loudness  dynamics, hairpins, cresc./dim., accents
 *   length    staccato / staccatissimo short, tenuto full, breath marks and
 *             caesuras breathe
 *   mix       like a learning track: one section's line brought forward with
 *             the others quieter behind it (or just that line)
 *
 * Times are in "q" — quarter notes along the performance — until the
 * Timeline turns them into seconds.
 */

import type { TimemapEntry, VerovioToolkit } from 'verovio/esm';
import { tempoAt, velocityAt, type ScoreModel, type ScoreNote } from './score.ts';
import { noteIsSections, type PartAssignment } from './parts.ts';
import { loadBank, type Bank, type SoundId } from './sampler.ts';

export interface PlayNote {
  /** Id in the timemap; a repeat's second time through ends "-rend2". */
  id: string;
  /** Id in the score (and in the drawn SVG). */
  baseId: string;
  q: number;
  qEnd: number;
  pitch: number;
  /** The tied-into part of a tie: lights up, but the first note sounds on. */
  silent: boolean;
  note: ScoreNote | undefined;
}

const FERMATA_HOLD = 1.8;
const CAESURA_S = 0.45;
const DEFAULT_BPM = 120;

/** Score part names that should always sound as a piano. */
export const isKeyboardPart = (name: string) => /piano|pno|keyboard|organ|accomp|rehearsal|harp/i.test(name);

/** The notes in played order, with ties merged and each note's place in the
 *  score. `tk` must hold the full score (every part). */
export function buildPlayNotes(
  tk: VerovioToolkit,
  model: ScoreModel,
): { notes: PlayNote[]; endQ: number; measureQ: Map<number, number>; bars: { q: number; measure: number }[] } {
  // Rests are included so bars where nothing sounds still get a start time.
  const tm: TimemapEntry[] = tk.renderToTimemap({ includeMeasures: true, includeRests: true });
  const mei = new DOMParser().parseFromString(tk.getMEI(), 'application/xml');

  // Measures in written order, so a bar on screen maps to when it first plays.
  const measureIndex = new Map<string, number>();
  Array.from(mei.getElementsByTagName('measure')).forEach((m, i) => {
    const id = m.getAttribute('xml:id');
    if (id) measureIndex.set(id, i);
  });

  const starts = new Map<string, number>();
  const notes: PlayNote[] = [];
  const measureQ = new Map<number, number>();
  /** Every bar start in played order, repeats included. */
  const bars: { q: number; measure: number }[] = [];
  let endQ = 0;
  for (const e of tm) {
    if (e.measureOn) {
      const i = measureIndex.get(e.measureOn.replace(/-rend\d+$/, ''));
      if (i !== undefined) {
        if (!measureQ.has(i)) measureQ.set(i, e.qstamp);
        bars.push({ q: e.qstamp, measure: i });
      }
    }
    for (const id of e.on ?? []) starts.set(id, e.qstamp);
    for (const id of e.off ?? []) {
      const q = starts.get(id);
      if (q === undefined) continue;
      starts.delete(id);
      const midi = tk.getMIDIValuesForElement(id);
      if (!midi || midi.pitch <= 0) continue;
      const baseId = id.replace(/-rend\d+$/, '');
      notes.push({ id, baseId, q, qEnd: e.qstamp, pitch: midi.pitch, silent: false, note: model.notes.get(baseId) });
    }
    endQ = Math.max(endQ, e.qstamp);
  }
  notes.sort((a, b) => a.q - b.q || b.pitch - a.pitch);

  // A tie sounds once for its whole length.
  const next = new Map<string, string>();
  for (const t of Array.from(mei.getElementsByTagName('tie'))) {
    const s = (t.getAttribute('startid') ?? '').replace(/^#/, '');
    const e = (t.getAttribute('endid') ?? '').replace(/^#/, '');
    if (s && e) next.set(s, e);
  }
  const byId = new Map(notes.map((n) => [n.id, n]));
  for (const n of notes) {
    if (n.silent) continue;
    const rend = /-rend\d+$/.exec(n.id)?.[0] ?? '';
    let cur = n.baseId;
    let tail: PlayNote | undefined;
    while (next.has(cur) && (tail = byId.get(next.get(cur)! + rend)) && tail.pitch === n.pitch && !tail.silent) {
      tail.silent = true;
      n.qEnd = Math.max(n.qEnd, tail.qEnd);
      cur = next.get(cur)!;
    }
  }
  bars.sort((a, b) => a.q - b.q);
  return { notes, endQ, measureQ, bars };
}

/** Performance clock: q ↔ seconds, with tempo changes, rits and fermatas. */
export class Timeline {
  private qs: number[] = [];
  private ts: number[] = [];
  private spq: number[] = []; // seconds per quarter in each segment
  readonly endQ: number;

  constructor(notes: PlayNote[], endQ: number, model: ScoreModel, bpm: number) {
    this.endQ = endQ;
    const scale = bpm / (model.markedTempo ?? DEFAULT_BPM);
    // Written position at each onset (the first note found there).
    const at = new Map<number, number>();
    const holds: Array<[number, number]> = [];
    const pauses = new Set<number>();
    for (const n of notes) {
      if (n.note && !at.has(n.q)) at.set(n.q, n.note.pos);
      if (n.note?.fermata && !n.silent) holds.push([n.q, n.qEnd]);
      if (n.note?.artic.includes('caesura')) pauses.add(n.qEnd);
    }
    const onsets = [...new Set([0, ...notes.map((n) => n.q), ...notes.map((n) => n.qEnd), endQ])].sort((a, b) => a - b);
    let t = 0;
    let lastPos = 0;
    for (let i = 0; i < onsets.length; i++) {
      const q = onsets[i]!;
      if (pauses.has(q)) t += CAESURA_S;
      const pos = at.get(q) ?? lastPos + (i > 0 ? q - onsets[i - 1]! : 0);
      lastPos = pos;
      let qbpm = tempoAt(model, pos, model.markedTempo ?? DEFAULT_BPM) * scale;
      if (holds.some(([a, b]) => q >= a && q < b)) qbpm /= FERMATA_HOLD;
      this.qs.push(q);
      this.ts.push(t);
      this.spq.push(60 / Math.max(10, qbpm));
      const qNext = onsets[i + 1];
      if (qNext !== undefined) t += (qNext - q) * this.spq[i]!;
    }
  }

  private seg(q: number): number {
    let lo = 0;
    let hi = this.qs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.qs[mid]! <= q) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  time(q: number): number {
    if (!this.qs.length) return 0;
    const i = this.seg(q);
    return this.ts[i]! + (q - this.qs[i]!) * this.spq[i]!;
  }

  q(time: number): number {
    if (!this.qs.length) return 0;
    let lo = 0;
    let hi = this.ts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.ts[mid]! <= time) lo = mid;
      else hi = mid - 1;
    }
    return this.qs[lo]! + (time - this.ts[lo]!) / this.spq[lo]!;
  }
}

export type MixMode = 'balanced' | 'mine' | 'solo';

export interface Mix {
  mode: MixMode;
  /** The section line to bring forward; null plays every part equally. */
  line: PartAssignment | null;
  voices: Map<string, string[]>;
}

/** How loud and how long a note sounds, from its markings and the mix. */
export function shapeNote(n: PlayNote, model: ScoreModel, mix: Mix): { gain: number; lengthQ: number } | null {
  const note = n.note;
  let vel = note ? velocityAt(model.dynamics[note.part] ?? [{ pos: 0, vel: 78 }], note.pos) : 78;
  let length = n.qEnd - n.q;
  const artic = note?.artic ?? [];
  if (artic.includes('accent')) vel *= 1.22;
  if (artic.includes('strong-accent')) vel *= 1.35;
  if (artic.includes('staccatissimo') || artic.includes('spiccato')) length = Math.min(length * 0.3, 0.3);
  else if (artic.includes('staccato')) length = Math.min(length * 0.5, 0.6);
  else if (artic.includes('detached-legato')) length *= 0.75;
  else if (!artic.includes('tenuto')) length *= 0.96; // a hair of air between notes
  if (artic.includes('breath-mark')) length = Math.max(length * 0.6, length - 0.3);

  let mixGain = 1;
  if (mix.line && note && mix.mode !== 'balanced') {
    const mine = noteIsSections(mix.line, note, mix.voices);
    if (!mine) {
      if (mix.mode === 'solo') return null;
      mixGain = 0.28;
    }
  }
  const v = Math.min(127, vel) / 127;
  return { gain: Math.pow(v, 1.6) * mixGain, lengthQ: Math.max(0.05, length) };
}

export interface PlayerOptions {
  model: ScoreModel;
  notes: PlayNote[];
  timeline: Timeline;
  sound: SoundId;
  mix: Mix;
}

/**
 * Schedules notes a little ahead on the Web Audio clock. One per score view;
 * call stop() before dropping it.
 */
export class FlowPlayer {
  private ctx: AudioContext | null = null;
  private out: GainNode | null = null;
  private opts: PlayerOptions;
  private sources: AudioBufferSourceNode[] = [];
  private timer = 0;
  private next = 0;
  private t0 = 0; // ctx time at which performance time `time0` plays
  private time0 = 0;
  private token = 0;
  private banks: { voice: Bank; keys: Bank } | null = null;
  playing = false;
  onEnded: (() => void) | null = null;

  constructor(opts: PlayerOptions) {
    this.opts = opts;
  }

  update(patch: Partial<PlayerOptions>): void {
    this.opts = { ...this.opts, ...patch };
  }

  private ensureCtx(): AudioContext {
    if (!this.ctx) {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctx();
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.ratio.value = 4;
      const out = ctx.createGain();
      out.gain.value = 0.55;
      out.connect(comp).connect(ctx.destination);
      this.ctx = ctx;
      this.out = out;
    }
    return this.ctx;
  }

  /** Where playback is now, in performance quarters. */
  nowQ(): number {
    if (!this.ctx || !this.playing) return 0;
    return this.opts.timeline.q(this.time0 + (this.ctx.currentTime - this.t0));
  }

  /** Start from a point in the performance. Resolves once sound has started
   *  (or false if stopped, or the sounds failed to load, meanwhile). */
  async play(fromQ = 0): Promise<boolean> {
    this.stop();
    const token = this.token;
    const ctx = this.ensureCtx();
    void ctx.resume();
    const { sound } = this.opts;
    const [voice, keys] = await Promise.all([loadBank(ctx, sound), loadBank(ctx, 'piano')]);
    if (token !== this.token) return false;
    this.banks = { voice, keys };
    const { notes, timeline } = this.opts;
    this.time0 = timeline.time(fromQ);
    this.t0 = ctx.currentTime + 0.12;
    this.next = notes.findIndex((n) => n.q >= fromQ - 1e-6);
    if (this.next < 0) this.next = notes.length;
    this.playing = true;
    this.schedule();
    this.timer = window.setInterval(() => this.schedule(), 60);
    return true;
  }

  stop(): void {
    this.token++;
    if (!this.playing) return;
    this.playing = false;
    clearInterval(this.timer);
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    this.sources = [];
  }

  dispose(): void {
    this.stop();
    void this.ctx?.close();
    this.ctx = null;
  }

  private schedule(): void {
    const ctx = this.ctx!;
    const { notes, timeline, model, mix } = this.opts;
    const at = (q: number) => this.t0 + timeline.time(q) - this.time0;
    const horizon = ctx.currentTime + 0.4;
    while (this.next < notes.length && at(notes[this.next]!.q) < horizon) {
      const n = notes[this.next++]!;
      if (!n.silent) this.sound(n, at, shapeNote(n, model, mix));
    }
    if (this.sources.length > 600) this.sources = this.sources.slice(-300);
    if (this.next >= notes.length && ctx.currentTime > at(timeline.endQ) + 0.5) {
      this.stop();
      this.onEnded?.();
    }
  }

  private sound(n: PlayNote, at: (q: number) => number, shaped: { gain: number; lengthQ: number } | null): void {
    if (!shaped || !this.banks) return;
    const ctx = this.ctx!;
    const keyboard = n.note ? isKeyboardPart(this.opts.model.parts[n.note.part]?.name ?? '') : false;
    const bank = keyboard ? this.banks.keys : this.banks.voice;
    const picked = bank.pick(n.pitch);
    if (!picked) return;
    const start = Math.max(ctx.currentTime, at(n.q));
    const dur = Math.max(0.06, at(n.q + shaped.lengthQ) - at(n.q));
    const release = bank.sustained ? 0.09 : 0.3;
    const peak = 0.75 * shaped.gain;
    const src = ctx.createBufferSource();
    const g = ctx.createGain();
    src.buffer = picked.buffer;
    src.playbackRate.value = picked.rate;
    // Held oohs or trumpet outlast the ~3 s sample: loop its steady middle.
    if (bank.sustained && dur > (picked.buffer.duration / picked.rate) * 0.8) {
      src.loop = true;
      src.loopStart = picked.buffer.duration * 0.35;
      src.loopEnd = picked.buffer.duration * 0.75;
    }
    // Accents bite: a quicker attack.
    const accented = n.note?.artic.some((a) => a === 'accent' || a === 'strong-accent');
    const attack = bank.sustained ? (accented ? 0.012 : 0.035) : 0.004;
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(peak, start + attack);
    g.gain.setValueAtTime(peak, start + dur);
    g.gain.linearRampToValueAtTime(0, start + dur + release);
    src.connect(g).connect(this.out!);
    src.start(start);
    src.stop(start + dur + release + 0.02);
    this.sources.push(src);
  }
}
