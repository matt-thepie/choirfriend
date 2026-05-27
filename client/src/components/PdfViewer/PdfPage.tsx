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
}: PdfPageProps) {
  const pdfCanvasRef = useRef<HTMLCanvasElement>(null);
  const annotationCanvasRef = useRef<HTMLCanvasElement>(null);
  const [renderedSize, setRenderedSize] = useState<{ width: number; height: number } | null>(null);
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

      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      setRenderedSize({ width: canvas.width, height: canvas.height });

      renderTask = page.render({ canvas, canvasContext: ctx, viewport });
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
  }, [pdf, pageNumber, scale]);

  // Redraw the ink layer whenever the annotation list or rendered size changes.
  useEffect(() => {
    const canvas = annotationCanvasRef.current;
    if (!canvas || !renderedSize) return;
    canvas.width = renderedSize.width;
    canvas.height = renderedSize.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (const a of inkAnnotations) {
      if (a.points.length === 0) continue;
      ctx.strokeStyle = a.color;
      ctx.lineWidth = a.width * scale;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      const first = a.points[0]!;
      ctx.moveTo(first.x * canvas.width, first.y * canvas.height);
      for (let i = 1; i < a.points.length; i++) {
        const p = a.points[i]!;
        ctx.lineTo(p.x * canvas.width, p.y * canvas.height);
      }
      ctx.stroke();
    }
  }, [inkAnnotations, renderedSize, scale]);

  function getNormalisedPoint(e: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } {
    const canvas = e.currentTarget;
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) / rect.width,
      y: (e.clientY - rect.top) / rect.height,
    };
  }

  function drawLiveStroke(): void {
    const canvas = annotationCanvasRef.current;
    const stroke = activeStrokeRef.current;
    if (!canvas || !stroke || stroke.points.length < 2) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.strokeStyle = inkColor;
    ctx.lineWidth = inkWidth * scale;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    const a = stroke.points[stroke.points.length - 2]!;
    const b = stroke.points[stroke.points.length - 1]!;
    ctx.moveTo(a.x * canvas.width, a.y * canvas.height);
    ctx.lineTo(b.x * canvas.width, b.y * canvas.height);
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
    <div className="relative inline-block shadow-md border border-border bg-white" data-page={pageNumber}>
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
      <div className="absolute inset-0 pointer-events-none">
        {renderedSize &&
          markerAnnotations.map((m) => (
            <MarkerBadge
              key={m.id}
              marker={m}
              pageWidth={renderedSize.width}
              pageHeight={renderedSize.height}
              interactive={tool === 'pan'}
              onDelete={onDeleteAnnotation}
            />
          ))}
      </div>
      <div className="absolute -left-10 top-2 text-xs text-muted-foreground select-none tabular-nums">
        {pageNumber}
      </div>
    </div>
  );
}
