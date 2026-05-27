import { useEffect, useMemo, useState } from 'react';
import { pdfjsLib, type PDFDocumentProxy } from '@/lib/pdfjs.ts';
import { Button } from '@/components/ui/button.tsx';
import { cn } from '@/lib/utils.ts';
import type { Annotation, AnnotationLayer, AnnotationTool } from '@/types/annotations.ts';
import { usePiece } from '@/hooks/usePiece.ts';
import { useAnnotations } from '@/hooks/useAnnotations.ts';
import { PdfPage } from './PdfPage.tsx';

interface PdfViewerProps {
  pieceId: number;
}

/**
 * Loads a piece + its annotations from the API, renders the first PDF
 * file's pages stacked vertically, and provides a toolbar with zoom +
 * layer/tool selection + visibility toggles. Annotations persist through
 * the useAnnotations hook.
 */
export function PdfViewer({ pieceId }: PdfViewerProps) {
  const { piece, loading: pieceLoading, error: pieceError } = usePiece(pieceId);
  const pdfFile = useMemo(() => piece?.files.find((f) => f.kind === 'pdf') ?? null, [piece]);

  const { annotations, loading: annotationsLoading, error: annotationsError, add, remove } = useAnnotations(pieceId);

  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [pdfLoadError, setPdfLoadError] = useState<string | null>(null);
  const [scale, setScale] = useState(1.25);
  const [drawTarget, setDrawTarget] = useState<AnnotationLayer>('private');
  const [tool, setTool] = useState<AnnotationTool>('pan');
  const [showPrivate, setShowPrivate] = useState(true);
  const [showShared, setShowShared] = useState(true);

  // Single-colour-per-layer for now; custom picker arrives with the rest
  // of the toolset (highlight, eraser, text note).
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

  function handleStrokeFinished(a: Annotation): void {
    // PdfPage builds an annotation with a temp id; we let useAnnotations
    // mint a fresh id and persist. Pass the strokes through.
    if (!pdfFile) return;
    void add({
      fileId: pdfFile.id,
      layer: a.layer,
      page: a.page,
      kind: 'ink',
      color: a.color,
      width: a.width,
      points: a.points,
    });
  }

  function handleUndo(): void {
    // Undo my most-recent annotation. Untouched are other people's shared marks.
    for (let i = annotations.length - 1; i >= 0; i--) {
      const a = annotations[i]!;
      if (a.isMine !== false) {
        void remove(a.id);
        return;
      }
    }
  }

  function handleClearMine(layer: AnnotationLayer): void {
    // Bulk clear is scoped to my own annotations in that layer. Other
    // people's shared annotations stay intact.
    for (const a of annotations) {
      if (a.layer === layer && a.isMine !== false) {
        void remove(a.id);
      }
    }
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

          <div className="flex items-center rounded-md border border-border overflow-hidden">
            <ToolButton active={tool === 'pan'} onClick={() => setTool('pan')}>Pan</ToolButton>
            <ToolButton active={tool === 'pen'} onClick={() => setTool('pen')}>Pen</ToolButton>
          </div>

          <div
            className={cn(
              'flex items-center rounded-md border border-border overflow-hidden',
              tool !== 'pen' && 'opacity-50',
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

      <div className="flex-1 overflow-auto bg-muted/40">
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
                drawTarget={tool === 'pen' ? drawTarget : null}
                tool={tool}
                inkColor={activeInk.color}
                inkWidth={activeInk.width}
                onAnnotationAdded={handleStrokeFinished}
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
