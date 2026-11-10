/**
 * Page layout analysis for the full-screen (read mode) viewer.
 *
 * Renders a page once at low resolution and finds, from the pixels:
 *   - the content box (so white margins can be cropped away), and
 *   - the systems (lines of music), so read mode can show one, two or three
 *     systems, or half a page, at a time.
 *
 * Systems are found without any model: staff lines are rows with a long run
 * of dark pixels; five closely spaced lines make a stave; staves joined by a
 * vertical line at their left end (the system barline / brace) make one
 * system. Each cut between systems goes through the emptiest row of the gap,
 * so lyrics and dynamics stay with the music they belong to.
 *
 * Each system also lists its staves, with any part name printed to the
 * left of the stave ("Tenor 1", "T.", "Bass") taken from the PDF's text
 * layer. Scanned PDFs have no text, so labels are empty there.
 *
 * All coordinates are fractions of the page (0..1), independent of scale.
 */

import type { PDFDocumentProxy } from '@/lib/pdfjs.ts';
import { analyseBitmap, type PageLayout } from './pageBitmap.ts';

export type { Box, Stave, PageLayout } from './pageBitmap.ts';
export { analyseBitmap } from './pageBitmap.ts';

const ANALYSIS_WIDTH = 1400;

/** Finished layouts by file id and page. Only successes are kept, so a page
 *  whose analysis failed (or was cut short) is tried again next time. */
const settled = new Map<string, PageLayout>();
/** Analyses under way, per document. pdf.js never settles a call made on a
 *  document that is then destroyed, so an in-flight promise must not outlive
 *  its document: keyed by file id it would be handed back on the next open
 *  of the same file and hang "Preparing pages" until a reload. */
const inFlight = new WeakMap<PDFDocumentProxy, Map<number, Promise<PageLayout>>>();
const FALLBACK: PageLayout = { content: { x0: 0, y0: 0, x1: 1, y1: 1 }, systems: [] };

export function analysePage(pdf: PDFDocumentProxy, pageNumber: number, cacheKey: string): Promise<PageLayout> {
  const key = `${cacheKey}:${pageNumber}`;
  const done = settled.get(key);
  if (done) return Promise.resolve(done);
  let pages = inFlight.get(pdf);
  if (!pages) inFlight.set(pdf, (pages = new Map()));
  let p = pages.get(pageNumber);
  if (!p) {
    p = run(pdf, pageNumber).then(
      (layout) => {
        settled.set(key, layout);
        return layout;
      },
      () => FALLBACK,
    );
    p.finally(() => pages!.delete(pageNumber)).catch(() => undefined);
    pages.set(pageNumber, p);
  }
  return p;
}

/** A whole page drawn once at ANALYSIS_WIDTH, kept as a PNG. */
export interface PageRaster {
  image: Blob | null;
  /** Pixel size of `image`. */
  width: number;
  height: number;
  /** Pixel analysis only; stave labels are added by analysePage. */
  layout: PageLayout;
}

/** Pixel width of a page raster; the viewer reuses it whenever the screen
 *  needs no more detail than this. */
export const RASTER_WIDTH = ANALYSIS_WIDTH;
const rasters = new WeakMap<PDFDocumentProxy, Map<number, Promise<PageRaster>>>();

/**
 * Draw a page once and keep it, so analysis and display share one pdf.js
 * render. A dense score takes seconds to draw on an old tablet; showing
 * the kept PNG takes milliseconds, which makes page turns instant there.
 */
export function pageRaster(pdf: PDFDocumentProxy, pageNumber: number): Promise<PageRaster> {
  let pages = rasters.get(pdf);
  if (!pages) rasters.set(pdf, (pages = new Map()));
  let p = pages.get(pageNumber);
  if (!p) {
    p = rasterise(pdf, pageNumber);
    pages.set(pageNumber, p);
    // A failed render may succeed later; don't cache it.
    p.catch(() => pages.delete(pageNumber));
  }
  return p;
}

/** Forget a document's kept rasters: they are by far the most memory a
 *  score holds, so the viewer drops them as soon as the score closes. */
export function dropRasters(pdf: PDFDocumentProxy): void {
  rasters.delete(pdf);
  inFlight.delete(pdf);
}

async function rasterise(pdf: PDFDocumentProxy, pageNumber: number): Promise<PageRaster> {
  const page = await pdf.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: ANALYSIS_WIDTH / base.width });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('no 2d context');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const t0 = performance.now();
  await page.render({ canvas, canvasContext: ctx, viewport }).promise;
  const tRender = performance.now() - t0;
  const { width: W, height: H } = canvas;
  const data = ctx.getImageData(0, 0, W, H).data;
  // The worker analyses the pixels and encodes the PNG; encoding a page on
  // the main thread took several seconds on an old tablet and swallowed taps.
  const r = await analyseOffThread(data, W, H);
  const image = r.image ?? (await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png')));
  dbg(`raster p${pageNumber} doc ${docId(pdf)}: render ${Math.round(tRender)}ms, analyse+png ${Math.round(performance.now() - t0 - tRender)}ms (${r.image ? 'worker' : 'main thread'}), ${image?.size ?? 0} bytes`);
  canvas.width = canvas.height = 0;
  return { image, width: W, height: H, layout: r.layout };
}

