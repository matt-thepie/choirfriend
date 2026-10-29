// Weak-GPU fallback for the flowing score. Phones and old tablets with a weak
// GPU (the Nexus 7's Adreno 320 for one) garble a large live SVG as it moves:
// staff lines break up and glyphs tear on every page turn and scroll. Drawing
// the engraved SVG once into CPU canvases and showing those instead avoids
// the GPU's vector rasteriser altogether. The live SVG stays in place,
// hidden, for measuring, tapping and the few playback highlights.

/** Devices that report 2 GB or less: in practice the old, weak-GPU ones. */
export const rasterScore = ((navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8) <= 2;

/** Band height in CSS px: big canvases fail on these devices. */
const BAND = 1024;

const FACES: Array<{ family: string; file: string; weight?: number; style?: string }> = [
  { family: 'Tinos', file: 'Tinos-Regular.woff2' },
  { family: 'Tinos', file: 'Tinos-Bold.woff2', weight: 700 },
  { family: 'Tinos', file: 'Tinos-Italic.woff2', style: 'italic' },
  { family: 'Tinos', file: 'Tinos-BoldItalic.woff2', weight: 700, style: 'italic' },
  { family: 'Leland', file: 'Leland.woff2' },
  { family: 'Bravura Text', file: 'BravuraText-subset.woff2' },
];

// An SVG drawn as an image can't fetch anything, so its fonts go in as data URLs.
let fontCss: Promise<string> | null = null;
function embeddedFonts(): Promise<string> {
  fontCss ??= Promise.all(
    FACES.map(async (f) => {
      const blob = await (await fetch(`/fonts/${f.file}`)).blob();
      const url = await new Promise<string>((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result as string);
        r.onerror = () => rej(r.error);
        r.readAsDataURL(blob);
      });
      return `@font-face{font-family:"${f.family}";src:url(${url}) format("woff2");font-weight:${f.weight ?? 400};font-style:${f.style ?? 'normal'}}`;
    }),
  ).then((rules) => rules.join('\n')).catch((e) => { fontCss = null; throw e; });
  return fontCss;
}

/**
 * Draw each SVG under `root` into canvases placed over it in `holder` (which
 * must cover `root` exactly). `css` is the score's own styling, without the
 * `.cf-score` prefix. Returns a cleanup that removes the canvases; resolves to
 * null if `isStale` turns true part-way.
 */
export async function rasteriseScore(
  root: HTMLElement,
  holder: HTMLElement,
  css: string,
  isStale: () => boolean,
): Promise<(() => void) | null> {
  const fonts = await embeddedFonts();
  const dpr = window.devicePixelRatio || 1;
  const base = root.getBoundingClientRect();
  const bands: HTMLCanvasElement[] = [];
  const cleanup = () => {
    // Zero-size frees the backing store now rather than at garbage collection.
    bands.forEach((c) => { c.remove(); c.width = c.height = 0; });
  };
  for (const svg of Array.from(root.querySelectorAll<SVGSVGElement>(':scope > svg'))) {
    const box = svg.getBoundingClientRect();
    const W = box.width;
    const H = box.height;
    if (!W || !H) continue;
    const clone = svg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('width', String(W));
    clone.setAttribute('height', String(H));
    const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    style.textContent = `${fonts}\n${css}`;
    clone.insertBefore(style, clone.firstChild);
    const src = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml' }));
    const img = new Image();
    img.src = src;
    try {
      await img.decode();
    } finally {
      URL.revokeObjectURL(src);
    }
    for (let y = 0; y < H; y += BAND) {
      if (isStale()) {
        cleanup();
        return null;
      }
      const h = Math.min(BAND, H - y);
      const c = document.createElement('canvas');
      c.width = Math.round(W * dpr);
      c.height = Math.round(h * dpr);
      // willReadFrequently keeps the canvas on the CPU, away from the GPU.
      const ctx = c.getContext('2d', { willReadFrequently: true })!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, -y * dpr);
      ctx.drawImage(img, 0, 0, W, H);
      // Shown as is: encoding to PNG for an <img> took ~4 s a band on the Nexus 7.
      c.style.cssText = `position:absolute;left:${box.left - base.left}px;top:${box.top - base.top + y}px;width:${W}px;height:${h}px`;
      bands.push(c);
      // Let taps and page turns through between bands.
      await new Promise((res) => setTimeout(res));
    }
  }
  if (isStale()) {
    cleanup();
    return null;
  }
  holder.append(...bands);
  return cleanup;
}
