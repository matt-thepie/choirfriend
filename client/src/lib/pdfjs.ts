/**
 * One place that touches pdfjs-dist's global worker config.
 *
 * Vite turns `?url` imports into a built asset URL, so the worker file is
 * bundled and hashed alongside the rest of the client. No special build
 * config needed.
 */

import * as pdfjsLib from 'pdfjs-dist';
// Vite-specific: bundle the worker as a separate asset and import its URL.
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

export { pdfjsLib };
export type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
