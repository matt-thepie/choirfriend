/**
 * What playback needs from Verovio, read out as plain data so it can be made
 * in a web worker (no DOMParser there) and saved between visits.
 */

import type { TimemapEntry, VerovioToolkit } from 'verovio/esm';

export interface PlaySource {
  /** Verovio's timemap, with measures and rests. */
  timemap: TimemapEntry[];
  /** Measure ids in written order. */
  measureIds: string[];
  /** Ties as [start note id, end note id]. */
  ties: Array<[string, string]>;
  /** MIDI pitch of every sounding element in the timemap. */
  pitches: Record<string, number>;
}

/** `tk` must hold the full score (every part), laid out without breaks. */
export function readPlaySource(tk: VerovioToolkit): PlaySource {
  // Rests are included so bars where nothing sounds still get a start time.
  const timemap = tk.renderToTimemap({ includeMeasures: true, includeRests: true });
  const mei = tk.getMEI();
  const measureIds = Array.from(mei.matchAll(/<measure\b[^>]*?\bxml:id="([^"]+)"/g), (m) => m[1]!);
  const ties: Array<[string, string]> = [];
  for (const [tag] of mei.matchAll(/<tie\b[^>]*>/g)) {
    const s = /\bstartid="#?([^"]+)"/.exec(tag)?.[1];
    const e = /\bendid="#?([^"]+)"/.exec(tag)?.[1];
    if (s && e) ties.push([s, e]);
  }
  const pitches: Record<string, number> = {};
  for (const e of timemap) {
    for (const id of e.off ?? []) {
      const midi = tk.getMIDIValuesForElement(id);
      if (midi && midi.pitch > 0) pitches[id] = midi.pitch;
    }
  }
  return { timemap, measureIds, ties, pitches };
}
