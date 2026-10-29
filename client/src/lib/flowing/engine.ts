/**
 * Engraving and playback data for flowing scores, made in a web worker and
 * saved on the device.
 *
 * On an old tablet Verovio takes ~18s to lay a score out, and on the main
 * thread that froze the page. In the worker the page stays tappable, and the
 * saved result means only the first open of a score (at a given width and
 * set of parts) waits at all.
 */

import { perform, type Job } from './jobs.ts';
import type { EngraveOptions, OriginalOptions } from './engrave.ts';
import type { PlaySource } from './playSource.ts';

// One worker for every score; null once it has failed (e.g. a browser that
// can't run module workers), and jobs then run on the main thread as before.
let worker: Worker | null | undefined;
let nextJob = 0;
const pending = new Map<number, { job: Job; resolve: (r: string | PlaySource) => void; reject: (e: Error) => void }>();

function run(job: Job): Promise<string | PlaySource> {
  if (worker === undefined) {
    try {
      worker = new Worker(new URL('./verovio-engine.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (e: MessageEvent<{ id: number; result?: string | PlaySource; error?: string }>) => {
        const p = pending.get(e.data.id);
        if (!p) return;
        pending.delete(e.data.id);
        if (e.data.error !== undefined) p.reject(new Error(e.data.error));
        else p.resolve(e.data.result!);
      };
      worker.onerror = () => {
        worker?.terminate();
        worker = null;
        for (const p of pending.values()) perform(p.job).then(p.resolve, p.reject);
        pending.clear();
      };
    } catch {
      worker = null;
    }
  }
  if (!worker) return perform(job);
  const w = worker;
  return new Promise((resolve, reject) => {
    const id = nextJob++;
    pending.set(id, { job, resolve, reject });
    w.postMessage({ id, job });
  });
}

// ------- Saved results -------------------------------------------------------

/** Bump the number when engrave.ts, playSource.ts or the Verovio version
 *  changes what comes out; sw.js keeps only the cache named here. */
export const ENGRAVED_CACHE = 'engraved-v1';
/** Saved results kept, oldest dropped first. */
const MAX_SAVED = 60;

async function digest(text: string): Promise<string | null> {
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null; // no crypto.subtle (insecure origin): just don't save
  }
}

async function saved<T>(xml: string, params: unknown, make: () => Promise<T>): Promise<T> {
  const hash = await digest(xml);
  let cache: Cache | null = null;
  const key = hash && `${location.origin}/__engraved/${hash}?${encodeURIComponent(JSON.stringify(params))}`;
  if (key) {
    try {
      cache = await caches.open(ENGRAVED_CACHE);
      const hit = await cache.match(key);
      if (hit) return (await hit.json()) as T;
    } catch {
      cache = null; // storage blocked or full
    }
  }
  const result = await make();
  if (cache && key) {
    const c = cache;
    void (async () => {
      await c.put(key, new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } }));
      const keys = await c.keys();
      for (const old of keys.slice(0, Math.max(0, keys.length - MAX_SAVED))) await c.delete(old);
    })().catch(() => {});
  }
  return result;
}

/** The score drawn to fit a width, as SVG. */
export function engraveScore(xml: string, opts: EngraveOptions): Promise<string> {
  return saved(xml, { op: 'engrave', ...opts }, () => run({ op: 'engrave', xml, opts }) as Promise<string>);
}

/** The score drawn with its own line breaks, as SVG. */
export function engraveScoreOriginal(xml: string, opts: OriginalOptions): Promise<string> {
  return saved(xml, { op: 'original', ...opts }, () => run({ op: 'original', xml, opts }) as Promise<string>);
}

/** What playback needs; `xml` must hold every part. */
export function scorePlaySource(xml: string): Promise<PlaySource> {
  return saved(xml, { op: 'play' }, () => run({ op: 'play', xml }) as Promise<PlaySource>);
}
