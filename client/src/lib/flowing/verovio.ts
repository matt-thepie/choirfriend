/**
 * Verovio, the engraver behind flowing scores. It is ~7 MB of WebAssembly, so
 * it loads on first use only (and the service worker keeps it in its own
 * cache rather than the app shell, which every member downloads).
 */

import type { VerovioToolkit } from 'verovio/esm';

let modulePromise: Promise<{ module: unknown; Toolkit: typeof VerovioToolkit }> | null = null;

function loadModule() {
  if (!modulePromise) {
    modulePromise = Promise.all([import('verovio/wasm'), import('verovio/esm')]).then(async ([wasm, esm]) => ({
      module: await wasm.default(),
      Toolkit: esm.VerovioToolkit,
    }));
    modulePromise.catch(() => {
      modulePromise = null; // let a later attempt retry
    });
  }
  return modulePromise;
}

/** A fresh toolkit. Each score view keeps one for drawing and, for playback,
 *  one holding every part, since hidden parts still sound. */
export async function createToolkit(): Promise<VerovioToolkit> {
  const { module, Toolkit } = await loadModule();
  const tk = new Toolkit(module);
  tk.setOptions({ xmlIdSeed: 1 });
  return tk;
}
