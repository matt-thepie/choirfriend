import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from '@/lib/pdfjs.ts';
import type {
  Annotation,
  AnnotationLayer,
  AnnotationTool,
  InkAnnotation,
  MarkerAnnotation,
  MarkerKind,
} from '@/types/annotations.ts';
import { MarkerBadge } from './MarkerBadge.tsx';
import { cn } from '@/lib/utils.ts';
import type { Box } from '@/lib/pageLayout.ts';

interface PdfPageProps {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  /** Annotations to render on this page (already filtered by visibility). */
  annotations: Annotation[];
  /** Where new ink strokes / markers go. Null disables placement. */
  drawTarget: AnnotationLayer | null;
  /** Current tool. */
  tool: AnnotationTool;
  /** Ink settings (only meaningful when tool === 'pen'). */
  inkColor: string;
  inkWidth: number;
  /** Marker settings (only meaningful when tool === 'marker'). */
  markerKind: MarkerKind | null;
  markerLabelInput: string;
  onStrokeFinished: (input: { layer: AnnotationLayer; page: number; color: string; width: number; points: Array<{ x: number; y: number }> }) => void;
  onMarkerPlaced: (input: { layer: AnnotationLayer; page: number; markerKind: MarkerKind; label: string | null; position: { x: number; y: number } }) => void;
  onDeleteAnnotation: (id: string) => void;
  /** Resolves a marker's "follow" action (e.g. D.S. → Segno), or null. */
  markerFollow?: (m: MarkerAnnotation) => { label: string; run: () => void } | null;
  /** Show only this part of the page (fractions 0..1); the rest is cropped. */
  clip?: Box | null;
  /** Hide the frame and page number (read mode). */
  bare?: boolean;
}

/**
 * Renders a single PDF page to a canvas with two overlays above it:
 *   1. An annotation canvas for ink strokes (canvas-drawn for performance).
 *   2. A DOM layer for marker badges (DOM so they're clickable / readable).
 *
 * The annotation canvas owns pointer events for the pen and marker tools.
 * Marker badges are interactive only when no drawing tool is active.
 */
