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
 * All coordinates are fractions of the page (0..1), independent of scale.
 */

import type { PDFDocumentProxy } from '@/lib/pdfjs.ts';

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface PageLayout {
  /** Content box with a small pad; the whole page when nothing was found. */
  content: Box;
  /** Vertical bands, top to bottom, one per system. Empty if no staves found. */
  systems: Array<{ y0: number; y1: number }>;
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

async function run(pdf: PDFDocumentProxy, pageNumber: number): Promise<PageLayout> {
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
  canvas.width = canvas.height = 0;
  return analyseBitmap(data, W, H);
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

  const groups: Array<{ top: number; bottom: number }> = [];
  let g = { top: staves[0]!.top, bottom: staves[0]!.bottom };
  for (let i = 1; i < staves.length; i++) {
    if (joined(staves[i - 1]!, staves[i]!)) g.bottom = staves[i]!.bottom;
    else {
      groups.push(g);
      g = { top: staves[i]!.top, bottom: staves[i]!.bottom };
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
  const systems = edges.slice(1).map((e, i) => ({ y0: edges[i]! / H, y1: e / H }));
  return { content, systems };
}
