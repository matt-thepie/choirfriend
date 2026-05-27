/**
 * Annotation shape. Coordinates are normalised (0..1) relative to the page's
 * unscaled width/height so the data survives zoom changes.
 *
 * `Annotation` is the canonical shape used throughout the client. The
 * server-set metadata fields (`authorEmail`, `isMine`, timestamps) are
 * optional because optimistic inserts don't have them yet — the server's
 * response fills them in.
 */

export type AnnotationLayer = 'private' | 'shared';

export interface InkAnnotation {
  id: string;
  layer: AnnotationLayer;
  /** 1-indexed page number. */
  page: number;
  kind: 'ink';
  color: string;
  width: number;
  points: Array<{ x: number; y: number }>;

  /** Server-assigned context. Present on annotations loaded from the API. */
  pieceId?: number;
  fileId?: number;
  authorEmail?: string;
  isMine?: boolean;
  createdAt?: number;
  updatedAt?: number;
}

export type Annotation = InkAnnotation;

export type AnnotationTool = 'pen' | 'pan';
