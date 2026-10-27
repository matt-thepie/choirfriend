/**
 * Sampled instruments for flowing-score playback.
 *
 *   piano    Salamander Grand Piano (the same /piano/*.mp3 the piano widget
 *            plays), sampled at minor thirds.
 *   oohs     FluidR3 GM "Voice Oohs" and "Trumpet" (Frank Wen, MIT licence),
 *   trumpet  every third semitone C1–C7, in /sounds/<id>.json as data URIs.
 *
 * Other notes are pitch-shifted from the nearest sample. Each bank loads the
 * first time it's needed; the service worker keeps the files afterwards.
 */

export type SoundId = 'piano' | 'oohs' | 'trumpet';

export const SOUNDS: Array<{ id: SoundId; label: string }> = [
  { id: 'piano', label: 'Piano' },
  { id: 'oohs', label: 'Oohs' },
  { id: 'trumpet', label: 'Trumpet' },
];

export interface Bank {
  /** Pianos decay on their own; sustained sounds loop and need a release. */
  sustained: boolean;
  pick(midi: number): { buffer: AudioBuffer; rate: number } | null;
}

const banks = new Map<string, Promise<Bank>>();

function nearest(map: Map<number, AudioBuffer>, midi: number): { buffer: AudioBuffer; rate: number } | null {
  let best: number | null = null;
  for (const m of map.keys()) if (best === null || Math.abs(m - midi) < Math.abs(best - midi)) best = m;
  if (best === null) return null;
  return { buffer: map.get(best)!, rate: Math.pow(2, (midi - best) / 12) };
}

async function loadPiano(ctx: BaseAudioContext): Promise<Bank> {
  const notes: Array<{ midi: number; name: string }> = [];
  for (let octave = 0; octave <= 8; octave++) {
    for (const [pc, stem] of [[0, 'C'], [3, 'Ds'], [6, 'Fs'], [9, 'A']] as const) {
      const midi = (octave + 1) * 12 + pc;
      if (midi >= 21 && midi <= 108) notes.push({ midi, name: `${stem}${octave}` });
    }
  }
  const map = new Map<number, AudioBuffer>();
  await Promise.all(
    notes.map(async ({ midi, name }) => {
      const res = await fetch(`/piano/${name}.mp3`);
      if (!res.ok) throw new Error(`piano sample ${name}: HTTP ${res.status}`);
      map.set(midi, await ctx.decodeAudioData(await res.arrayBuffer()));
    }),
  );
  return { sustained: false, pick: (m) => nearest(map, m) };
}

async function loadJsonBank(ctx: BaseAudioContext, id: SoundId): Promise<Bank> {
  const res = await fetch(`/sounds/${id}.json`);
  if (!res.ok) throw new Error(`${id} sounds: HTTP ${res.status}`);
  const entries = Object.entries((await res.json()) as Record<string, string>);
  const map = new Map<number, AudioBuffer>();
  await Promise.all(
    entries.map(async ([midi, uri]) => {
      const bin = atob(uri.slice(uri.indexOf(',') + 1));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      map.set(Number(midi), await ctx.decodeAudioData(bytes.buffer));
    }),
  );
  return { sustained: true, pick: (m) => nearest(map, m) };
}

export function loadBank(ctx: BaseAudioContext, id: SoundId): Promise<Bank> {
  let p = banks.get(id);
  if (!p) {
    p = id === 'piano' ? loadPiano(ctx) : loadJsonBank(ctx, id);
    p.catch(() => banks.delete(id)); // let a later Play retry
    banks.set(id, p);
  }
  return p;
}
