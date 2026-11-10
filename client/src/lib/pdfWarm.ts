/**
 * A piece split over several PDFs is often attacca: part 2 starts the beat
 * after part 1 ends. Opening and drawing a part takes seconds on an old
 * tablet, so the viewer warms the next part while the reader is on the last
 * pages of this one. One part at most is kept warm; the viewer takes it over
 * when the reader turns into it, so its first pages show at once.
 */

import { openPdf } from './pdfjs.ts';
import { analysePage, DEBUG, docId, dropRasters } from './pageLayout.ts';
const dbg = (...a: unknown[]): void => { if (DEBUG) console.log('[warm]', ...a); };

type LoadingTask = ReturnType<typeof openPdf>;

let warm: { url: string; task: LoadingTask } | null = null;

/** Pages drawn ahead: the first page, and the turn after it. */
const WARM_PAGES = 2;

/** Open the PDF at `url` and draw its first pages. `cacheKey` is the file id
 *  the viewer uses for analysePage, so the layouts are found there too. */
export function warmPdf(url: string, cacheKey: string): void {
  if (warm?.url === url) return;
  dropWarmPdf();
  dbg('warm', url.split('/').pop());
  const task = openPdf({ url, disableRange: true });
  const mine = { url, task };
  warm = mine;
  task.promise
    .then(async (doc) => {
      dbg('warm loaded', url.split('/').pop(), 'doc', docId(doc));
      for (let p = 1; p <= Math.min(WARM_PAGES, doc.numPages); p++) {
        if (warm !== mine) return;
        await analysePage(doc, p, cacheKey);
      }
    })
    .catch(() => {
      if (warm === mine) warm = null;
    });
}

/** Hand the warmed task for `url` to the caller, who then owns it (and must
 *  destroy it as it would one it opened itself). Null when nothing is warm. */
export function takeWarmPdf(url: string): LoadingTask | null {
  if (!warm || warm.url !== url) return null;
  const { task } = warm;
  warm = null;
  dbg('take', url.split('/').pop());
  return task;
}

/** Forget the warm part: its rasters and the document go back. */
export function dropWarmPdf(): void {
  if (!warm) return;
  const { task, url } = warm;
  warm = null;
  dbg('drop', url.split('/').pop());
  task.promise.then(dropRasters, () => undefined);
  task.destroy();
}
