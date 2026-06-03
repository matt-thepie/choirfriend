/**
 * Shared marker glyphs. Musical Unicode (𝄋 𝄌 𝄆 𝄇) isn't in normal fonts, so we
 * draw the iconic ones (Segno, Coda, To Coda, voltas) as SVG and fall back to
 * short text for the rest. Used by both the on-score badges and the marker
 * toolbar so they look the same.
 */

import { MARKER_DEFAULT_LABEL, type MarkerKind } from '@/types/annotations.ts';

/** Coda 𝄌 — a circle with a vertical + horizontal line through it. */
export function CodaIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <circle cx="12" cy="12" r="5.5" />
      <line x1="12" y1="3.5" x2="12" y2="20.5" strokeLinecap="round" />
      <line x1="3.5" y1="12" x2="20.5" y2="12" strokeLinecap="round" />
    </svg>
  );
}

/** Segno 𝄋 — a slanted S with a diagonal slash and two flanking dots. */
export function SegnoIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
      <path
        d="M16 8.2c-1.1-1.9-4.1-2-5.6-.4-1.3 1.4-.6 3.2 1.6 4.2 2.2 1 2.9 2.8 1.6 4.2-1.5 1.6-4.5 1.5-5.6-.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <line x1="8.2" y1="16.6" x2="15.8" y2="7.4" strokeLinecap="round" />
      <circle cx="8.6" cy="9.4" r="1" fill="currentColor" stroke="none" />
      <circle cx="15.4" cy="14.6" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** Volta / time-bar: an open bracket with the pass number (1st / 2nd time). */
export function VoltaIcon({ n, className }: { n: number; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path d="M5 8v5M5 8h13" strokeLinecap="round" strokeLinejoin="round" />
      <text x="8.5" y="20.5" fill="currentColor" stroke="none" fontSize="12" fontWeight="700" fontFamily="ui-sans-serif, system-ui">
        {n}
      </text>
    </svg>
  );
}

/** Short text labels for the kinds that aren't drawn as icons. */
const SHORT_TEXT: Partial<Record<MarkerKind, string>> = { bar: 'Bar', custom: 'Text' };

/** Renders a marker kind's glyph. `label` (a resolved badge label) overrides the
 *  text for the non-icon kinds — pass it for badges, omit it for the toolbar. */
export function MarkerGlyph({ kind, label, className }: { kind: MarkerKind; label?: string; className?: string }) {
  if (kind === 'segno') return <SegnoIcon className={className} />;
  if (kind === 'coda') return <CodaIcon className={className} />;
  if (kind === 'to-coda') {
    return (
      <span className="inline-flex items-center gap-1">
        To <CodaIcon className={className} />
      </span>
    );
  }
  if (kind === 'volta-1') return <VoltaIcon n={1} className={className} />;
  if (kind === 'volta-2') return <VoltaIcon n={2} className={className} />;
  return <span>{label ?? SHORT_TEXT[kind] ?? MARKER_DEFAULT_LABEL[kind]}</span>;
}
