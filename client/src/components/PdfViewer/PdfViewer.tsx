import { useEffect, useMemo, useRef, useState } from 'react';
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
   *  viewer in sync with sibling components (e.g. AudioPlayer) after a
   *  mutation. */
  refreshTick?: number;
  /** Called after this viewer adds/removes a file, so the parent can
   *  refresh siblings + the piece list's updated_at ordering. */
  onPieceMutated?: () => void;
}

/** Marker kinds that benefit from a free-text label. `bar` and `custom`
 *  practically require one ("Bar 24", "Letter B"); D.S./D.C. accept one
 *  to carry "al Coda" / "al Fine". The rest ignore the input. */
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

export function PdfViewer({ pieceId, refreshTick = 0, onPieceMutated }: PdfViewerProps) {
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

  const scrollContainerRef = useRef<HTMLDivElement>(null);

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
    setPdfLoadError(null);
    const task = pdfjsLib.getDocument(pdfFile.url);
    task.promise.then(
      (loaded) => {
        if (!cancelled) setPdf(loaded);
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

  /** All visible markers sorted in reading order — page asc, then y, then x. */
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
    // Clear the label so the next placement doesn't accidentally reuse it.
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
    const root = scrollContainerRef.current;
    if (!root) return;
    const pageEl = root.querySelector<HTMLElement>(`[data-page="${m.page}"]`);
    if (!pageEl) return;
    pageEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  const pageCount = pdf?.numPages ?? 0;
  const myAnnotationCount = annotations.filter((a) => a.isMine !== false).length;

  return (
    <div className="flex flex-col h-full">
      <header className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b border-border">
        <div className="px-4 py-2 flex flex-wrap items-center gap-2">
          {piece && <h2 className="text-sm font-semibold mr-2">{piece.title}</h2>}
          {pieceLoading && <span className="text-xs text-muted-foreground">Loading piece…</span>}
          {pieceError && <span className="text-xs text-destructive">Piece error: {pieceError}</span>}

          <UploadButton pieceId={pieceId} onUploaded={handleUploaded} />

          <div className="h-6 w-px bg-border mx-1" />

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

          <div className="flex items-center gap-1">
            <Button size="sm" variant="outline" onClick={() => setScale((s) => Math.max(0.5, s - 0.1))}>−</Button>
            <span className="text-xs tabular-nums w-12 text-center">{Math.round(scale * 100)}%</span>
            <Button size="sm" variant="outline" onClick={() => setScale((s) => Math.min(3, s + 0.1))}>+</Button>
          </div>

          <div className="ml-auto flex items-center gap-2">
            <div className="relative">
              <Button
                size="sm"
                variant="outline"
                onClick={() => setJumpOpen((o) => !o)}
                disabled={markersInOrder.length === 0}
              >
                Jump to ▾ ({markersInOrder.length})
              </Button>
              {jumpOpen && markersInOrder.length > 0 && (
                <div className="absolute right-0 top-full mt-1 bg-background border border-border rounded-md shadow-lg z-30 max-h-72 overflow-auto min-w-48">
                  {markersInOrder.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      className="block w-full text-left px-3 py-1.5 text-xs hover:bg-accent"
                      onClick={() => jumpToMarker(m)}
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
        {annotationsError && (
          <div className="px-4 pb-2 text-xs text-destructive">Annotation sync issue: {annotationsError}</div>
        )}
      </header>

      <div ref={scrollContainerRef} className="flex-1 overflow-auto bg-muted/40">
        <div className="flex flex-col items-center gap-6 py-6 pl-12 pr-6">
          {pieceLoading && <p className="text-sm text-muted-foreground">Loading piece…</p>}
          {!pieceLoading && !pdfFile && <p className="text-sm text-muted-foreground">No PDF in this piece yet.</p>}
          {pdfLoadError && <p className="text-sm text-destructive">Failed to load PDF: {pdfLoadError}</p>}
          {pdfFile && !pdf && !pdfLoadError && <p className="text-sm text-muted-foreground">Loading PDF…</p>}

          {pdf &&
            Array.from({ length: pageCount }, (_, i) => i + 1).map((pageNumber) => (
              <PdfPage
                key={pageNumber}
                pdf={pdf}
                pageNumber={pageNumber}
                scale={scale}
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
