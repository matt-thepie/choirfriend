/**
 * Annotation shape. Coordinates are normalised (0..1) relative to the page's
 * unscaled width/height so the data survives zoom changes.
 *
 * Two kinds today, both layered (private / shared):
 *   - `ink`    — pen strokes
 *   - `marker` — navigation marks (Segno, Coda, D.S., D.C., To Coda, Fine,
 *                voltas, repeat brackets, bar numbers, custom)
 *
 * Both live in the same annotations table on the server (free-form kind +
 * JSON payload), so adding new kinds later is purely a typing exercise.
 */

export type AnnotationLayer = 'private' | 'shared';

export type AnnotationTool = 'pen' | 'pan' | 'marker';

// ---------------------------------------------------------------------------
// Markers
// ---------------------------------------------------------------------------

export type MarkerKind =
  | 'segno'
  | 'coda'
  | 'ds' // D.S. — qualifier in `label` ("al Coda", "al Fine")
  | 'dc' // D.C. — qualifier in `label`
  | 'fine'
  | 'to-coda'
  | 'repeat-start'
  | 'repeat-end'
  | 'volta-1'
  | 'volta-2'
  | 'bar' // bar number or rehearsal letter — label required
  | 'custom'; // arbitrary text — label required

/** Default badge text for each marker kind. `bar` and `custom` always use
 *  the user-supplied label; the others fall back here when no label is set. */
export const MARKER_DEFAULT_LABEL: Record<MarkerKind, string> = {
  segno: '𝄋',
  coda: '𝄌',
  ds: 'D.S.',
  dc: 'D.C.',
  fine: 'Fine',
  'to-coda': '→ 𝄌',
  'repeat-start': '𝄆',
  'repeat-end': '𝄇',
  'volta-1': '1.',
  'volta-2': '2.',
  bar: '?',
  custom: '?',
};

/** Human label for the toolbar marker-kind picker. */
export const MARKER_PICKER_LABEL: Record<MarkerKind, string> = {
  segno: 'Segno (𝄋)',
  coda: 'Coda (𝄌)',
  ds: 'D.S.',
  dc: 'D.C.',
  fine: 'Fine',
  'to-coda': 'To Coda (→ 𝄌)',
  'repeat-start': 'Repeat start (𝄆)',
  'repeat-end': 'Repeat end (𝄇)',
  'volta-1': 'Volta 1',
  'volta-2': 'Volta 2',
  bar: 'Bar / letter',
  custom: 'Custom label',
};

export const MARKER_KIND_ORDER: readonly MarkerKind[] = [
  'segno',
  'coda',
  'to-coda',
  'ds',
  'dc',
  'fine',
  'repeat-start',
  'repeat-end',
  'volta-1',
  'volta-2',
  'bar',
  'custom',
];

// ---------------------------------------------------------------------------
// Annotations
// ---------------------------------------------------------------------------

interface AnnotationCommon {
  id: string;
  layer: AnnotationLayer;
  /** 1-indexed page number. */
  page: number;
  /** Server-assigned context. Present on annotations loaded from the API. */
  pieceId?: number;
  fileId?: number;
  authorEmail?: string;
  isMine?: boolean;
  createdAt?: number;
  updatedAt?: number;
}

export interface InkAnnotation extends AnnotationCommon {
  kind: 'ink';
  color: string;
  width: number;
  points: Array<{ x: number; y: number }>;
}

export interface MarkerAnnotation extends AnnotationCommon {
  kind: 'marker';
  markerKind: MarkerKind;
  label: string | null;
  position: { x: number; y: number };
}

export type Annotation = InkAnnotation | MarkerAnnotation;

/** Resolved badge label for a marker. */
export function markerLabel(m: MarkerAnnotation): string {
  if (m.label && m.label.trim().length > 0) return m.label;
  return MARKER_DEFAULT_LABEL[m.markerKind];
}
