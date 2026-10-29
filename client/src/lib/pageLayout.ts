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
const cache = new Map<string, Promise<PageLayout>>();

export function analysePage(pdf: PDFDocumentProxy, pageNumber: number, cacheKey: string): Promise<PageLayout> {
  const key = `${cacheKey}:${pageNumber}`;
  let p = cache.get(key);
  if (!p) {
    p = run(pdf, pageNumber).catch(() => ({ content: { x0: 0, y0: 0, x1: 1, y1: 1 }, systems: [] }));
    cache.set(key, p);
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
  await page.render({ canvas, canvasContext: ctx, viewport }).promise;
  const { width: W, height: H } = canvas;
  const data = ctx.getImageData(0, 0, W, H).data;
  const image = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  canvas.width = canvas.height = 0;
  return { image, width: W, height: H, layout: await analyseOffThread(data, W, H) };
}

// One worker for all analysis; null once it has failed (e.g. a browser that
// can't load it), and analysis then runs on the main thread as before.
let worker: Worker | null | undefined;
let nextJob = 0;
const jobs = new Map<number, { data: Uint8ClampedArray; width: number; height: number; done: (l: PageLayout) => void }>();

function analyseOffThread(data: Uint8ClampedArray, width: number, height: number): Promise<PageLayout> {
  if (worker === undefined) {
    try {
      worker = new Worker(new URL('./pageBitmap.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (e: MessageEvent<{ id: number; layout: PageLayout }>) => {
        jobs.get(e.data.id)?.done(e.data.layout);
        jobs.delete(e.data.id);
      };
      worker.onerror = () => {
        worker?.terminate();
        worker = null;
        for (const j of jobs.values()) j.done(analyseBitmap(j.data, j.width, j.height));
        jobs.clear();
      };
    } catch {
      worker = null;
    }
  }
  if (!worker) return Promise.resolve(analyseBitmap(data, width, height));
  const w = worker;
  return new Promise((done) => {
    const id = nextJob++;
    // Copied, not transferred, so the main thread can still analyse it if the worker fails.
    jobs.set(id, { data, width, height, done });
    w.postMessage({ id, data, width, height });
  });
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
