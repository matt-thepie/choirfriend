/**
 * Laying a flowing score out to fit the screen.
 *
 * Verovio breaks lines greedily, so the last line of a score is often a bar
 * or two with a gap after them. On wider screens the breaks are balanced
 * instead, the way good typesetting balances a paragraph: find the narrowest
 * width that still needs the same number of lines, take its line breaks
 * (which share the bars out evenly), then lay those lines out again at full
 * width with every line, the last included, justified edge to edge.
 *
 * The score is engraved as one tall page; read mode's "pages" are screenfuls
 * of whole lines cut from it (see ScoreViewer).
 */

import type { VerovioToolkit } from 'verovio/esm';

export interface EngraveOptions {
  /** Width to fill, in CSS pixels. */
  width: number;
  /** Verovio scale, percent. Bigger = larger notes, fewer bars per line. */
  scale: number;
  /** Balance the line breaks (worth it on wider screens). */
  balance: boolean;
}

/** Screens at least this wide get balanced line breaks. */
export const BALANCE_MIN_WIDTH = 640;

const BASE_OPTIONS = {
  pageHeight: 60000,
  adjustPageHeight: true,
  header: 'none',
  footer: 'none',
  pageMarginTop: 30,
  pageMarginBottom: 40,
  pageMarginLeft: 30,
  pageMarginRight: 30,
  // Verovio packs lyrics tight on crowded lines ("Sweetsil-ver"): at its
  // default, a third of word gaps on a phone came out under 1.5px. 3 brought
  // that to 2% for a few more lines; going wider gained nothing.
  lyricWordSpace: 3,
  svgRemoveXlink: true,
};

function renderAll(tk: VerovioToolkit): string {
  let svg = '';
  for (let p = 1; p <= tk.getPageCount(); p++) svg += tk.renderToSVG(p);
  return svg;
}

const countSystems = (svg: string) => svg.split('class="system"').length - 1;

/** Id of the first bar of each line after the first. */
function lineStarts(svg: string): string[] {
  return svg
    .split('class="system"')
    .slice(2)
    .map((s) => /<g id="([^"]+)" class="measure/.exec(s)?.[1])
    .filter((id): id is string => !!id);
}

const units = (px: number, scale: number) => Math.round((px * 100) / scale);

/** Engrave `xml` (MusicXML) and return the SVG. */
export function engrave(tk: VerovioToolkit, xml: string, opts: EngraveOptions): string {
  const width = units(Math.max(260, opts.width), opts.scale);
  tk.setOptions({ ...BASE_OPTIONS, scale: opts.scale, pageWidth: width, breaks: 'auto' });
  tk.loadData(xml);
  const greedy = renderAll(tk);
  const lines = countSystems(greedy);
  if (!opts.balance || lines < 2) return greedy;

  // Narrowest width that still fits in the same number of lines.
  let lo = width * 0.5;
  let hi = width;
  for (let i = 0; i < 7 && hi - lo > width * 0.01; i++) {
    const mid = Math.round((lo + hi) / 2);
    tk.setOptions({ pageWidth: mid });
    tk.redoLayout();
    if (countSystems(renderAll(tk)) <= lines) hi = mid;
    else lo = mid;
  }
  tk.setOptions({ pageWidth: Math.round(hi) });
  tk.redoLayout();
  const starts = new Set(lineStarts(renderAll(tk)));
  if (!starts.size) return greedy;

  // Re-lay those lines at full width. The breaks MuseScore saved in the file
  // come out of the MEI first, or Verovio would honour them too.
  let mei = tk.getMEI().replace(/<(sb|pb)\b[^>]*\/>/g, '');
  mei = mei.replace(/<measure\b([^>]*)xml:id="([^"]+)"/g, (whole, attrs: string, id: string) =>
    starts.has(id) ? `<sb/><measure${attrs}xml:id="${id}"` : whole,
  );
  tk.setOptions({ ...BASE_OPTIONS, scale: opts.scale, pageWidth: width, breaks: 'encoded', minLastJustification: 0 });
  tk.loadData(mei);
  const balanced = renderAll(tk);
  // Belt and braces: never return fewer bars than the greedy layout drew.
  const bars = (s: string) => s.split('class="measure').length;
  return bars(balanced) === bars(greedy) ? balanced : greedy;
}
