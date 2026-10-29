import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from '@/lib/pdfjs.ts';
import type {
  Annotation,
  AnnotationLayer,
  AnnotationTool,
  InkAnnotation,
  InkPen,
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
  /** Ink settings (only meaningful for the pen and highlighter tools). */
  inkColor: string;
  inkWidth: number;
  /** Marker settings (only meaningful when tool === 'marker'). */
  markerKind: MarkerKind | null;
  markerLabelInput: string;
  onStrokeFinished: (input: { layer: AnnotationLayer; page: number; pen: InkPen; color: string; width: number; points: Array<{ x: number; y: number }> }) => void;
  onMarkerPlaced: (input: { layer: AnnotationLayer; page: number; markerKind: MarkerKind; label: string | null; position: { x: number; y: number } }) => void;
  onDeleteAnnotation: (id: string) => void;
  onSelectMarker?: (marker: MarkerAnnotation) => void;
  selectedMarkerId?: string | null;
  onMoveMarker?: (page: number, position: { x: number; y: number }) => void;
  /** Resolves a marker's "follow" action (e.g. D.S. → Segno), or null. */
  markerFollow?: (m: MarkerAnnotation) => { label: string; run: () => void } | null;
  /** Show only this part of the page (fractions 0..1); the rest is cropped. */
  clip?: Box | null;
  /** Hide the frame and page number (read mode). */
  bare?: boolean;
  /** "My line": soft bands behind the member's own stave (page fractions). */
  partBands?: Box[];
  /** Adjusting "My line": every stave on the page, tappable. */
  staveTargets?: StaveTarget[];
  onPickStave?: (system: number, stave: number) => void;
  /** Scroll mode: the scrolling container. Only pages within about a screen
   *  of it are rasterised; the rest keep their size but free their canvases. */
  scrollRoot?: React.RefObject<HTMLElement | null>;
}

/** Most canvas pixels one page may use. Low-memory devices (old tablets)
 *  garble or drop canvases long before iOS Safari's ~16M-pixel limit. */
