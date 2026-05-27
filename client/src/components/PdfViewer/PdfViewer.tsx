import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { pdfjsLib, type PDFDocumentProxy } from '@/lib/pdfjs.ts';
import { Button } from '@/components/ui/button.tsx';
import { cn } from '@/lib/utils.ts';
import {
  MARKER_KIND_ORDER,
  MARKER_PICKER_LABEL,
  markerLabel,
  type Annotation,
  type AnnotationLayer,
  type AnnotationTool,
  type MarkerAnnotation,
  type MarkerKind,
} from '@/types/annotations.ts';
import { usePiece } from '@/hooks/usePiece.ts';
import { useAnnotations, type NewAnnotationInput } from '@/hooks/useAnnotations.ts';
import { PdfPage } from './PdfPage.tsx';
import { UploadButton } from './UploadButton.tsx';

interface PdfViewerProps {
  pieceId: number;
  /** Bump from the parent to force a refetch of the piece — keeps the
   *  viewer in sync with sibling components after a mutation. */
  refreshTick?: number;
  /** Called after this viewer adds/removes a file. */
  onPieceMutated?: () => void;
  /** Read/perform mode: minimal chrome, page-turn nav by default. The
   *  parent (App) hides its own header when this is true. */
  readMode?: boolean;
  /** Called when the user exits read mode from within the viewer (e.g.
   *  Esc, or the Exit button on the minimal toolbar). */
  onExitReadMode?: () => void;
  /** Whether the current user holds an admin role. Gates the upload and
   *  delete UI so we don't show buttons that 403 on click. */
  isAdmin?: boolean;
}

/** Marker kinds that benefit from a free-text label. */
const KIND_TAKES_LABEL: Record<MarkerKind, boolean> = {
  segno: false,
  coda: false,
  ds: true,
  dc: true,
  fine: false,
  'to-coda': false,
  'repeat-start': false,
  'repeat-end': false,
  'volta-1': false,
  'volta-2': false,
  bar: true,
  custom: true,
};

type NavMode = 'scroll' | 'page';

/** Phones are typically narrow; users will be zoomed in so scroll is the
 *  sensible default. Tablets and desktops default to one-page-at-a-time. */
function pickInitialNavMode(): NavMode {
  if (typeof window === 'undefined') return 'page';
  return window.innerWidth < 768 ? 'scroll' : 'page';
}

