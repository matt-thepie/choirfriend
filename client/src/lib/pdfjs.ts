/**
 * One place that touches pdfjs-dist's global worker config.
 *
 * Vite turns `?url` imports into a built asset URL, so the worker file is
 * bundled and hashed alongside the rest of the client. No special build
 * config needed.
 *
 * The legacy build carries polyfills (Promise.withResolvers and friends) that
 * the modern one assumes; without them the viewer crashes on browsers older
 * than Chrome 119, which some members' tablets still run.
 */

import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
// Vite-specific: bundle the worker as a separate asset and import its URL.
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import type { DocumentInitParameters } from 'pdfjs-dist/types/src/display/api';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

/** Where pdf.js fetches its wasm image decoders (JBIG2, JPEG 2000) from; see
 *  the pdfjsWasm plugin in vite.config.ts. Without this, scanned scores render
 *  as blank pages with only their OCR text layer showing. */
const WASM_URL = `${import.meta.env.BASE_URL.replace(/\/$/, '')}/pdfjs-wasm/`;

/** Open a PDF with the app's standard pdf.js options. Always use this rather
 *  than calling getDocument directly. */
export function openPdf(src: DocumentInitParameters): ReturnType<typeof pdfjsLib.getDocument> {
  return pdfjsLib.getDocument({ wasmUrl: WASM_URL, ...src });
}

export { pdfjsLib };
export type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