const lowMemory = ((navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8) <= 2;
const MAX_CANVAS_PIXELS = lowMemory ? 4e6 : 16e6;

export interface StaveTarget {
  system: number;
  stave: number;
  box: Box;
  picked: boolean;
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
  onSelectMarker,
  selectedMarkerId,
  onMoveMarker,
  markerFollow,
  clip = null,
  bare = false,
  partBands = [],
  staveTargets,
  onPickStave,
  scrollRoot,
}: PdfPageProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const pdfCanvasRef = useRef<HTMLCanvasElement>(null);
  const annotationCanvasRef = useRef<HTMLCanvasElement>(null);
  // width/height: the full page in CSS px; offX/offY/viewW/viewH: the visible (clipped) window.
  const [renderedSize, setRenderedSize] = useState<{ width: number; height: number; dpr: number; offX: number; offY: number; viewW: number; viewH: number } | null>(null);
  const activeStrokeRef = useRef<{ pointerId: number; points: Array<{ x: number; y: number }> } | null>(null);
  // A marker goes down when the finger lifts, so a two-finger tap (undo) never places one.
  const pendingMarkerRef = useRef<{ pointerId: number; position: { x: number; y: number } } | null>(null);
  const pendingEditRef = useRef<{ pointerId: number; x: number; y: number; eraseId?: string; move?: { x: number; y: number } } | null>(null);
  // Bumped to wipe a stroke that a second finger cancelled.
  const [redrawTick, setRedrawTick] = useState(0);

  const inkAnnotations = annotations.filter((a): a is InkAnnotation => a.kind === 'ink');
  const inkPen: InkPen | null = tool === 'pen' || tool === 'highlighter' ? tool : null;
  const markerAnnotations = annotations.filter((a): a is MarkerAnnotation => a.kind === 'marker');
  const inkEnabled = inkPen !== null && drawTarget !== null;

  // Without a scroll root (page mode) the one page shown is always near.
  const [near, setNear] = useState(!scrollRoot);
  const sized = renderedSize !== null;
  useEffect(() => {
    const el = wrapRef.current;
    // Wait until the page has its real size, or every empty page looks near.
    if (!scrollRoot || !el || !sized) return;
    const io = new IntersectionObserver(([entry]) => setNear(entry!.isIntersecting), {
      root: scrollRoot.current,
      rootMargin: '100% 0px',
    });
    io.observe(el);
    return () => io.disconnect();
  }, [scrollRoot, sized]);

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
      // willReadFrequently keeps the canvas in CPU memory. GPU-accelerated
      // canvases garble pdf.js output on weak GPUs (Nexus 7's Adreno 320:
      // dashed staff lines, broken glyphs), and pdf.js gains little from it.
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
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
      const dpr = Math.min(3, window.devicePixelRatio || 1, Math.sqrt(MAX_CANVAS_PIXELS / Math.max(1, viewW * viewH)));
      canvas.style.width = `${viewW}px`;
      canvas.style.height = `${viewH}px`;
      setRenderedSize({ width: cssW, height: cssH, dpr, offX, offY, viewW, viewH });
      if (!near) {
        // Keep the page's place in the scroll, but give back its memory.
        canvas.width = 0;
        canvas.height = 0;
        return;
      }
      canvas.width = Math.floor(viewW * dpr);
      canvas.height = Math.floor(viewH * dpr);

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
  }, [pdf, pageNumber, scale, clip?.x0, clip?.y0, clip?.x1, clip?.y1, near]);

  // The ink layer only needs pixels when there is ink to show or draw; the
  // other tools just need its pointer events, which a 0×0 canvas still gets.
  const inkLayer = near && (inkAnnotations.length > 0 || inkEnabled);

  // Redraw the ink layer whenever the annotation list or rendered size changes.
  useEffect(() => {
    const canvas = annotationCanvasRef.current;
    if (!canvas || !renderedSize) return;
    const { dpr } = renderedSize;
    canvas.style.width = `${renderedSize.viewW}px`;
    canvas.style.height = `${renderedSize.viewH}px`;
    if (!inkLayer) {
      canvas.width = 0;
      canvas.height = 0;
      return;
    }
    canvas.width = Math.floor(renderedSize.viewW * dpr);
    canvas.height = Math.floor(renderedSize.viewH * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const px = (p: { x: number; y: number }): [number, number] => [
      (p.x * renderedSize.width - renderedSize.offX) * dpr,
      (p.y * renderedSize.height - renderedSize.offY) * dpr,
    ];

    // Highlighters first so pen lines sit on top of them.
    const ordered = [
      ...inkAnnotations.filter((a) => a.pen === 'highlighter'),
      ...inkAnnotations.filter((a) => a.pen !== 'highlighter'),
    ];
    for (const a of ordered) {
      if (a.points.length === 0) continue;
      ctx.globalCompositeOperation = a.pen === 'highlighter' ? 'darken' : 'source-over';
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
  }, [inkAnnotations, renderedSize, scale, redrawTick, inkLayer]);

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
    // 'darken' stops a highlighter's overlapping segments building up.
    ctx.globalCompositeOperation = inkPen === 'highlighter' ? 'darken' : 'source-over';
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

  const markerEnabled = tool === 'marker' && drawTarget !== null && markerKind !== null;
  const canvasInteractive = inkEnabled || markerEnabled || tool === 'erase' || tool === 'select';

  function handlePointerDown(e: React.PointerEvent<HTMLCanvasElement>): void {
    if (!e.isPrimary) {
      // A second finger: a two-finger tap or pinch, not a mark.
      if (activeStrokeRef.current) {
        activeStrokeRef.current = null;
        setRedrawTick((n) => n + 1);
      }
      pendingMarkerRef.current = null;
      pendingEditRef.current = null;
      return;
    }
    if (tool === 'erase' && renderedSize) {
      const point = getNormalisedPoint(e);
      const hit = hitInk(inkAnnotations.filter((a) => a.isMine !== false && a.layer === drawTarget), point, renderedSize.width, renderedSize.height, scale);
      if (hit) pendingEditRef.current = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, eraseId: hit.id };
      return;
    }
    if (tool === 'select' && selectedMarkerId) {
      pendingEditRef.current = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, move: getNormalisedPoint(e) };
      return;
    }
    if (inkEnabled) {
      (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
      activeStrokeRef.current = { pointerId: e.pointerId, points: [getNormalisedPoint(e)] };
      return;
    }
    if (markerEnabled) pendingMarkerRef.current = { pointerId: e.pointerId, position: getNormalisedPoint(e) };
  }

  function handlePointerMove(e: React.PointerEvent<HTMLCanvasElement>): void {
    const edit = pendingEditRef.current;
    if (edit && Math.hypot(e.clientX - edit.x, e.clientY - edit.y) > 10) pendingEditRef.current = null;
    if (!inkEnabled || !activeStrokeRef.current || activeStrokeRef.current.pointerId !== e.pointerId) return;
    activeStrokeRef.current.points.push(getNormalisedPoint(e));
    drawLiveStroke();
  }

  function handlePointerUp(e: React.PointerEvent<HTMLCanvasElement>): void {
    const edit = pendingEditRef.current;
    if (edit?.pointerId === e.pointerId) {
      pendingEditRef.current = null;
      if (e.type === 'pointerup') {
        if (edit.eraseId) onDeleteAnnotation(edit.eraseId);
        if (edit.move) onMoveMarker?.(pageNumber, edit.move);
      }
      return;
    }
    const pending = pendingMarkerRef.current;
    if (pending && pending.pointerId === e.pointerId) {
      pendingMarkerRef.current = null;
      if (e.type === 'pointerup' && markerEnabled && markerKind) {
        const label = markerLabelInput.trim().length > 0 ? markerLabelInput.trim() : null;
        onMarkerPlaced({ layer: drawTarget!, page: pageNumber, markerKind, label, position: pending.position });
      }
      return;
    }
    if (!inkEnabled || !activeStrokeRef.current || activeStrokeRef.current.pointerId !== e.pointerId) return;
    const stroke = activeStrokeRef.current;
    activeStrokeRef.current = null;
    if (stroke.points.length < 2 || !drawTarget) return;
    onStrokeFinished({
      layer: drawTarget,
      page: pageNumber,
      pen: inkPen!,
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
      ref={wrapRef}
    >
      <canvas ref={pdfCanvasRef} className="block" />
      {renderedSize && partBands.length > 0 && (
        <div
          className="absolute pointer-events-none"
          style={{ left: -renderedSize.offX, top: -renderedSize.offY, width: renderedSize.width, height: renderedSize.height, mixBlendMode: 'multiply' }}
        >
          {partBands.map((b, i) => (
            <div key={i} className="absolute rounded-sm bg-sky-200/70" style={pageRect(b, renderedSize)} />
          ))}
        </div>
      )}
      <canvas
        ref={annotationCanvasRef}
        className="absolute inset-0 block"
        style={{
          touchAction: 'none',
          // Multiply onto the score so highlighter colour never hides the notes.
          // Only while it has pixels: blending is costly on old GPUs.
          mixBlendMode: inkLayer ? 'multiply' : undefined,
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
              interactive={tool === 'pan' || (tool === 'select' && (m.isMine !== false || m.layer === 'shared')) || (tool === 'erase' && m.isMine !== false && m.layer === drawTarget)}
              editing={tool === 'select'}
              selected={selectedMarkerId === m.id}
              erasing={tool === 'erase' && m.layer === drawTarget}
              onSelect={onSelectMarker}
              follow={markerFollow?.(m) ?? null}
              onDelete={onDeleteAnnotation}
            />
          ))}
      </div>
      {renderedSize && staveTargets && (
        <div
          className="absolute"
          style={{ left: -renderedSize.offX, top: -renderedSize.offY, width: renderedSize.width, height: renderedSize.height }}
        >
          {staveTargets.map((t) => (
            <button
              key={`${t.system}:${t.stave}`}
              type="button"
              aria-label={t.picked ? 'Not my line here' : 'My line'}
              aria-pressed={t.picked}
              onClick={() => onPickStave?.(t.system, t.stave)}
              className={cn(
                'absolute rounded-sm border-2 border-dashed',
                t.picked ? 'border-sky-600 bg-sky-400/20' : 'border-sky-400/60 hover:bg-sky-400/10',
              )}
              style={pageRect(t.box, renderedSize)}
            />
          ))}
        </div>
      )}
      {!bare && <div className="absolute -left-10 top-2 text-xs text-muted-foreground select-none tabular-nums">
        {pageNumber}
      </div>}
    </div>
  );
}

function pageRect(b: Box, size: { width: number; height: number }): React.CSSProperties {
  return { left: b.x0 * size.width, top: b.y0 * size.height, width: (b.x1 - b.x0) * size.width, height: (b.y1 - b.y0) * size.height };
}

/** Distance to whole stroke segments, in CSS pixels, including single-point marks. */
export function hitInk(ink: InkAnnotation[], p: { x: number; y: number }, width: number, height: number, scale: number): InkAnnotation | null {
  for (let i = ink.length - 1; i >= 0; i--) {
    const a = ink[i]!;
    const radius = Math.max(10, a.width * scale / 2 + 5);
    for (let j = 0; j < a.points.length; j++) {
      const start = a.points[j]!;
      const end = a.points[j + 1] ?? start;
      const dx = (end.x - start.x) * width, dy = (end.y - start.y) * height;
      const x = (p.x - start.x) * width, y = (p.y - start.y) * height;
      const t = Math.max(0, Math.min(1, (x * dx + y * dy) / (dx * dx + dy * dy || 1)));
      if (Math.hypot(x - t * dx, y - t * dy) <= radius) return a;
    }
  }
  return null;
}
