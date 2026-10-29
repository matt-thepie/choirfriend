/**
 * The Verovio work a flowing score needs, as self-contained jobs. engine.ts
 * runs them in a web worker, or here on the main thread if the worker can't
 * start.
 */

import type { VerovioToolkit } from 'verovio/esm';
import { createToolkit } from './verovio.ts';
import { engrave, engraveOriginal, type EngraveOptions, type OriginalOptions } from './engrave.ts';
import { readPlaySource, type PlaySource } from './playSource.ts';

export type Job =
  | { op: 'engrave'; xml: string; opts: EngraveOptions }
  | { op: 'original'; xml: string; opts: OriginalOptions }
  | { op: 'play'; xml: string };

// One toolkit for drawing and one holding every part for playback, since
// hidden parts still sound. Both use the same id seed, so the ids the player
// lights up match the drawn notes.
let viewTk: Promise<VerovioToolkit> | null = null;
let playTk: Promise<VerovioToolkit> | null = null;

export async function perform(job: Job): Promise<string | PlaySource> {
  if (job.op === 'play') {
    const tk = await (playTk ??= createToolkit());
    tk.setOptions({ breaks: 'none' });
    tk.loadData(job.xml);
    return readPlaySource(tk);
  }
  const tk = await (viewTk ??= createToolkit());
  return job.op === 'original' ? engraveOriginal(tk, job.xml, job.opts) : engrave(tk, job.xml, job.opts);
}