export function PdfPage({
  pdf,
  pageNumber,
  scale,
  annotations,
  drawTarget,
  tool,
  inkColor,
  inkWidth,
  markerKind,
  markerLabelInput,
  onStrokeFinished,
  onMarkerPlaced,
  onDeleteAnnotation,
  markerFollow,
  clip = null,
  bare = false,
}: PdfPageProps) {
  const pdfCanvasRef = useRef<HTMLCanvasElement>(null);
  const annotationCanvasRef = useRef<HTMLCanvasElement>(null);
  // width/height: the full page in CSS px; offX/offY/viewW/viewH: the visible (clipped) window.
  const [renderedSize, setRenderedSize] = useState<{ width: number; height: number; dpr: number; offX: number; offY: number; viewW: number; viewH: number } | null>(null);
  const activeStrokeRef = useRef<{ points: Array<{ x: number; y: number }> } | null>(null);

  const inkAnnotations = annotations.filter((a): a is InkAnnotation => a.kind === 'ink');
  const markerAnnotations = annotations.filter((a): a is MarkerAnnotation => a.kind === 'marker');

  // Render the PDF page whenever the source or scale changes.
  useEffect(() => {
    let cancelled = false;
    let renderTask: { cancel: () => void; promise: Promise<void> } | null = null;

    (async () => {
      const page = await pdf.getPage(pageNumber);
      if (cancelled) return;

      const viewport = page.getViewport({ scale });
      const canvas = pdfCanvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      // Render at device resolution so phones/tablets aren't blurry, but lay
      // the canvas out at CSS-pixel size. renderedSize stays in CSS px —
      // badges and pointer maths use it.
      const cssW = Math.floor(viewport.width);
      const cssH = Math.floor(viewport.height);
      // Only the clipped window is rasterised, so zooming into one system
      // stays sharp without a giant canvas.
      const offX = clip ? Math.floor(clip.x0 * viewport.width) : 0;
      const offY = clip ? Math.floor(clip.y0 * viewport.height) : 0;
      const viewW = clip ? Math.ceil((clip.x1 - clip.x0) * viewport.width) : cssW;
      const viewH = clip ? Math.ceil((clip.y1 - clip.y0) * viewport.height) : cssH;
      // Stay under ~16M pixels (iOS Safari's canvas limit).
      const dpr = Math.min(3, window.devicePixelRatio || 1, Math.sqrt(16e6 / Math.max(1, viewW * viewH)));
      canvas.width = Math.floor(viewW * dpr);
      canvas.height = Math.floor(viewH * dpr);
      canvas.style.width = `${viewW}px`;
      canvas.style.height = `${viewH}px`;
      setRenderedSize({ width: cssW, height: cssH, dpr, offX, offY, viewW, viewH });

      renderTask = page.render({ canvas, canvasContext: ctx, viewport, transform: [dpr, 0, 0, dpr, -offX * dpr, -offY * dpr] });
      try {
        await renderTask.promise;
      } catch {
        // Cancelled — fine.
      }
    })();

    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [pdf, pageNumber, scale, clip?.x0, clip?.y0, clip?.x1, clip?.y1]);

  // Redraw the ink layer whenever the annotation list or rendered size changes.
  useEffect(() => {
    const canvas = annotationCanvasRef.current;
    if (!canvas || !renderedSize) return;
    const { dpr } = renderedSize;
    canvas.width = Math.floor(renderedSize.viewW * dpr);
    canvas.height = Math.floor(renderedSize.viewH * dpr);
    canvas.style.width = `${renderedSize.viewW}px`;
    canvas.style.height = `${renderedSize.viewH}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const px = (p: { x: number; y: number }): [number, number] => [
      (p.x * renderedSize.width - renderedSize.offX) * dpr,
      (p.y * renderedSize.height - renderedSize.offY) * dpr,
    ];

    for (const a of inkAnnotations) {
      if (a.points.length === 0) continue;
      ctx.strokeStyle = a.color;
      ctx.lineWidth = a.width * scale * renderedSize.dpr;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      const first = a.points[0]!;
      ctx.moveTo(...px(first));
      for (let i = 1; i < a.points.length; i++) ctx.lineTo(...px(a.points[i]!));
      ctx.stroke();
    }
  }, [inkAnnotations, renderedSize, scale]);

  function getNormalisedPoint(e: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } {
    const canvas = e.currentTarget;
    const rect = canvas.getBoundingClientRect();
    if (!renderedSize) return { x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height };
    return {
      x: (e.clientX - rect.left + renderedSize.offX) / renderedSize.width,
      y: (e.clientY - rect.top + renderedSize.offY) / renderedSize.height,
    };
  }

  function drawLiveStroke(): void {
    const canvas = annotationCanvasRef.current;
    const stroke = activeStrokeRef.current;
    if (!canvas || !stroke || stroke.points.length < 2) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.strokeStyle = inkColor;
    ctx.lineWidth = inkWidth * scale * (renderedSize?.dpr ?? 1);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    const a = stroke.points[stroke.points.length - 2]!;
    const b = stroke.points[stroke.points.length - 1]!;
    const rs = renderedSize;
    const dpr = rs?.dpr ?? 1;
    const tx = (p: { x: number; y: number }): [number, number] =>
      rs ? [(p.x * rs.width - rs.offX) * dpr, (p.y * rs.height - rs.offY) * dpr] : [p.x * canvas.width, p.y * canvas.height];
    ctx.moveTo(...tx(a));
    ctx.lineTo(...tx(b));
    ctx.stroke();
  }

  const inkEnabled = tool === 'pen' && drawTarget !== null;
  const markerEnabled = tool === 'marker' && drawTarget !== null && markerKind !== null;
  const canvasInteractive = inkEnabled || markerEnabled;

  function handlePointerDown(e: React.PointerEvent<HTMLCanvasElement>): void {
    if (inkEnabled) {
      (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
      activeStrokeRef.current = { points: [getNormalisedPoint(e)] };
      return;
    }
    if (markerEnabled && markerKind) {
      const position = getNormalisedPoint(e);
      const label = markerLabelInput.trim().length > 0 ? markerLabelInput.trim() : null;
      onMarkerPlaced({
        layer: drawTarget!,
        page: pageNumber,
        markerKind,
        label,
        position,
      });
    }
  }

  function handlePointerMove(e: React.PointerEvent<HTMLCanvasElement>): void {
    if (!inkEnabled || !activeStrokeRef.current) return;
    activeStrokeRef.current.points.push(getNormalisedPoint(e));
    drawLiveStroke();
  }

  function handlePointerUp(): void {
    if (!inkEnabled || !activeStrokeRef.current) return;
    const stroke = activeStrokeRef.current;
    activeStrokeRef.current = null;
    if (stroke.points.length < 2 || !drawTarget) return;
    onStrokeFinished({
      layer: drawTarget,
      page: pageNumber,
      color: inkColor,
      width: inkWidth,
      points: stroke.points,
    });
  }

  const cursor = inkEnabled ? 'crosshair' : markerEnabled ? 'copy' : 'default';

  return (
    <div
      className={cn('relative inline-block bg-white', !bare && 'shadow-md border border-border', clip && 'overflow-hidden')}
      data-page={pageNumber}
    >
      <canvas ref={pdfCanvasRef} className="block" />
      <canvas
        ref={annotationCanvasRef}
        className="absolute inset-0 block"
        style={{
          touchAction: 'none',
          cursor,
          pointerEvents: canvasInteractive ? 'auto' : 'none',
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      />
      {/* Marker badges layered above. Interactive only when no drawing
          tool is active, so they don't intercept pen/marker placement. */}
      <div
        className="absolute pointer-events-none"
        style={renderedSize ? { left: -renderedSize.offX, top: -renderedSize.offY, width: renderedSize.width, height: renderedSize.height } : { inset: 0 }}
      >
        {renderedSize &&
          markerAnnotations.map((m) => (
            <MarkerBadge
              key={m.id}
              marker={m}
              pageWidth={renderedSize.width}
              pageHeight={renderedSize.height}
              interactive={tool === 'pan'}
              follow={markerFollow?.(m) ?? null}
              onDelete={onDeleteAnnotation}
            />
          ))}
      </div>
      {!bare && <div className="absolute -left-10 top-2 text-xs text-muted-foreground select-none tabular-nums">
        {pageNumber}
      </div>}
    </div>
  );
}
