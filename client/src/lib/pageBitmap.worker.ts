/// <reference lib="webworker" />
import { analyseBitmap } from './pageBitmap.ts';

// Page analysis takes up to ~0.7s a page on old tablets; off the main thread
// it no longer swallows taps while a score is being prepared.
self.onmessage = (e: MessageEvent<{ id: number; data: Uint8ClampedArray; width: number; height: number }>) => {
  const { id, data, width, height } = e.data;
  self.postMessage({ id, layout: analyseBitmap(data, width, height) });
};