export function PdfViewer({
  pieceId,
  refreshTick = 0,
  onPieceMutated,
  readMode = false,
  onExitReadMode,
  isAdmin = false,
}: PdfViewerProps) {
  const { piece, loading: pieceLoading, error: pieceError, refresh: refreshPiece } = usePiece(pieceId, refreshTick);
  const pdfFile = useMemo(() => piece?.files.find((f) => f.kind === 'pdf') ?? null, [piece]);

  function handleUploaded(): void {
    refreshPiece();
    onPieceMutated?.();
  }

  const { annotations, loading: annotationsLoading, error: annotationsError, add, remove } = useAnnotations(pieceId);

  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [pdfLoadError, setPdfLoadError] = useState<string | null>(null);
  const [scale, setScale] = useState(1.25);
  const [drawTarget, setDrawTarget] = useState<AnnotationLayer>('shared');
  const [tool, setTool] = useState<AnnotationTool>('pan');
  const [showPrivate, setShowPrivate] = useState(true);
  const [showShared, setShowShared] = useState(true);
  const [markerKind, setMarkerKind] = useState<MarkerKind>('segno');
  const [markerLabelInput, setMarkerLabelInput] = useState('');
  const [jumpOpen, setJumpOpen] = useState(false);
  const [navMode, setNavMode] = useState<NavMode>(pickInitialNavMode);
  const [currentPage, setCurrentPage] = useState(1);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  // Track container dimensions so we can fit-scale in page mode.
  const [containerSize, setContainerSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  useEffect(() => {
    const el = stageRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) setContainerSize({ w: rect.width, h: rect.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Page 1 intrinsic viewport — needed to compute fit-scale.
  const [intrinsicPageSize, setIntrinsicPageSize] = useState<{ w: number; h: number } | null>(null);

  const inkPresets: Record<AnnotationLayer, { color: string; width: number }> = {
    private: { color: '#1d4ed8', width: 2 },
    shared: { color: '#ea580c', width: 2 },
  };
  const activeInk = inkPresets[drawTarget];

  useEffect(() => {
    if (!pdfFile) {
      setPdf(null);
      return;
    }
    let cancelled = false;
    setPdf(null);
    setIntrinsicPageSize(null);
    setPdfLoadError(null);
    const task = pdfjsLib.getDocument(pdfFile.url);
    task.promise.then(
      async (loaded) => {
        if (cancelled) return;
        setPdf(loaded);
        try {
          const p = await loaded.getPage(1);
          if (cancelled) return;
          const vp = p.getViewport({ scale: 1 });
          setIntrinsicPageSize({ w: vp.width, h: vp.height });
        } catch {
          // non-fatal — fit-scale will fall back to 1.0
        }
      },
      (err: Error) => {
        if (!cancelled) setPdfLoadError(err.message);
      },
    );
    return () => {
      cancelled = true;
      task.destroy();
    };
  }, [pdfFile]);

  // Page-turn always re-renders one page; in edit mode we always scroll.
  const effectiveNavMode: NavMode = readMode ? navMode : 'scroll';

  // Fit-to-container scale used in page mode. ~32px margin gives the page
  // visible breathing room and prevents the tap zones from sitting on top
  // of content.
  const fitScale = useMemo(() => {
    if (!intrinsicPageSize || containerSize.w === 0 || containerSize.h === 0) return scale;
    const margin = 32;
    const w = (containerSize.w - margin * 2) / intrinsicPageSize.w;
    const h = (containerSize.h - margin * 2) / intrinsicPageSize.h;
    return Math.max(0.3, Math.min(4, Math.min(w, h)));
  }, [containerSize, intrinsicPageSize, scale]);

  const effectiveScale = effectiveNavMode === 'page' ? fitScale : scale;

  // Clamp currentPage when the PDF changes.
  const pageCount = pdf?.numPages ?? 0;
  useEffect(() => {
    if (pageCount > 0 && currentPage > pageCount) setCurrentPage(1);
  }, [pageCount, currentPage]);

  const nextPage = useCallback(() => {
    setCurrentPage((p) => Math.min(pageCount, p + 1));
  }, [pageCount]);
  const prevPage = useCallback(() => {
    setCurrentPage((p) => Math.max(1, p - 1));
  }, []);

  // Arrow keys + PageUp/PageDown in page mode.
  useEffect(() => {
    if (effectiveNavMode !== 'page') return;
    function onKey(e: KeyboardEvent): void {
      // Don't fight inputs/selects.
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) {
        return;
      }
      if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
        nextPage();
        e.preventDefault();
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        prevPage();
        e.preventDefault();
      } else if (e.key === 'Escape' && readMode && onExitReadMode) {
        onExitReadMode();
        e.preventDefault();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [effectiveNavMode, nextPage, prevPage, readMode, onExitReadMode]);

  // Esc exit even in scroll-read-mode.
  useEffect(() => {
    if (!readMode || !onExitReadMode) return;
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        onExitReadMode!();
        e.preventDefault();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [readMode, onExitReadMode]);

  const visibleAnnotationsByPage = useMemo(() => {
    const byPage = new Map<number, Annotation[]>();
    for (const a of annotations) {
      if (a.layer === 'private' && !showPrivate) continue;
      if (a.layer === 'shared' && !showShared) continue;
      const list = byPage.get(a.page) ?? [];
      list.push(a);
      byPage.set(a.page, list);
    }
    return byPage;
  }, [annotations, showPrivate, showShared]);

  const markersInOrder = useMemo((): MarkerAnnotation[] => {
    const ms: MarkerAnnotation[] = [];
    for (const a of annotations) {
      if (a.kind !== 'marker') continue;
      if (a.layer === 'private' && !showPrivate) continue;
      if (a.layer === 'shared' && !showShared) continue;
      ms.push(a);
    }
    ms.sort((a, b) => a.page - b.page || a.position.y - b.position.y || a.position.x - b.position.x);
    return ms;
  }, [annotations, showPrivate, showShared]);

  function handleStrokeFinished(input: {
    layer: AnnotationLayer;
    page: number;
    color: string;
    width: number;
    points: Array<{ x: number; y: number }>;
  }): void {
    if (!pdfFile) return;
    const annotation: NewAnnotationInput = {
      fileId: pdfFile.id,
      kind: 'ink',
      ...input,
    };
    void add(annotation);
  }

  function handleMarkerPlaced(input: {
    layer: AnnotationLayer;
    page: number;
    markerKind: MarkerKind;
    label: string | null;
    position: { x: number; y: number };
  }): void {
    if (!pdfFile) return;
    void add({
      fileId: pdfFile.id,
      kind: 'marker',
      ...input,
    });
    if (KIND_TAKES_LABEL[input.markerKind]) {
      setMarkerLabelInput('');
    }
  }

  function handleUndo(): void {
    for (let i = annotations.length - 1; i >= 0; i--) {
      const a = annotations[i]!;
      if (a.isMine !== false) {
        void remove(a.id);
        return;
      }
    }
  }

  function handleClearMine(layer: AnnotationLayer): void {
    for (const a of annotations) {
      if (a.layer === layer && a.isMine !== false) {
        void remove(a.id);
      }
    }
  }

  function jumpToMarker(m: MarkerAnnotation): void {
    setJumpOpen(false);
    if (effectiveNavMode === 'page') {
      // In page mode, switch to the page that contains the marker.
      setCurrentPage(m.page);
    } else {
      const root = scrollContainerRef.current;
      if (!root) return;
      const pageEl = root.querySelector<HTMLElement>(`[data-page="${m.page}"]`);
      if (!pageEl) return;
      pageEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  const myAnnotationCount = annotations.filter((a) => a.isMine !== false).length;

  // ------- Toolbars -------------------------------------------------------

  const fullToolbar = (
    <div className="px-4 py-2 flex flex-wrap items-center gap-2">
      {piece && <h2 className="text-sm font-semibold mr-2">{piece.title}</h2>}
      {pieceLoading && <span className="text-xs text-muted-foreground">Loading piece…</span>}
      {pieceError && <span className="text-xs text-destructive">Piece error: {pieceError}</span>}

      {isAdmin && <UploadButton pieceId={pieceId} onUploaded={handleUploaded} />}
      {isAdmin && <div className="h-6 w-px bg-border mx-1" />}

      <div className="flex items-center rounded-md border border-border overflow-hidden">
        <ToolButton active={tool === 'pan'} onClick={() => setTool('pan')}>Pan</ToolButton>
        <ToolButton active={tool === 'pen'} onClick={() => setTool('pen')}>Pen</ToolButton>
        <ToolButton active={tool === 'marker'} onClick={() => setTool('marker')}>Marker</ToolButton>
      </div>

      <div
        className={cn(
          'flex items-center rounded-md border border-border overflow-hidden',
          tool === 'pan' && 'opacity-50',
        )}
      >
        <ToolButton active={drawTarget === 'private'} onClick={() => setDrawTarget('private')}>
          <span className="inline-block w-2 h-2 rounded-full mr-1.5" style={{ background: inkPresets.private.color }} />
          Private
        </ToolButton>
        <ToolButton active={drawTarget === 'shared'} onClick={() => setDrawTarget('shared')}>
          <span className="inline-block w-2 h-2 rounded-full mr-1.5" style={{ background: inkPresets.shared.color }} />
          Shared
        </ToolButton>
      </div>

      {tool === 'marker' && (
        <>
          <select
            value={markerKind}
            onChange={(e) => setMarkerKind(e.target.value as MarkerKind)}
            className="text-xs h-8 px-2 rounded-md border border-border bg-background"
          >
            {MARKER_KIND_ORDER.map((k) => (
              <option key={k} value={k}>
                {MARKER_PICKER_LABEL[k]}
              </option>
            ))}
          </select>
          {KIND_TAKES_LABEL[markerKind] && (
            <input
              type="text"
              value={markerLabelInput}
              onChange={(e) => setMarkerLabelInput(e.target.value)}
              placeholder={
                markerKind === 'bar' ? 'e.g. "Bar 24" or "Letter B"' :
                markerKind === 'custom' ? 'Label' :
                'e.g. "al Coda"'
              }
              className="text-xs h-8 px-2 rounded-md border border-border bg-background w-44"
            />
          )}
        </>
      )}

      <div className="h-6 w-px bg-border mx-1" />

      <label className="text-xs flex items-center gap-1 select-none cursor-pointer">
        <input type="checkbox" checked={showPrivate} onChange={(e) => setShowPrivate(e.target.checked)} />
        Show private
      </label>
      <label className="text-xs flex items-center gap-1 select-none cursor-pointer">
        <input type="checkbox" checked={showShared} onChange={(e) => setShowShared(e.target.checked)} />
        Show shared
      </label>

      <div className="h-6 w-px bg-border mx-1" />

      <ZoomControls scale={scale} onScale={setScale} />

      <div className="ml-auto flex items-center gap-2">
        <JumpToDropdown
          markers={markersInOrder}
          open={jumpOpen}
          onOpenChange={setJumpOpen}
          onJump={jumpToMarker}
        />
        <span className="text-xs text-muted-foreground">
          {annotationsLoading ? 'Loading…' : `${annotations.length} mark${annotations.length === 1 ? '' : 's'}`}
        </span>
        <Button size="sm" variant="ghost" onClick={handleUndo} disabled={myAnnotationCount === 0}>
          Undo mine
        </Button>
        <Button size="sm" variant="ghost" onClick={() => handleClearMine(drawTarget)} disabled={myAnnotationCount === 0}>
          Clear my {drawTarget}
        </Button>
      </div>
    </div>
  );

  /** Read-mode toolbar. Only what you'd want while singing:
   *    pen on/off, layer, page nav (page mode), zoom (scroll mode), jump-to, scroll/pages toggle, exit. */
  const minimalToolbar = (
    <div className="px-3 py-1.5 flex flex-wrap items-center gap-2">
      {piece && <h2 className="text-sm font-semibold mr-1 truncate max-w-[12rem]" title={piece.title}>{piece.title}</h2>}

      <div className="flex items-center rounded-md border border-border overflow-hidden">
        <ToolButton active={tool === 'pan'} onClick={() => setTool('pan')}>Look</ToolButton>
        <ToolButton active={tool === 'pen'} onClick={() => setTool('pen')}>Pen</ToolButton>
      </div>

      {tool === 'pen' && (
        <div className="flex items-center rounded-md border border-border overflow-hidden">
          <ToolButton active={drawTarget === 'private'} onClick={() => setDrawTarget('private')}>
            <span className="inline-block w-2 h-2 rounded-full mr-1.5" style={{ background: inkPresets.private.color }} />
            Private
          </ToolButton>
          <ToolButton active={drawTarget === 'shared'} onClick={() => setDrawTarget('shared')}>
            <span className="inline-block w-2 h-2 rounded-full mr-1.5" style={{ background: inkPresets.shared.color }} />
            Shared
          </ToolButton>
        </div>
      )}

      <div className="h-5 w-px bg-border mx-1" />

      {/* Scroll / Pages toggle */}
      <div className="flex items-center rounded-md border border-border overflow-hidden">
        <ToolButton active={navMode === 'scroll'} onClick={() => setNavMode('scroll')}>Scroll</ToolButton>
        <ToolButton active={navMode === 'page'} onClick={() => setNavMode('page')}>Pages</ToolButton>
      </div>

      {effectiveNavMode === 'page' && pageCount > 0 && (
        <>
          <Button size="sm" variant="outline" onClick={prevPage} disabled={currentPage <= 1} aria-label="Previous page">◀</Button>
          <span className="text-xs tabular-nums w-14 text-center">{currentPage} / {pageCount}</span>
          <Button size="sm" variant="outline" onClick={nextPage} disabled={currentPage >= pageCount} aria-label="Next page">▶</Button>
        </>
      )}

      {effectiveNavMode === 'scroll' && <ZoomControls scale={scale} onScale={setScale} />}

      <div className="ml-auto flex items-center gap-2">
        <JumpToDropdown
          markers={markersInOrder}
          open={jumpOpen}
          onOpenChange={setJumpOpen}
          onJump={jumpToMarker}
        />
        {onExitReadMode && (
          <button
            type="button"
            onClick={onExitReadMode}
            aria-label="Exit read mode"
            className="inline-flex items-center gap-1 h-9 px-3 rounded-md bg-primary text-primary-foreground font-medium text-xs hover:opacity-90 active:opacity-80"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden>
              <path d="M6 6 18 18" />
              <path d="M18 6 6 18" />
            </svg>
            Exit
          </button>
        )}
      </div>
    </div>
  );

  // ------- Render --------------------------------------------------------

  return (
    <div className="flex flex-col h-full">
      <header className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b border-border">
        {readMode ? minimalToolbar : fullToolbar}
        {annotationsError && (
          <div className="px-4 pb-2 text-xs text-destructive">Annotation sync issue: {annotationsError}</div>
        )}
      </header>

      <div ref={stageRef} className="flex-1 relative min-h-0">
        <div ref={scrollContainerRef} className="absolute inset-0 overflow-auto bg-muted/40">
          <div
            className={cn(
              'flex flex-col items-center gap-6',
              effectiveNavMode === 'page' ? 'py-4 px-4 justify-center min-h-full' : 'py-6 pl-12 pr-6',
            )}
          >
            {pieceLoading && <p className="text-sm text-muted-foreground">Loading piece…</p>}
            {!pieceLoading && !pdfFile && <p className="text-sm text-muted-foreground">No PDF in this piece yet.</p>}
            {pdfLoadError && <p className="text-sm text-destructive">Failed to load PDF: {pdfLoadError}</p>}
            {pdfFile && !pdf && !pdfLoadError && <p className="text-sm text-muted-foreground">Loading PDF…</p>}

            {pdf && effectiveNavMode === 'page' && currentPage >= 1 && currentPage <= pageCount && (
              <PdfPage
                key={`page-${currentPage}`}
                pdf={pdf}
                pageNumber={currentPage}
                scale={effectiveScale}
                annotations={visibleAnnotationsByPage.get(currentPage) ?? []}
                drawTarget={tool === 'pan' ? null : drawTarget}
                tool={tool}
                inkColor={activeInk.color}
                inkWidth={activeInk.width}
                markerKind={tool === 'marker' ? markerKind : null}
                markerLabelInput={markerLabelInput}
                onStrokeFinished={handleStrokeFinished}
                onMarkerPlaced={handleMarkerPlaced}
                onDeleteAnnotation={(id) => void remove(id)}
              />
            )}

            {pdf && effectiveNavMode === 'scroll' &&
              Array.from({ length: pageCount }, (_, i) => i + 1).map((pageNumber) => (
                <PdfPage
                  key={pageNumber}
                  pdf={pdf}
                  pageNumber={pageNumber}
                  scale={effectiveScale}
                  annotations={visibleAnnotationsByPage.get(pageNumber) ?? []}
                  drawTarget={tool === 'pan' ? null : drawTarget}
                  tool={tool}
                  inkColor={activeInk.color}
                  inkWidth={activeInk.width}
                  markerKind={tool === 'marker' ? markerKind : null}
                  markerLabelInput={markerLabelInput}
                  onStrokeFinished={handleStrokeFinished}
                  onMarkerPlaced={handleMarkerPlaced}
                  onDeleteAnnotation={(id) => void remove(id)}
                />
              ))}
          </div>
        </div>

        {/* Edge tap zones for page-turn nav. Narrow so the middle of the
            page is free for pen strokes. Disabled while marker tool is
            active so a placement at the page edge doesn't trigger a flip. */}
        {effectiveNavMode === 'page' && pageCount > 0 && tool !== 'marker' && (
          <>
            <button
              type="button"
              aria-label="Previous page"
              onClick={prevPage}
              disabled={currentPage <= 1}
              className="absolute left-0 top-0 bottom-0 w-16 z-10 disabled:opacity-30 disabled:cursor-not-allowed hover:bg-black/5 focus-visible:bg-black/10 transition-colors"
              style={{ cursor: currentPage > 1 ? 'w-resize' : 'not-allowed' }}
            />
            <button
              type="button"
              aria-label="Next page"
              onClick={nextPage}
              disabled={currentPage >= pageCount}
              className="absolute right-0 top-0 bottom-0 w-16 z-10 disabled:opacity-30 disabled:cursor-not-allowed hover:bg-black/5 focus-visible:bg-black/10 transition-colors"
              style={{ cursor: currentPage < pageCount ? 'e-resize' : 'not-allowed' }}
            />
          </>
        )}
      </div>
    </div>
  );
}

function ToolButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'px-3 py-1.5 text-xs font-medium transition-colors flex items-center',
        active ? 'bg-primary text-primary-foreground' : 'bg-background hover:bg-accent text-foreground',
      )}
    >
      {children}
    </button>
  );
}

function ZoomControls({ scale, onScale }: { scale: number; onScale: (s: number) => void }) {
  return (
    <div className="flex items-center gap-1">
      <Button size="sm" variant="outline" onClick={() => onScale(Math.max(0.5, scale - 0.1))}>−</Button>
      <span className="text-xs tabular-nums w-12 text-center">{Math.round(scale * 100)}%</span>
      <Button size="sm" variant="outline" onClick={() => onScale(Math.min(3, scale + 0.1))}>+</Button>
    </div>
  );
}

interface JumpToDropdownProps {
  markers: MarkerAnnotation[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onJump: (m: MarkerAnnotation) => void;
}

function JumpToDropdown({ markers, open, onOpenChange, onJump }: JumpToDropdownProps) {
  return (
    <div className="relative">
      <Button
        size="sm"
        variant="outline"
        onClick={() => onOpenChange(!open)}
        disabled={markers.length === 0}
      >
        Jump to ▾ ({markers.length})
      </Button>
      {open && markers.length > 0 && (
        <div className="absolute right-0 top-full mt-1 bg-background border border-border rounded-md shadow-lg z-30 max-h-72 overflow-auto min-w-48">
          {markers.map((m) => (
            <button
              key={m.id}
              type="button"
              className="block w-full text-left px-3 py-1.5 text-xs hover:bg-accent"
              onClick={() => onJump(m)}
            >
              <span className="font-mono mr-2">p.{m.page}</span>
              <span className="font-semibold">{markerLabel(m)}</span>
              {m.label && m.markerKind !== 'bar' && m.markerKind !== 'custom' && (
                <span className="ml-2 text-muted-foreground">{m.label}</span>
              )}
              <span className={cn('ml-2 text-[10px] uppercase', m.layer === 'shared' ? 'text-amber-700' : 'text-blue-700')}>
                {m.layer}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