// One worker for all analysis; null once it has failed (e.g. a browser that
// can't load it), and analysis then runs on the main thread as before.
let worker: Worker | null | undefined;
let nextJob = 0;
interface Analysed {
  layout: PageLayout;
  /** The page as a PNG, when the worker could encode it (OffscreenCanvas). */
  image: Blob | null;
}
const jobs = new Map<number, { data: Uint8ClampedArray; width: number; height: number; done: (r: Analysed) => void }>();

/** iOS Safari kills a worker under memory pressure without an error event,
 *  which would leave every page's analysis hanging and "My line" blank. A
 *  page takes under a second to analyse, so an unanswered job after this
 *  long means the worker is gone: finish it, and the rest, on this thread.
 *  The worker takes jobs in order, so the clock runs on the job at the head
 *  of the queue only: a slow tablet with six pages queued must not count
 *  the wait behind the others against the last one. */
const JOB_TIMEOUT_MS = 20_000;
let watchdog: ReturnType<typeof setTimeout> | null = null;

function armWatchdog(): void {
  if (watchdog !== null) clearTimeout(watchdog);
  watchdog = jobs.size > 0 ? setTimeout(workerLost, JOB_TIMEOUT_MS) : null;
}

function workerLost(): void {
  if (watchdog !== null) clearTimeout(watchdog);
  watchdog = null;
  worker?.terminate();
  worker = null;
  for (const j of jobs.values()) j.done({ layout: analyseBitmap(j.data, j.width, j.height), image: null });
  jobs.clear();
}

function analyseOffThread(data: Uint8ClampedArray, width: number, height: number): Promise<Analysed> {
  if (worker === undefined) {
    try {
      worker = new Worker(new URL('./pageBitmap.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (e: MessageEvent<{ id: number; layout: PageLayout; image: Blob | null; error?: string | null }>) => {
        const j = jobs.get(e.data.id);
        if (!j) return;
        if (e.data.error) dbg('worker png failed:', e.data.error);
        jobs.delete(e.data.id);
        armWatchdog();
        j.done({ layout: e.data.layout, image: e.data.image ?? null });
      };
      worker.onerror = workerLost;
    } catch {
      worker = null;
    }
  }
  if (!worker) return Promise.resolve({ layout: analyseBitmap(data, width, height), image: null });
  const w = worker;
  return new Promise((done) => {
    const id = nextJob++;
    // Copied, not transferred, so the main thread can still analyse it if the worker fails.
    jobs.set(id, { data, width, height, done });
    if (jobs.size === 1) armWatchdog();
    w.postMessage({ id, data, width, height });
  });
}

/** Set localStorage cf.debug=1 to log how long each page takes to prepare,
 *  and when documents open, warm and close; handy over adb on a tablet. */
export const DEBUG = typeof localStorage !== 'undefined' && localStorage.getItem('cf.debug') === '1';
const dbg = (...a: unknown[]): void => { if (DEBUG) console.log('[layout]', ...a); };
const docIds = new WeakMap<object, number>();
let nextDocId = 1;
/** Debug: a short serial for a document. */
export function docId(doc: object): number {
  let id = docIds.get(doc);
  if (!id) docIds.set(doc, (id = nextDocId++));
  return id;
}

async function run(pdf: PDFDocumentProxy, pageNumber: number): Promise<PageLayout> {
  const page = await pdf.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  // Copy: labelStaves writes into it, and the raster's layout is shared.
  const layout = JSON.parse(JSON.stringify((await pageRaster(pdf, pageNumber)).layout)) as PageLayout;
  try {
    const text = await page.getTextContent();
    const items: TextItem[] = [];
    for (const it of text.items) {
      if (!('str' in it) || !it.str.trim()) continue;
      const [x, y] = base.convertToViewportPoint(it.transform[4], it.transform[5]);
      // Baseline → rough vertical centre of the text.
      const h = Math.hypot(it.transform[2], it.transform[3]);
      items.push({ str: it.str, x: x / base.width, x1: (x + it.width) / base.width, y: (y - h * 0.35) / base.height });
    }
    labelStaves(layout, items);
  } catch {
    // no text layer; labels stay empty
  }
  return layout;
}

interface TextItem {
  str: string;
  x: number;
  x1: number;
  y: number;
}

/** Give each stave the text that sits left of it, within its vertical reach. */
export function labelStaves(layout: PageLayout, items: TextItem[]): void {
  for (const sys of layout.systems) {
    sys.staves.forEach((st, i) => {
      const h = st.y1 - st.y0;
      // Reach halfway to the neighbouring staves (or one stave height out).
      const above = i > 0 ? (sys.staves[i - 1]!.y1 + st.y0) / 2 : st.y0 - h;
      const below = i < sys.staves.length - 1 ? (st.y1 + sys.staves[i + 1]!.y0) / 2 : st.y1 + h;
      st.label = items
        .filter((t) => t.y >= above && t.y <= below && t.x1 <= st.x0 + 0.01)
        // Bar numbers sit above the top line; part numbers sit beside the stave.
        .filter((t) => !(/^\s*\d+\s*$/.test(t.str) && t.y < st.y0))
        .sort((a, b) => a.y - b.y || a.x - b.x)
        .map((t) => t.str.trim())
        .join(' ');
    });
  }
}
