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

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface Stave {
  /** Top and bottom staff lines. */
  y0: number;
  y1: number;
  /** Where the staff lines start (after any indent). */
  x0: number;
  /** Text printed left of the stave, e.g. "Tenor 1". Empty if none. */
  label: string;
}

export interface PageLayout {
  /** Content box with a small pad; the whole page when nothing was found. */
  content: Box;
  /** Vertical bands, top to bottom, one per system. Empty if no staves found. */
  systems: Array<{ y0: number; y1: number; staves: Stave[] }>;
}

const ANALYSIS_WIDTH = 1400;
const INK = 200; // luminance below this counts as ink
const FAINT = 235; // staff lines and barlines are hairlines that anti-alias to light grey
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
  const layout = analyseBitmap(ctx.getImageData(0, 0, W, H).data, W, H);
  const image = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  canvas.width = canvas.height = 0;
  return { image, width: W, height: H, layout };
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

/** Pure pixel analysis; exported for testing. `data` is RGBA. */
export function analyseBitmap(data: Uint8ClampedArray, W: number, H: number, debug?: string[]): PageLayout {
  const dark = new Uint8Array(W * H);
  const faint = new Uint8Array(W * H);
  for (let i = 0, j = 0; j < W * H; i += 4, j++) {
    // Transparent pixels are paper.
    const lum = data[i + 3]! < 128 ? 255 : 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
    dark[j] = lum < INK ? 1 : 0;
    faint[j] = lum < FAINT ? 1 : 0;
  }
  const rowInk = new Uint32Array(H);
  const colInk = new Uint32Array(W);
  for (let y = 0; y < H; y++) {
    let n = 0;
    for (let x = 0; x < W; x++) {
      if (dark[y * W + x]) {
        n++;
        colInk[x]!++;
      }
    }
    rowInk[y] = n;
  }

  // --- content box: ignore specks (scanner dust, page numbers stay in) ----
  const minRow = 2;
  const minCol = 2;
  let top = 0;
  while (top < H && rowInk[top]! < minRow) top++;
  let bottom = H - 1;
  while (bottom > top && rowInk[bottom]! < minRow) bottom--;
  let left = 0;
  while (left < W && colInk[left]! < minCol) left++;
  let right = W - 1;
  while (right > left && colInk[right]! < minCol) right--;
  if (top >= bottom || left >= right) {
    return { content: { x0: 0, y0: 0, x1: 1, y1: 1 }, systems: [] };
  }
  const pad = Math.round(W * 0.012);
  const content: Box = {
    x0: Math.max(0, left - pad) / W,
    y0: Math.max(0, top - pad) / H,
    x1: Math.min(W, right + 1 + pad) / W,
    y1: Math.min(H, bottom + 1 + pad) / H,
  };

  // --- staff lines: rows where a long horizontal run of ink exists --------
  const contentW = right - left + 1;
  const minRun = contentW * 0.35;
  const isLine = new Uint8Array(H);
  const rowFaint = new Uint32Array(H);
  for (let y = top; y <= bottom; y++) {
    let n = 0;
    for (let x = left; x <= right; x++) n += faint[y * W + x]!;
    rowFaint[y] = n;
  }
  for (let y = top; y <= bottom; y++) {
    if (rowFaint[y]! + (rowFaint[y - 1] ?? 0) + (rowFaint[y + 1] ?? 0) < minRun) continue;
    // Union with the rows either side so slightly skewed scans still read as
    // one line; bridge breaks of up to 3px (anti-aliasing, scan noise).
    const y0 = Math.max(0, y - 1);
    const y1 = Math.min(H - 1, y + 1);
    let run = 0;
    let best = 0;
    let gap = 0;
    for (let x = left; x <= right; x++) {
      const hit = faint[y * W + x] || faint[y0 * W + x] || faint[y1 * W + x];
      if (hit) {
        run += gap + 1;
        gap = 0;
        if (run > best) best = run;
      } else if (run > 0 && gap < 3) gap++;
      else {
        run = 0;
        gap = 0;
      }
    }
    if (best >= minRun) isLine[y] = 1;
  }
  const lines: Array<{ y: number; y0: number; y1: number }> = [];
  for (let y = top; y <= bottom; y++) {
    if (!isLine[y]) continue;
    const y0 = y;
    while (y + 1 <= bottom && isLine[y + 1]) y++;
    // Thick bands are beams or text bars, not staff lines. (The 3-row union
    // above widens every real line by 2px.)
    if (y - y0 + 1 <= Math.max(5, H * 0.006)) lines.push({ y: (y0 + y) / 2, y0: y0 + 1, y1: Math.max(y0 + 1, y - 1) });
  }
  if (lines.length < 4) return { content, systems: [] };

  // Typical spacing between lines within a stave = small gaps.
  const gaps = lines.slice(1).map((l, i) => l.y - lines[i]!.y).sort((a, b) => a - b);
  const s = gaps[Math.floor(gaps.length * 0.25)]!;
  const staves: Array<{ top: number; bottom: number; lines: typeof lines }> = [];
  let cur: typeof lines = [lines[0]!];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.y - lines[i - 1]!.y <= s * 1.6) cur.push(lines[i]!);
    else {
      if (cur.length >= 4) staves.push({ top: cur[0]!.y0, bottom: cur[cur.length - 1]!.y1, lines: cur });
      cur = [lines[i]!];
    }
  }
  if (cur.length >= 4) staves.push({ top: cur[0]!.y0, bottom: cur[cur.length - 1]!.y1, lines: cur });
  if (staves.length === 0) return { content, systems: [] };

  // Two staves are one system when a near-continuous vertical line joins
  // them: the system barline, bracket or brace at the left, or barlines that
  // run through. Look in the left third, tolerating 2px of skew/thickness.
  const joinRight = left + Math.round(contentW / 3);
  function joined(a: (typeof staves)[number], b: (typeof staves)[number]): boolean {
    const span = b.top - a.bottom;
    if (span <= 0) return true;
    let bestCov = 0;
    for (let x = left; x <= joinRight; x++) {
      let ink = 0;
      for (let y = a.bottom; y <= b.top; y++) {
        const r = y * W;
        for (let dx = -2; dx <= 2; dx++) {
          const xx = x + dx;
          if (xx >= 0 && xx < W && faint[r + xx]) {
            ink++;
            break;
          }
        }
      }
      if (ink >= span * 0.8) return true;
      if (ink / span > bestCov) bestCov = ink / span;
    }
    debug?.push(`split ${a.top}-${a.bottom} | ${b.top}-${b.bottom} s=${s.toFixed(1)} best ${bestCov.toFixed(2)}`);
    return false;
  }

  // Where a stave's lines start: the left end of the longest run on its
  // middle line. Indented first systems start further right.
  function lineStart(y: number): number {
    let run = 0;
    let gap = 0;
    let start = left;
    let best = 0;
    let bestStart = left;
    for (let x = left; x <= right; x++) {
      const hit = faint[(y - 1) * W + x] || faint[y * W + x] || faint[(y + 1) * W + x];
      if (hit) {
        if (run === 0) start = x;
        run += gap + 1;
        gap = 0;
        if (run > best) {
          best = run;
          bestStart = start;
        }
      } else if (run > 0 && gap < 3) gap++;
      else {
        run = 0;
        gap = 0;
      }
    }
    return bestStart;
  }
  const toStave = (st: (typeof staves)[number]): Stave => ({
    y0: st.top / H,
    y1: (st.bottom + 1) / H,
    x0: lineStart(Math.round(st.lines[Math.floor(st.lines.length / 2)]!.y)) / W,
    label: '',
  });

  const groups: Array<{ top: number; bottom: number; staves: Stave[] }> = [];
  let g = { top: staves[0]!.top, bottom: staves[0]!.bottom, staves: [toStave(staves[0]!)] };
  for (let i = 1; i < staves.length; i++) {
    if (joined(staves[i - 1]!, staves[i]!)) {
      g.bottom = staves[i]!.bottom;
      g.staves.push(toStave(staves[i]!));
    } else {
      groups.push(g);
      g = { top: staves[i]!.top, bottom: staves[i]!.bottom, staves: [toStave(staves[i]!)] };
    }
  }
  groups.push(g);

  // Cut between systems at the emptiest row of each gap (ties → the middle).
  const cuts: number[] = [];
  for (let i = 1; i < groups.length; i++) {
    const a = groups[i - 1]!.bottom;
    const b = groups[i]!.top;
    let best = Math.round((a + b) / 2);
    let bestInk = Infinity;
    const mid = (a + b) / 2;
    for (let y = a + 1; y < b; y++) {
      const ink = rowInk[y]!;
      if (ink < bestInk || (ink === bestInk && Math.abs(y - mid) < Math.abs(best - mid))) {
        bestInk = ink;
        best = y;
      }
    }
    cuts.push(best);
  }
  const edges = [Math.max(0, top - pad), ...cuts, Math.min(H, bottom + 1 + pad)];
  const systems = edges.slice(1).map((e, i) => ({ y0: edges[i]! / H, y1: e / H, staves: groups[i]!.staves }));
  return { content, systems };
}
