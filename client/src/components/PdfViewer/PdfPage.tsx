import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from '@/lib/pdfjs.ts';
import type { Annotation, AnnotationLayer, AnnotationTool } from '@/types/annotations.ts';

interface PdfPageProps {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  /** Annotations to render on this page (already filtered by visibility). */
  annotations: Annotation[];
  /** Where new strokes go. Null means drawing is disabled (different tool). */
  drawTarget: AnnotationLayer | null;
  /** Current tool — controls which pointer events the overlay accepts. */
  tool: AnnotationTool;
  /** Stroke colour/width for new ink. */
  inkColor: string;
  inkWidth: number;
  /** Called whenever the user finishes a stroke. */
  onAnnotationAdded: (annotation: Annotation) => void;
}

/**
 * Renders a single PDF page to a canvas with a transparent annotation
 * canvas layered on top. The annotation canvas handles pointer events when
 * the pen tool is selected.
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
  onAnnotationAdded,
}: PdfPageProps) {
  const pdfCanvasRef = useRef<HTMLCanvasElement>(null);
  const annotationCanvasRef = useRef<HTMLCanvasElement>(null);
  const [renderedSize, setRenderedSize] = useState<{ width: number; height: number } | null>(null);
  const activeStrokeRef = useRef<{ points: Array<{ x: number; y: number }> } | null>(null);

  // Render the PDF page whenever the source or scale changes. We cancel
  // any in-flight render task on unmount/rerender to avoid the "render
  // task was destroyed" pdfjs error.
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

  // Redraw the annotation layer whenever the annotation list or size changes.
  useEffect(() => {
    const canvas = annotationCanvasRef.current;
    if (!canvas || !renderedSize) return;
    canvas.width = renderedSize.width;
    canvas.height = renderedSize.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (const a of annotations) {
      if (a.kind !== 'ink' || a.points.length === 0) continue;
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
  }, [annotations, renderedSize, scale]);

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

  const drawingEnabled = tool === 'pen' && drawTarget !== null;

  function handlePointerDown(e: React.PointerEvent<HTMLCanvasElement>): void {
    if (!drawingEnabled) return;
    (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
    activeStrokeRef.current = { points: [getNormalisedPoint(e)] };
  }

  function handlePointerMove(e: React.PointerEvent<HTMLCanvasElement>): void {
    if (!drawingEnabled || !activeStrokeRef.current) return;
    activeStrokeRef.current.points.push(getNormalisedPoint(e));
    drawLiveStroke();
  }

  function handlePointerUp(e: React.PointerEvent<HTMLCanvasElement>): void {
    if (!drawingEnabled || !activeStrokeRef.current) return;
    const stroke = activeStrokeRef.current;
    activeStrokeRef.current = null;
    if (stroke.points.length < 2 || !drawTarget) return;
    onAnnotationAdded({
      id: crypto.randomUUID(),
      layer: drawTarget,
      page: pageNumber,
      kind: 'ink',
      color: inkColor,
      width: inkWidth,
      points: stroke.points,
    });
    void e; // setPointerCapture is released automatically on pointerup
  }

  return (
    <div className="relative inline-block shadow-md border border-border bg-white" data-page={pageNumber}>
      <canvas ref={pdfCanvasRef} className="block" />
      <canvas
        ref={annotationCanvasRef}
        className="absolute inset-0 block"
        style={{
          touchAction: 'none',
          cursor: drawingEnabled ? 'crosshair' : 'default',
          pointerEvents: drawingEnabled ? 'auto' : 'none',
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      />
      <div className="absolute -left-10 top-2 text-xs text-muted-foreground select-none tabular-nums">
        {pageNumber}
      </div>
    </div>
  );
}
