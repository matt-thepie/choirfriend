/// <reference lib="webworker" />
import { analyseBitmap } from './pageBitmap.ts';

// Page analysis takes up to ~0.7s a page on old tablets, and encoding the
// page's PNG several seconds more; off the main thread neither swallows taps
// while a score is being prepared.
self.onmessage = async (e: MessageEvent<{ id: number; data: Uint8ClampedArray; width: number; height: number }>) => {
  const { id, data, width, height } = e.data;
  const layout = analyseBitmap(data, width, height);
  let image: Blob | null = null;
  let error: string | null = null;
  if (typeof OffscreenCanvas !== 'undefined') {
    try {
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.putImageData(new ImageData(data as Uint8ClampedArray<ArrayBuffer>, width, height), 0, 0);
        image = await canvas.convertToBlob({ type: 'image/png' });
      }
    } catch (e) {
      // No 2d context or encoder here: the main thread encodes instead.
      error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    }
  } else error = 'no OffscreenCanvas';
  self.postMessage({ id, layout, image, error });
};
