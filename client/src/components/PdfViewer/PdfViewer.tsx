import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { pdfjsLib, type PDFDocumentProxy } from '@/lib/pdfjs.ts';
import { Button, Icon } from '@/components/ui/button.tsx';
import { Popover } from '@/components/ui/popover.tsx';
import { usePlayer } from '@/player/PlayerContext.tsx';
import { toQueueTrack } from '@/components/AudioPlayer/AudioPlayer.tsx';
import { cn } from '@/lib/utils.ts';
import {
  INK_COLORS,
  INK_WIDTH,
  MARKER_KIND_ORDER,
  MARKER_PICKER_LABEL,
  markerLabel,
  type Annotation,
  type AnnotationLayer,
  type AnnotationTool,
  type InkPen,
  type MarkerAnnotation,
  type MarkerKind,
} from '@/types/annotations.ts';
import { FILE_KIND_LABEL, isPdfFile, usePiece, type FileKind, type Piece, type PieceFile } from '@/hooks/usePiece.ts';
import { KindBadge } from './KindBadge.tsx';
import { useSections, type Section } from '@/hooks/useSections.ts';
import { replaceFile } from '@/hooks/useUploadFile.ts';
import { useAnnotations, type NewAnnotationInput } from '@/hooks/useAnnotations.ts';
import { PdfPage } from './PdfPage.tsx';
import { analysePage, type Box, type PageLayout } from '@/lib/pageLayout.ts';
import { overrideKey, partFromSection, resolvePartLine, type PartLineOverrides } from '@/lib/partLine.ts';
import type { StaveTarget } from './PdfPage.tsx';
import { UploadButton } from './UploadButton.tsx';
import { MarkerGlyph } from './markerIcons.tsx';

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
  /** Enter read mode from the toolbar button. */
  onEnterReadMode?: () => void;
  /** Whether the current user holds an admin role. Gates the upload and
   *  delete UI so we don't show buttons that 403 on click. */
  isAdmin?: boolean;
  /** The member's own voice part; offered first when sharing with a part. */
  mySectionId?: number | null;
  /** "My line": highlight the member's own stave. A member-wide setting. */
  partLineOn?: boolean;
  onPartLineChange?: (on: boolean) => void;
  /** Which PDF to open first (from a sheet-music row). Defaults to the first. */
  initialFileId?: number | null;
  /** Read mode only: whether the user has tucked the player bar away. */
  playerHidden?: boolean;
  onPlayerHiddenChange?: (hidden: boolean) => void;
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

/** How much of the score read mode shows at once. */
type FitMode = 'page' | 'half' | '1' | '2' | '3';
const FIT_OPTIONS: Array<{ value: FitMode; label: string; title: string }> = [
  { value: 'page', label: 'Page', title: 'A whole page, margins cropped' },
  { value: 'half', label: '½', title: 'Half a page at a time' },
  { value: '1', label: '1', title: 'One system (line of music) at a time' },
  { value: '2', label: '2', title: 'Two systems at a time' },
  { value: '3', label: '3', title: 'Three systems at a time' },
];
const FIT_KEY = 'choirfriend.readFit';
const INK_COLORS_KEY = 'choirfriend.inkColors';
const SHARE_WITH_KEY = 'choirfriend.shareWith';
function loadShareWith(): number[] {
  try {
    const saved = JSON.parse(localStorage.getItem(SHARE_WITH_KEY) ?? '[]') as unknown;
    return Array.isArray(saved) ? saved.filter((n): n is number => Number.isInteger(n)) : [];
  } catch {
    return [];
  }
}
function loadInkColors(): Record<InkPen, string> {
  const colors: Record<InkPen, string> = { pen: INK_COLORS.pen[1]!, highlighter: INK_COLORS.highlighter[0]! };
  try {
    const saved = JSON.parse(localStorage.getItem(INK_COLORS_KEY) ?? '{}') as Partial<Record<InkPen, string>>;
    for (const pen of ['pen', 'highlighter'] as const) {
      const c = saved[pen];
      if (c && INK_COLORS[pen].includes(c)) colors[pen] = c;
    }
  } catch {
    // storage unavailable or junk
  }
  return colors;
}
function loadFit(): FitMode {
  try {
    const v = localStorage.getItem(FIT_KEY);
    if (v && FIT_OPTIONS.some((o) => o.value === v)) return v as FitMode;
  } catch {
    // storage unavailable
  }
  return 'page';
}

interface Chunk {
  page: number;
  clip: Box | null;
}

/** Split each page into what read mode shows per step. Pages not yet
 *  analysed show whole and uncropped. */
function buildChunks(pageCount: number, layouts: Map<number, PageLayout>, fit: FitMode): Chunk[] {
  const out: Chunk[] = [];
  for (let page = 1; page <= pageCount; page++) {
    const L = layouts.get(page);
    if (!L) {
      out.push({ page, clip: null });
      continue;
    }
    const { content: c, systems } = L;
    const band = (y0: number, y1: number): Chunk => ({ page, clip: { x0: c.x0, x1: c.x1, y0, y1 } });
    if (fit === 'page' || (systems.length <= 1 && fit !== 'half')) {
      out.push(band(c.y0, c.y1));
      continue;
    }
    if (systems.length === 0) {
      // No staves found (lyric sheet, odd scan): halve the page.
      const mid = (c.y0 + c.y1) / 2;
      out.push(band(c.y0, mid), band(mid, c.y1));
      continue;
    }
    const per = fit === 'half' ? Math.ceil(systems.length / 2) : Number(fit);
    for (let i = 0; i < systems.length; i += per) {
      const group = systems.slice(i, i + per);
      out.push(band(group[0]!.y0, group[group.length - 1]!.y1));
    }
  }
  return out;
}

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
  onEnterReadMode,
  isAdmin = false,
  mySectionId = null,
  partLineOn = false,
  onPartLineChange,
  initialFileId = null,
  playerHidden = false,
  onPlayerHiddenChange,
}: PdfViewerProps) {
  const { piece, loading: pieceLoading, error: pieceError, refresh: refreshPiece } = usePiece(pieceId, refreshTick);

  // A piece can carry several viewable PDFs — the score, extra parts, and any
  // lyric sheet that happens to be a PDF. Members pick which one to view; the
  // first sheet-music file is the default.
  const pdfFiles = useMemo(
    () => piece?.files.filter((f) => f.kind === 'pdf' || (f.kind === 'lyrics' && isPdfFile(f))) ?? [],
    [piece],
  );
  const [selectedPdfId, setSelectedPdfId] = useState<number | null>(initialFileId);
  /** Phones in read mode hide the toolbar; this shows it on demand. */
  const [toolsOpen, setToolsOpen] = useState(false);
  const pdfFile = useMemo(
    () => pdfFiles.find((f) => f.id === selectedPdfId) ?? pdfFiles[0] ?? null,
    [pdfFiles, selectedPdfId],
  );

  function handleUploaded(): void {
    refreshPiece();
    onPieceMutated?.();
  }

  const { annotations, loading: annotationsLoading, error: annotationsError, add, remove } = useAnnotations(pieceId);

  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [pdfLoadError, setPdfLoadError] = useState<string | null>(null);
  // User zoom in scroll mode, relative to the fit-to-width base. 1 = "fits
  // the screen width" (capped at 125% on wide screens so desktop pages don't
  // balloon).
  const [zoom, setZoom] = useState(1);
  const [drawTarget, setDrawTarget] = useState<AnnotationLayer>('shared');
  /** Which parts new shared marks are for; empty = everyone. */
  const { sections, byId: sectionsById } = useSections();
  const [shareWith, setShareWithState] = useState<number[]>(loadShareWith);
  const setShareWith = (ids: number[]): void => {
    setShareWithState(ids);
    try {
      localStorage.setItem(SHARE_WITH_KEY, JSON.stringify(ids));
    } catch {
      // storage unavailable
    }
  };
  // Forget parts that no longer exist (renamed/deleted by an admin).
  const shareWithIds = shareWith.filter((id) => sectionsById.has(id));
  const sectionIdsFor = (layer: AnnotationLayer): number[] | null =>
    layer === 'shared' && shareWithIds.length ? shareWithIds : null;
  const [tool, setTool] = useState<AnnotationTool>('pan');
  // Entering read mode drops the marker tool — you're performing, not placing
  // marks, so taps should jump/navigate rather than drop new markers.
  useEffect(() => {
    if (readMode) setTool((t) => (t === 'marker' ? 'pan' : t));
    if (!readMode) setToolsOpen(false);
  }, [readMode]);
  const [showPrivate, setShowPrivate] = useState(true);
  const [showShared, setShowShared] = useState(true);
  const [markerKind, setMarkerKind] = useState<MarkerKind>('segno');
  const [markerLabelInput, setMarkerLabelInput] = useState('');
  const [jumpOpen, setJumpOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [navMode, setNavMode] = useState<NavMode>(pickInitialNavMode);
  const [currentPage, setCurrentPage] = useState(1);
  // Read mode: what to show per step, and the top of the current step on
  // its page (a fraction), so re-analysis never loses your place.
  const [fit, setFitState] = useState<FitMode>(loadFit);
  const setFit = (f: FitMode): void => {
    setFitState(f);
    try {
      localStorage.setItem(FIT_KEY, f);
    } catch {
      // storage unavailable
    }
  };
  const [chunkY, setChunkY] = useState(0);
  const [layouts, setLayouts] = useState<Map<number, PageLayout>>(new Map());

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

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

  // Width available to a page in scroll mode (the content box of the padded
  // column, so padding is already excluded). Drives fit-to-width.
  const [contentWidth, setContentWidth] = useState(0);
  useEffect(() => {
    const el = contentRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) setContentWidth(rect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Page 1 intrinsic viewport — needed to compute fit-scale.
  const [intrinsicPageSize, setIntrinsicPageSize] = useState<{ w: number; h: number } | null>(null);

  // Each pen remembers its own colour on this device.
  const [inkColors, setInkColorsState] = useState<Record<InkPen, string>>(loadInkColors);
  const setInkColor = (pen: InkPen, color: string): void => {
    setInkColorsState((prev) => {
      const next = { ...prev, [pen]: color };
      try {
        localStorage.setItem(INK_COLORS_KEY, JSON.stringify(next));
      } catch {
        // storage unavailable
      }
      return next;
    });
  };
  const activePen: InkPen = tool === 'highlighter' ? 'highlighter' : 'pen';
  const activeInk = { color: inkColors[activePen], width: INK_WIDTH[activePen] };
  const inkTool = tool === 'pen' || tool === 'highlighter';

  useEffect(() => {
    if (!pdfFile) {
      setPdf(null);
      return;
    }
    let cancelled = false;
    setPdf(null);
    setIntrinsicPageSize(null);
    setPdfLoadError(null);
    const task = pdfjsLib.getDocument({ url: pdfFile.url, disableRange: true }); // whole file, so the service worker can cache it
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

  // Read mode crops margins and can step by system, and "My line" needs the
  // staves, so analyse each page once (cached per file) when either is on.
  const needLayouts = readMode || partLineOn;
  useEffect(() => {
    setLayouts(new Map());
    if (!pdf || !needLayouts || !pdfFile) return;
    const fileId = pdfFile.id;
    let cancelled = false;
    (async () => {
      for (let p = 1; p <= pdf.numPages; p++) {
        const L = await analysePage(pdf, p, `${fileId}`);
        if (cancelled) return;
        setLayouts((m) => new Map(m).set(p, L));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pdf, needLayouts, pdfFile?.id]);

  // --- My line -------------------------------------------------------------
  const [lineOverrides, setLineOverrides] = useState<PartLineOverrides>({});
  const [adjustingLine, setAdjustingLine] = useState(false);
  useEffect(() => {
    setLineOverrides({});
    if (!partLineOn || !pdfFile) return;
    let cancelled = false;
    fetch(`/api/me/part-lines/${pdfFile.id}`, { credentials: 'include' })
      .then((r) => (r.ok ? (r.json() as Promise<PartLineOverrides>) : {}))
      .then((o) => {
        if (!cancelled) setLineOverrides(o);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [partLineOn, pdfFile?.id]);
  useEffect(() => {
    if (!partLineOn) setAdjustingLine(false);
  }, [partLineOn]);
  const saveLineOverrides = (next: PartLineOverrides): void => {
    setLineOverrides(next);
    if (!pdfFile) return;
    void fetch(`/api/me/part-lines/${pdfFile.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(next),
    });
  };
  const mySection = mySectionId !== null ? sectionsById.get(mySectionId) ?? null : null;
  const myPart = useMemo(() => (mySection ? partFromSection(mySection.label, mySection.badge) : null), [mySection]);
  const linePicks = useMemo(
    () => (partLineOn && pdf ? resolvePartLine(layouts, pdf.numPages, myPart, lineOverrides) : []),
    [partLineOn, pdf, layouts, myPart, lineOverrides],
  );
  /** Bands to draw, by page: the picked stave, padded to take in notes and
   *  words just above and below it without reaching the next stave. */
  const lineBandsByPage = useMemo(() => {
    const m = new Map<number, Box[]>();
    for (const { page, system, stave } of linePicks) {
      const L = layouts.get(page);
      const sys = L?.systems[system];
      const st = sys?.staves[stave];
      if (!L || !sys || !st) continue;
      const pad = (st.y1 - st.y0) * 0.7;
      const prev = sys.staves[stave - 1];
      const next = sys.staves[stave + 1];
      const box: Box = {
        x0: st.x0 - 0.008,
        x1: L.content.x1 - 0.004,
        y0: Math.max(st.y0 - pad, prev ? (prev.y1 + st.y0) / 2 : sys.y0),
        y1: Math.min(st.y1 + pad, next ? (st.y1 + next.y0) / 2 : sys.y1),
      };
      m.set(page, [...(m.get(page) ?? []), box]);
    }
    return m;
  }, [linePicks, layouts]);
  const staveTargetsFor = (page: number): StaveTarget[] | undefined => {
    if (!adjustingLine) return undefined;
    const L = layouts.get(page);
    if (!L) return [];
    const picked = new Set(linePicks.filter((p) => p.page === page).map((p) => `${p.system}:${p.stave}`));
    return L.systems.flatMap((sys, system) =>
      sys.staves.map((st, stave) => ({
        system,
        stave,
        picked: picked.has(`${system}:${stave}`),
        box: { x0: st.x0 - 0.008, x1: L.content.x1 - 0.004, y0: st.y0 - 0.004, y1: st.y1 + 0.004 },
      })),
    );
  };
  /** Tap a stave: it becomes my line for that system (and, by carry-over,
   *  the systems after it); tap my line again to clear that system. */
  const pickStave = (page: number, system: number, stave: number): void => {
    const already = linePicks.some((p) => p.page === page && p.system === system && p.stave === stave);
    saveLineOverrides({ ...lineOverrides, [overrideKey(page, system)]: already ? -1 : stave });
  };
  const myLineControl = onPartLineChange && (
    <MyLineControl
      on={partLineOn}
      onChange={onPartLineChange}
      partName={mySection?.label ?? null}
      guessable={!!myPart}
      adjusting={adjustingLine}
      onAdjustingChange={setAdjustingLine}
      hasCorrections={Object.keys(lineOverrides).length > 0}
      onReset={() => saveLineOverrides({})}
    />
  );

  // Page-turn always re-renders one page; in edit mode we always scroll.
  const effectiveNavMode: NavMode = readMode ? navMode : 'scroll';

  // Fit-to-container scale used in page mode. ~32px margin gives the page
  // visible breathing room and prevents the tap zones from sitting on top
  // of content.
  const fitScale = useMemo(() => {
    if (!intrinsicPageSize || containerSize.w === 0 || containerSize.h === 0) return 1.25;
    const margin = 32;
    const w = (containerSize.w - margin * 2) / intrinsicPageSize.w;
    const h = (containerSize.h - margin * 2) / intrinsicPageSize.h;
    return Math.max(0.3, Math.min(4, Math.min(w, h)));
  }, [containerSize, intrinsicPageSize]);

  // Scroll-mode base: fit the page to the available width (phones), but no
  // larger than the old fixed 125% (desktops). Zoom multiplies this.
  const scrollBaseScale = useMemo(() => {
    if (!intrinsicPageSize || contentWidth === 0) return 1.25;
    return Math.max(0.3, Math.min(1.25, contentWidth / intrinsicPageSize.w));
  }, [contentWidth, intrinsicPageSize]);

  const pageCountForChunks = pdf?.numPages ?? 0;
  const chunked = readMode && effectiveNavMode === 'page';
  const chunks = useMemo(
    () => (chunked ? buildChunks(pageCountForChunks, layouts, fit) : []),
    [chunked, pageCountForChunks, layouts, fit],
  );
  const chunkIndex = useMemo(() => {
    let idx = -1;
    chunks.forEach((c, i) => {
      if (c.page !== currentPage) return;
      if (idx === -1 || (c.clip?.y0 ?? 0) <= chunkY + 0.001) idx = i;
    });
    return Math.max(0, idx);
  }, [chunks, currentPage, chunkY]);
  const chunk = chunked ? chunks[chunkIndex] ?? null : null;

  // Fill the stage with the current step: crop to it, then scale to fit.
  const chunkScale = useMemo(() => {
    if (!chunk?.clip || !intrinsicPageSize || containerSize.w === 0) return null;
    const margin = 8;
    const w = (containerSize.w - margin * 2) / ((chunk.clip.x1 - chunk.clip.x0) * intrinsicPageSize.w);
    const h = (containerSize.h - margin * 2) / ((chunk.clip.y1 - chunk.clip.y0) * intrinsicPageSize.h);
    return Math.max(0.3, Math.min(8, w, h));
  }, [chunk, intrinsicPageSize, containerSize]);

  // Read-mode scroll: crop each page's margins and fit the music to the width.
  const readScrollScale = useCallback(
    (page: number): number => {
      const L = layouts.get(page);
      if (!L || !intrinsicPageSize || contentWidth === 0) return scrollBaseScale * zoom;
      return Math.max(0.3, Math.min(1.8, contentWidth / ((L.content.x1 - L.content.x0) * intrinsicPageSize.w))) * zoom;
    },
    [layouts, intrinsicPageSize, contentWidth, scrollBaseScale, zoom],
  );

  const effectiveScale = effectiveNavMode === 'page' ? chunkScale ?? fitScale : scrollBaseScale * zoom;

  // Switching to a different PDF in the piece starts at its first page.
  useEffect(() => {
    setCurrentPage(1);
  }, [pdfFile?.id]);

  // Clamp currentPage when the PDF changes.
  const pageCount = pdf?.numPages ?? 0;
  useEffect(() => {
    if (pageCount > 0 && currentPage > pageCount) setCurrentPage(1);
  }, [pageCount, currentPage]);

  const goToChunk = useCallback((c: Chunk | undefined) => {
    if (!c) return;
    setCurrentPage(c.page);
    setChunkY(c.clip?.y0 ?? 0);
  }, []);
  const nextPage = useCallback(() => {
    if (chunked) return goToChunk(chunks[chunkIndex + 1]);
    setCurrentPage((p) => Math.min(pageCount, p + 1));
  }, [pageCount, chunked, chunks, chunkIndex, goToChunk]);
  const prevPage = useCallback(() => {
    if (chunked) return goToChunk(chunks[chunkIndex - 1]);
    setCurrentPage((p) => Math.max(1, p - 1));
  }, [chunked, chunks, chunkIndex, goToChunk]);
  // Swipe to turn pages (or step systems) in page view. One finger, a clear
  // horizontal flick; in a system view a vertical flick steps too. Ignored
  // while drawing, while pinch-zoomed, and when the content can still scroll
  // in the swipe's direction, so panning a zoomed page never flips it.
  const swipeRef = useRef<{ x: number; y: number; t: number } | null>(null);
  function onSwipeStart(e: React.TouchEvent): void {
    swipeRef.current = e.touches.length === 1 ? { x: e.touches[0]!.clientX, y: e.touches[0]!.clientY, t: Date.now() } : null;
  }
  function onSwipeMove(e: React.TouchEvent): void {
    if (e.touches.length > 1) swipeRef.current = null;
  }
  function onSwipeEnd(e: React.TouchEvent): void {
    const start = swipeRef.current;
    swipeRef.current = null;
    if (!start || tool !== 'pan') return;
    if ((window.visualViewport?.scale ?? 1) > 1.05) return;
    const t = e.changedTouches[0];
    if (!t) return;
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    if (Date.now() - start.t > 800) return;
    const sc = scrollContainerRef.current;
    const MIN = 50;
    if (effectiveNavMode === 'scroll') {
      // Scroll view already scrolls vertically; a sideways flick jumps to the
      // top of the next / previous page instead.
      if (!sc || Math.abs(dx) <= MIN || Math.abs(dx) <= 1.5 * Math.abs(dy)) return;
      if (dx < 0 && sc.scrollLeft + sc.clientWidth < sc.scrollWidth - 2) return;
      if (dx > 0 && sc.scrollLeft > 2) return;
      const pages = Array.from(sc.querySelectorAll<HTMLElement>('[data-page]'));
      const top = sc.getBoundingClientRect().top;
      // The page whose top is at or above the viewport top is "current".
      let cur = 0;
      pages.forEach((el, i) => { if (el.getBoundingClientRect().top - top <= 8) cur = i; });
      const target = pages[dx < 0 ? cur + 1 : (pages[cur]!.getBoundingClientRect().top - top < -8 ? cur : cur - 1)];
      if (target) sc.scrollTo({ top: sc.scrollTop + target.getBoundingClientRect().top - top - 4, behavior: 'smooth' });
      return;
    }
    if (Math.abs(dx) > MIN && Math.abs(dx) > 1.5 * Math.abs(dy)) {
      if (sc && dx < 0 && sc.scrollLeft + sc.clientWidth < sc.scrollWidth - 2) return;
      if (sc && dx > 0 && sc.scrollLeft > 2) return;
      if (dx < 0) nextPage(); else prevPage();
    } else if (chunked && Math.abs(dy) > MIN && Math.abs(dy) > 1.5 * Math.abs(dx)) {
      if (sc && dy < 0 && sc.scrollTop + sc.clientHeight < sc.scrollHeight - 2) return;
      if (sc && dy > 0 && sc.scrollTop > 2) return;
      if (dy < 0) nextPage(); else prevPage();
    }
  }

  const canPrev = chunked ? chunkIndex > 0 : currentPage > 1;
  const canNext = chunked ? chunkIndex < chunks.length - 1 : currentPage < pageCount;

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

  // Annotations belong to a specific file. With several PDFs per piece we must
  // only show marks made on the PDF currently open, or they'd bleed across
  // documents at the same page number. Legacy marks with no fileId show on all.
  const belongsToActivePdf = useCallback(
    (a: Annotation): boolean => !pdfFile || a.fileId === undefined || a.fileId === pdfFile.id,
    [pdfFile],
  );

  const visibleAnnotationsByPage = useMemo(() => {
    const byPage = new Map<number, Annotation[]>();
    for (const a of annotations) {
      if (!belongsToActivePdf(a)) continue;
      if (a.layer === 'private' && !showPrivate) continue;
      if (a.layer === 'shared' && !showShared) continue;
      const list = byPage.get(a.page) ?? [];
      list.push(a);
      byPage.set(a.page, list);
    }
    return byPage;
  }, [annotations, showPrivate, showShared, belongsToActivePdf]);

  const markersInOrder = useMemo((): MarkerAnnotation[] => {
    const ms: MarkerAnnotation[] = [];
    for (const a of annotations) {
      if (a.kind !== 'marker') continue;
      if (!belongsToActivePdf(a)) continue;
      if (a.layer === 'private' && !showPrivate) continue;
      if (a.layer === 'shared' && !showShared) continue;
      ms.push(a);
    }
    ms.sort((a, b) => a.page - b.page || a.position.y - b.position.y || a.position.x - b.position.x);
    return ms;
  }, [annotations, showPrivate, showShared, belongsToActivePdf]);

  function handleStrokeFinished(input: {
    layer: AnnotationLayer;
    page: number;
    pen: InkPen;
    color: string;
    width: number;
    points: Array<{ x: number; y: number }>;
  }): void {
    if (!pdfFile) return;
    const annotation: NewAnnotationInput = {
      fileId: pdfFile.id,
      kind: 'ink',
      sectionIds: sectionIdsFor(input.layer),
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
      sectionIds: sectionIdsFor(input.layer),
      ...input,
    });
    if (KIND_TAKES_LABEL[input.markerKind]) {
      setMarkerLabelInput('');
    }
    // One-and-done: you wouldn't place the same marker twice, so drop back to
    // the Look tool after a placement.
    setTool('pan');
  }

  function handleUndo(): void {
    for (let i = annotations.length - 1; i >= 0; i--) {
      const a = annotations[i]!;
      if (a.isMine !== false && belongsToActivePdf(a)) {
        void remove(a.id);
        return;
      }
    }
  }

  function handleClearMine(layer: AnnotationLayer): void {
    for (const a of annotations) {
      if (a.layer === layer && a.isMine !== false && belongsToActivePdf(a)) {
        void remove(a.id);
      }
    }
  }

  /** Scroll so the marker's own position sits just below the top edge —
   *  instantly, no animation (you want to be there immediately when singing). */
  function scrollMarkerIntoView(m: MarkerAnnotation): void {
    const root = scrollContainerRef.current;
    const pageEl = root?.querySelector<HTMLElement>(`[data-page="${m.page}"]`);
    if (!root || !pageEl) return;
    const rootRect = root.getBoundingClientRect();
    const pageRect = pageEl.getBoundingClientRect();
    const markerY = pageRect.top + m.position.y * pageRect.height; // viewport coords
    const top = root.scrollTop + (markerY - rootRect.top) - 24; // small gap above
    root.scrollTo({ top: Math.max(0, top), behavior: 'auto' });
  }

  function jumpToMarker(m: MarkerAnnotation): void {
    setJumpOpen(false);
    if (effectiveNavMode === 'page') {
      setCurrentPage(m.page);
      // In a system view, land on the step that holds the marker.
      setChunkY(m.position.y);
      // Let the page render, then land on the marker's spot.
      requestAnimationFrame(() => scrollMarkerIntoView(m));
    } else {
      scrollMarkerIntoView(m);
    }
  }

  function jumpToTop(): void {
    if (effectiveNavMode === 'page') {
      setCurrentPage(1);
      setChunkY(0);
    } else scrollContainerRef.current?.scrollTo({ top: 0, behavior: 'auto' });
  }

  /** "Follow" action for a navigation marker: where a singer goes when they hit
   *  it. D.S. → the Segno, To Coda → the Coda, D.C. → back to the start. Returns
   *  null for markers that are jump TARGETS rather than sources. */
  function markerFollow(m: MarkerAnnotation): { label: string; run: () => void } | null {
    if (m.markerKind === 'ds') {
      const segno = markersInOrder.find((x) => x.markerKind === 'segno');
      if (segno) return { label: 'Go to Segno', run: () => jumpToMarker(segno) };
    }
    if (m.markerKind === 'to-coda') {
      const coda = markersInOrder.find((x) => x.markerKind === 'coda');
      if (coda) return { label: 'Go to Coda', run: () => jumpToMarker(coda) };
    }
    if (m.markerKind === 'dc') {
      return { label: 'Back to start', run: jumpToTop };
    }
    const at = markersInOrder.findIndex((x) => x.id === m.id);
    if (m.markerKind === 'repeat-end') {
      // Back to the nearest start-repeat before this one; with none, a repeat
      // goes back to the beginning.
      const start = markersInOrder.slice(0, at).reverse().find((x) => x.markerKind === 'repeat-start');
      return start
        ? { label: 'Repeat from start-repeat', run: () => jumpToMarker(start) }
        : { label: 'Repeat from the beginning', run: jumpToTop };
    }
    if (m.markerKind === 'volta-1') {
      // Second time round you skip the 1st-time bar.
      const second = markersInOrder.slice(at + 1).find((x) => x.markerKind === 'volta-2');
      if (second) return { label: 'Skip to 2nd time', run: () => jumpToMarker(second) };
    }
    return null;
  }

  async function patchFile(id: number, patch: FilePatch): Promise<void> {
    const res = await fetch(`/api/files/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(patch),
    });
    if (res.ok) {
      refreshPiece();
      onPieceMutated?.();
    }
  }

  async function deleteFile(id: number): Promise<void> {
    const res = await fetch(`/api/files/${id}`, { method: 'DELETE', credentials: 'include' });
    if (res.ok) {
      refreshPiece();
      onPieceMutated?.();
    }
  }

  const myAnnotationCount = annotations.filter((a) => a.isMine !== false && belongsToActivePdf(a)).length;

  // ------- Toolbars -------------------------------------------------------

  const fullToolbar = (
    // On phones the toolbar stays a single horizontally-scrollable row so it
    // doesn't stack into several rows and eat the vertical space the score
    // needs. From md up it wraps as before. [&>*]:shrink-0 stops the groups
    // squashing in the scroll row.
    <div className="px-4 py-2 flex items-center gap-2 flex-nowrap overflow-x-auto [&>*]:shrink-0 md:flex-wrap md:overflow-visible">
      {piece && <h2 className="text-sm font-semibold mr-2">{piece.title}</h2>}
      {onEnterReadMode && (
        <Button size="sm" onClick={onEnterReadMode} title="Hide the editing tools and sing from the score">
          <Icon name="auto_stories" className="text-xl" />
          Read mode
        </Button>
      )}
      {pieceLoading && <span className="text-xs text-muted-foreground">Loading piece…</span>}
      {pieceError && <span className="text-xs text-destructive">Piece error: {pieceError}</span>}

      <PdfSwitcher files={pdfFiles} selectedId={pdfFile?.id ?? null} onSelect={setSelectedPdfId} />
      {piece && <DocumentsMenu files={piece.files} onView={setSelectedPdfId} />}

      {isAdmin && <UploadButton pieceId={pieceId} onUploaded={handleUploaded} />}
      {isAdmin && piece && (
        <FilesDropdown
          files={piece.files}
          open={filesOpen}
          onOpenChange={setFilesOpen}
          onPatch={patchFile}
          onDelete={deleteFile}
          onReplaced={handleUploaded}
        />
      )}
      {isAdmin && <div className="h-6 w-px bg-border mx-1" />}

      <div className="flex items-center rounded-md border border-border overflow-hidden">
        <ToolButton active={tool === 'pan'} onClick={() => setTool('pan')}>Pan</ToolButton>
        <ToolButton active={tool === 'pen'} onClick={() => setTool('pen')}>Pen</ToolButton>
        <ToolButton active={tool === 'highlighter'} onClick={() => setTool('highlighter')}>Highlight</ToolButton>
        <ToolButton active={tool === 'marker'} onClick={() => setTool('marker')}>Marker</ToolButton>
      </div>

      {inkTool && <InkColorPicker pen={activePen} color={activeInk.color} onChange={(c) => setInkColor(activePen, c)} />}

      <div
        className={cn(
          'flex items-center rounded-md border border-border overflow-hidden',
          tool === 'pan' && 'opacity-50',
        )}
      >
        <ToolButton active={drawTarget === 'private'} onClick={() => setDrawTarget('private')}>
          Private
        </ToolButton>
        <ToolButton active={drawTarget === 'shared'} onClick={() => setDrawTarget('shared')}>
          Shared
        </ToolButton>
      </div>

      {tool !== 'pan' && drawTarget === 'shared' && (
        <ShareWithPicker sections={sections} mySectionId={mySectionId} value={shareWithIds} onChange={setShareWith} />
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

      {myLineControl}

      <div className="h-6 w-px bg-border mx-1" />

      <ZoomControls zoom={zoom} onZoom={setZoom} />

      <div className="ml-auto flex items-center gap-2">
        <JumpToDropdown
          markers={markersInOrder}
          sectionsById={sectionsById}
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
    <div className="px-3 py-1.5 flex items-center gap-2 flex-nowrap overflow-x-auto [&>*]:shrink-0 md:flex-wrap md:overflow-visible">
      {piece && <h2 className="hidden md:block text-sm font-semibold mr-1 truncate max-w-[12rem]" title={piece.title}>{piece.title}</h2>}

      <PdfSwitcher files={pdfFiles} selectedId={pdfFile?.id ?? null} onSelect={setSelectedPdfId} />

      <div className="flex items-center rounded-md border border-border overflow-hidden">
        <ToolButton active={tool === 'pan'} onClick={() => setTool('pan')}>Look</ToolButton>
        <ToolButton active={tool === 'pen'} onClick={() => setTool('pen')}>Pen</ToolButton>
        <ToolButton active={tool === 'highlighter'} onClick={() => setTool('highlighter')}>Highlight</ToolButton>
      </div>

      {inkTool && <InkColorPicker pen={activePen} color={activeInk.color} onChange={(c) => setInkColor(activePen, c)} />}

      {inkTool && (
        <div className="flex items-center rounded-md border border-border overflow-hidden">
          <ToolButton active={drawTarget === 'private'} onClick={() => setDrawTarget('private')}>
            Private
          </ToolButton>
          <ToolButton active={drawTarget === 'shared'} onClick={() => setDrawTarget('shared')}>
            Shared
          </ToolButton>
        </div>
      )}

      {inkTool && drawTarget === 'shared' && (
        <ShareWithPicker sections={sections} mySectionId={mySectionId} value={shareWithIds} onChange={setShareWith} />
      )}

      {myLineControl}

      <div className="h-5 w-px bg-border mx-1" />

      {/* Scroll / Pages toggle */}
      <div className="flex items-center rounded-md border border-border overflow-hidden">
        <ToolButton active={navMode === 'scroll'} onClick={() => setNavMode('scroll')}>Scroll</ToolButton>
        <ToolButton active={navMode === 'page'} onClick={() => setNavMode('page')}>Pages</ToolButton>
      </div>

      {readMode && effectiveNavMode === 'page' && (
        <div className="flex items-center gap-1">
          <span className="text-sm text-muted-foreground">Show</span>
          <div className="flex items-center rounded-md border border-border overflow-hidden" role="group" aria-label="How much to show at once">
            {FIT_OPTIONS.map((o) => (
              <ToolButton key={o.value} active={fit === o.value} onClick={() => setFit(o.value)} title={o.title}>
                {o.label}
              </ToolButton>
            ))}
          </div>
        </div>
      )}

      {effectiveNavMode === 'page' && pageCount > 0 && (
        <>
          <Button size="sm" variant="outline" onClick={prevPage} disabled={!canPrev} aria-label="Previous">◀</Button>
          <span className="text-xs tabular-nums w-14 text-center">{currentPage} / {pageCount}</span>
          <Button size="sm" variant="outline" onClick={nextPage} disabled={!canNext} aria-label="Next">▶</Button>
        </>
      )}

      {effectiveNavMode === 'scroll' && <ZoomControls zoom={zoom} onZoom={setZoom} />}

      <div className="ml-auto flex items-center gap-2">
        {piece && onPlayerHiddenChange && (
          <ListenButton piece={piece} playerHidden={playerHidden} onPlayerHiddenChange={onPlayerHiddenChange} />
        )}
        <JumpToDropdown
          markers={markersInOrder}
          sectionsById={sectionsById}
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

  // Second toolbar row, shown only while the Marker tool is active — keeps the
  // crowded main row clear and gives the marker kinds room (incl. voltas) as
  // tappable icon buttons. Placing a marker drops back to the Look tool.
  const markerToolbar = (
    <div className="px-4 py-1.5 flex flex-wrap items-center gap-1 border-t border-border bg-muted/40">
      <span className="text-xs text-muted-foreground mr-1 self-center">Place:</span>
      {MARKER_KIND_ORDER.map((k) => (
        <button
          key={k}
          type="button"
          onClick={() => setMarkerKind(k)}
          title={MARKER_PICKER_LABEL[k]}
          className={cn(
            'inline-flex items-center justify-center gap-1 h-8 min-w-[2rem] px-2 rounded-md border text-xs font-medium',
            markerKind === k
              ? 'bg-primary text-primary-foreground border-primary'
              : 'border-border bg-background hover:bg-accent',
          )}
        >
          <MarkerGlyph kind={k} className="w-4 h-4" />
        </button>
      ))}
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
          className="text-xs h-8 px-2 rounded-md border border-border bg-background w-40 ml-1"
        />
      )}
      <span className="text-xs text-muted-foreground ml-auto self-center">Tap the score to place</span>
    </div>
  );

  // ------- Render --------------------------------------------------------

  return (
    <div className="flex flex-col h-full">
      <header className={cn('sticky top-0 z-10 bg-background/95 backdrop-blur border-b border-border', readMode && !toolsOpen && 'hidden md:block')}>
        {readMode ? minimalToolbar : fullToolbar}
        {!readMode && tool === 'marker' && markerToolbar}
        {annotationsError && (
          <div className="px-4 pb-2 text-xs text-destructive">Annotation sync issue: {annotationsError}</div>
        )}
      </header>

      <div
        ref={stageRef}
        className="flex-1 relative min-h-0"
        onTouchStart={onSwipeStart}
        onTouchMove={onSwipeMove}
        onTouchEnd={onSwipeEnd}
        onTouchCancel={() => { swipeRef.current = null; }}
      >
        {readMode && (
          // Phone read mode: the score fills the screen; two floating buttons
          // (tools, exit) sit over it so nothing is lost in a scrolling bar.
          <div className="md:hidden absolute top-2 right-2 z-20 flex items-center gap-1.5">
            {piece && onPlayerHiddenChange && (
              <ListenButton piece={piece} playerHidden={playerHidden} onPlayerHiddenChange={onPlayerHiddenChange} floating />
            )}
            <button
              type="button"
              onClick={() => setToolsOpen((o) => !o)}
              aria-label={toolsOpen ? 'Hide tools' : 'Show tools'}
              aria-pressed={toolsOpen}
              className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-background/90 text-foreground shadow-card backdrop-blur"
            >
              <Icon name="tune" className="text-xl" />
            </button>
            {onExitReadMode && (
              <button
                type="button"
                onClick={onExitReadMode}
                aria-label="Exit read mode"
                className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-primary text-primary-foreground shadow-card"
              >
                <Icon name="close" className="text-xl" />
              </button>
            )}
          </div>
        )}
        {readMode && effectiveNavMode === 'page' && pageCount > 0 && (
          <div className="md:hidden absolute bottom-2 left-1/2 -translate-x-1/2 z-20 px-2.5 h-7 rounded-full bg-background/90 text-xs tabular-nums shadow-card inline-flex items-center pointer-events-none">
            {currentPage} / {pageCount}
          </div>
        )}
        <div ref={scrollContainerRef} className="absolute inset-0 overflow-auto bg-stage">
          <div
            ref={contentRef}
            className={cn(
              'flex flex-col items-center gap-6',
              readMode
                ? effectiveNavMode === 'page'
                  ? 'p-2 justify-center min-h-full'
                  : 'py-2 px-1 gap-2 sm:px-4'
                : effectiveNavMode === 'page'
                  ? 'py-4 px-4 justify-center min-h-full'
                  : 'py-4 pl-10 pr-2 sm:py-6 sm:pl-12 sm:pr-6',
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
                partBands={lineBandsByPage.get(currentPage)}
                staveTargets={staveTargetsFor(currentPage)}
                onPickStave={(system, stave) => pickStave(currentPage, system, stave)}
                scale={effectiveScale}
                clip={chunk?.clip ?? null}
                bare={readMode}
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
                markerFollow={markerFollow}
              />
            )}

            {pdf && effectiveNavMode === 'scroll' &&
              Array.from({ length: pageCount }, (_, i) => i + 1).map((pageNumber) => (
                <PdfPage
                  key={pageNumber}
                  pdf={pdf}
                  pageNumber={pageNumber}
                  partBands={lineBandsByPage.get(pageNumber)}
                  staveTargets={staveTargetsFor(pageNumber)}
                  onPickStave={(system, stave) => pickStave(pageNumber, system, stave)}
                  scale={readMode ? readScrollScale(pageNumber) : effectiveScale}
                  clip={readMode ? layouts.get(pageNumber)?.content ?? null : null}
                  bare={readMode}
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
                  markerFollow={markerFollow}
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
              disabled={!canPrev}
              className="absolute left-0 top-0 bottom-0 w-16 z-10 disabled:opacity-30 disabled:cursor-not-allowed hover:bg-black/5 focus-visible:bg-black/10 transition-colors"
              style={{ cursor: canPrev ? 'w-resize' : 'not-allowed' }}
            />
            <button
              type="button"
              aria-label="Next page"
              onClick={nextPage}
              disabled={!canNext}
              className="absolute right-0 top-0 bottom-0 w-16 z-10 disabled:opacity-30 disabled:cursor-not-allowed hover:bg-black/5 focus-visible:bg-black/10 transition-colors"
              style={{ cursor: canNext ? 'e-resize' : 'not-allowed' }}
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
  title,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={cn(
        'px-3 py-1.5 text-xs font-medium transition-colors flex items-center',
        active ? 'bg-primary text-primary-foreground' : 'bg-background hover:bg-accent text-foreground',
      )}
    >
      {children}
    </button>
  );
}

/**
 * "My line" switch, with Adjust (tap staves to fix the guess) and Reset.
 * While adjusting, the button itself becomes Done so it's easy to find.
 */
function MyLineControl({
  on,
  onChange,
  partName,
  guessable,
  adjusting,
  onAdjustingChange,
  hasCorrections,
  onReset,
}: {
  on: boolean;
  onChange: (on: boolean) => void;
  partName: string | null;
  guessable: boolean;
  adjusting: boolean;
  onAdjustingChange: (adjusting: boolean) => void;
  hasCorrections: boolean;
  onReset: () => void;
}) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  if (adjusting) {
    return (
      <div className="flex items-center gap-2">
        <span className="hidden md:inline text-xs text-muted-foreground">Tap your stave in any system that's wrong</span>
        <Button size="sm" onClick={() => onAdjustingChange(false)}>Done adjusting</Button>
      </div>
    );
  }
  const row = 'w-full text-left px-3 py-2 text-sm rounded hover:bg-accent flex items-center gap-2 disabled:opacity-50';
  return (
    <div ref={anchorRef} className="relative">
      <div className="flex items-center rounded-md border border-border overflow-hidden">
        <ToolButton active={on} onClick={() => onChange(!on)} title="Highlight my part's stave">My line</ToolButton>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-label="My line options"
          aria-expanded={open}
          className="h-8 px-1.5 text-xs border-l border-border hover:bg-accent"
        >
          ▾
        </button>
      </div>
      {open && (
        <Popover anchorRef={anchorRef} onClose={() => setOpen(false)} className="p-1 min-w-[14rem]">
          <p className="px-3 pt-2 pb-1 text-xs text-muted-foreground max-w-[16rem]">
            {guessable
              ? `Guessed from the part names printed on the score (${partName}). Fix any system it gets wrong with Adjust.`
              : partName
                ? `Can't guess ${partName} from part names. Use Adjust to pick your stave; it carries on to later systems.`
                : 'Set your voice part in the menu so this can guess, or pick your stave with Adjust.'}
          </p>
          <button
            type="button"
            className={row}
            onClick={() => {
              if (!on) onChange(true);
              onAdjustingChange(true);
              setOpen(false);
            }}
          >
            Adjust…
          </button>
          <button
            type="button"
            className={row}
            disabled={!hasCorrections}
            onClick={() => {
              onReset();
              setOpen(false);
            }}
          >
            Reset my corrections
          </button>
        </Popover>
      )}
    </div>
  );
}

/**
 * Who new shared marks are for: everyone, or one or more voice parts. Part
 * marks are only shown to members of those parts (and whoever drew them), so
 * each section can mark up its own line without cluttering everyone else's.
 */
function ShareWithPicker({
  sections,
  mySectionId,
  value,
  onChange,
}: {
  sections: Section[];
  mySectionId: number | null;
  value: number[];
  onChange: (ids: number[]) => void;
}) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const chosen = sections.filter((s) => value.includes(s.id));
  const summary = chosen.length ? chosen.map((s) => s.badge).join(', ') : 'Everyone';
  const toggle = (id: number) => onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
  const row = 'w-full text-left px-3 py-2 text-sm rounded hover:bg-accent flex items-center gap-2';
  return (
    <div ref={anchorRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title="Who sees new shared marks"
        className="h-8 px-2 rounded-md border border-border bg-background hover:bg-accent flex items-center gap-1 text-xs"
      >
        <span className="text-muted-foreground">For</span>
        <span className="font-semibold">{summary}</span>
        <span>▾</span>
      </button>
      {open && (
        <Popover anchorRef={anchorRef} onClose={() => setOpen(false)} className="p-1 min-w-[12rem]">
          <button
            type="button"
            className={row}
            onClick={() => {
              onChange([]);
              setOpen(false);
            }}
          >
            <input type="radio" readOnly checked={value.length === 0} tabIndex={-1} />
            Everyone
          </button>
          <div className="h-px bg-border my-1" />
          {sections.map((s) => (
            <button key={s.id} type="button" className={row} onClick={() => toggle(s.id)}>
              <input type="checkbox" readOnly checked={value.includes(s.id)} tabIndex={-1} />
              {s.label}
              {s.id === mySectionId && <span className="ml-auto text-xs text-muted-foreground">you</span>}
            </button>
          ))}
          <p className="px-3 pt-1 pb-2 text-xs text-muted-foreground max-w-[14rem]">
            Part marks are only shown to members of those parts.
          </p>
        </Popover>
      )}
    </div>
  );
}

/** Colour swatch for the active pen; opens a row of colours to pick from. */
function InkColorPicker({ pen, color, onChange }: { pen: InkPen; color: string; onChange: (c: string) => void }) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <div ref={anchorRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={`${pen === 'highlighter' ? 'Highlighter' : 'Pen'} colour`}
        aria-expanded={open}
        className="h-8 px-2 rounded-md border border-border bg-background hover:bg-accent flex items-center gap-1"
      >
        <span className="w-5 h-5 rounded-full border border-black/20" style={{ background: color }} />
        <span className="text-xs">▾</span>
      </button>
      {open && (
        <Popover anchorRef={anchorRef} onClose={() => setOpen(false)} className="p-2 flex gap-2">
          {INK_COLORS[pen].map((c) => (
            <button
              key={c}
              type="button"
              aria-label={c}
              aria-pressed={c === color}
              onClick={() => {
                onChange(c);
                setOpen(false);
              }}
              className={cn(
                'w-9 h-9 rounded-full border border-black/20',
                c === color && 'ring-2 ring-offset-2 ring-primary ring-offset-background',
              )}
              style={{ background: c }}
            />
          ))}
        </Popover>
      )}
    </div>
  );
}

/** Switch between the PDFs attached to a piece (score / lyrics / extra parts).
 *  Renders nothing when there's only one PDF — no point in a one-option menu. */
function PdfSwitcher({
  files,
  selectedId,
  onSelect,
}: {
  files: PieceFile[];
  selectedId: number | null;
  onSelect: (id: number) => void;
}) {
  if (files.length < 2) return null;
  const current = files.find((f) => f.id === selectedId) ?? files[0]!;
  return (
    <label className="flex items-center gap-1 text-xs shrink-0">
      <span className="text-muted-foreground hidden sm:inline">PDF</span>
      <select
        value={current.id}
        onChange={(e) => onSelect(Number(e.target.value))}
        aria-label="Choose PDF"
        className="h-8 max-w-[11rem] rounded-md border border-border bg-background px-2 text-xs font-medium"
      >
        {files.map((f, i) => (
          <option key={f.id} value={f.id}>
            {f.label?.trim() || f.filename || `PDF ${i + 1}`}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Zoom relative to fit-to-width: 100% means the page fills the screen width. */
function ZoomControls({ zoom, onZoom }: { zoom: number; onZoom: (z: number) => void }) {
  const step = (d: number) => onZoom(Math.round(Math.min(3, Math.max(0.5, zoom + d)) * 10) / 10);
  return (
    <div className="flex items-center gap-1">
      <Button size="sm" variant="outline" onClick={() => step(-0.1)} aria-label="Zoom out">−</Button>
      <button
        type="button"
        className="text-xs tabular-nums w-12 text-center hover:underline"
        onClick={() => onZoom(1)}
        title="Reset to fit width"
      >
        {Math.round(zoom * 100)}%
      </button>
      <Button size="sm" variant="outline" onClick={() => step(0.1)} aria-label="Zoom in">+</Button>
    </div>
  );
}

interface JumpToDropdownProps {
  markers: MarkerAnnotation[];
  sectionsById: Map<number, Section>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onJump: (m: MarkerAnnotation) => void;
}

function JumpToDropdown({ markers, sectionsById, open, onOpenChange, onJump }: JumpToDropdownProps) {
  const anchorRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={anchorRef} className="relative">
      <Button
        size="sm"
        variant="outline"
        onClick={() => onOpenChange(!open)}
        disabled={markers.length === 0}
      >
        Jump to ▾ ({markers.length})
      </Button>
      {open && markers.length > 0 && (
        <Popover anchorRef={anchorRef} align="right" onClose={() => onOpenChange(false)} className="max-h-72 overflow-auto min-w-48">
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
              <span className={cn('ml-2 text-xs uppercase', m.layer === 'shared' ? 'text-amber-700' : 'text-blue-700')}>
                {m.layer === 'shared' && m.sectionIds?.length
                  ? m.sectionIds.map((id) => sectionsById.get(id)?.badge ?? '?').join(', ')
                  : m.layer}
              </span>
            </button>
          ))}
        </Popover>
      )}
    </div>
  );
}

// --- Documents menu (everyone): sheet music, lyrics and scores to open / download ---

const DOC_KINDS: FileKind[] = ['pdf', 'lyrics', 'score'];

/**
 * Read mode's player control. With something already loaded it shows or
 * hides the player bar; with nothing loaded it lists this piece's recordings
 * so one can be started without leaving the score.
 */
function ListenButton({ piece, playerHidden, onPlayerHiddenChange, floating = false }: {
  piece: Piece;
  playerHidden: boolean;
  onPlayerHiddenChange: (hidden: boolean) => void;
  floating?: boolean;
}) {
  const player = usePlayer();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const tracks = piece.files.filter((f) => f.kind === 'audio');
  const loaded = !!player.queue;
  if (!loaded && tracks.length === 0) return null;

  const showing = loaded && !playerHidden;
  const label = loaded ? (showing ? 'Hide player' : 'Show player') : 'Play a recording';
  const onClick = () => (loaded ? onPlayerHiddenChange(!playerHidden) : setOpen((o) => !o));
  return (
    <div ref={anchorRef} className="relative">
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        title={label}
        aria-pressed={loaded ? showing : undefined}
        aria-expanded={loaded ? undefined : open}
        className={floating
          ? cn('inline-flex items-center justify-center w-10 h-10 rounded-full shadow-card backdrop-blur', showing ? 'bg-primary text-primary-foreground' : 'bg-background/90 text-foreground')
          : cn('inline-flex items-center justify-center w-9 h-9 rounded-md border border-border', showing ? 'bg-primary text-primary-foreground border-primary' : 'bg-background text-foreground hover:bg-accent')}
      >
        <Icon name="headphones" className="text-xl" />
      </button>
      {open && !loaded && (
        <Popover anchorRef={anchorRef} align="right" onClose={() => setOpen(false)} className="min-w-56 max-h-72 overflow-auto p-1">
          {tracks.map((f, i) => (
            <button
              key={f.id}
              type="button"
              className="block w-full text-left px-3 py-2 text-sm rounded hover:bg-accent"
              onClick={() => {
                player.playQueue({ name: piece.title, tracks: tracks.map((t) => toQueueTrack(piece, t)) }, i);
                onPlayerHiddenChange(false);
                setOpen(false);
              }}
            >
              {f.label?.trim() || f.filename}
            </button>
          ))}
        </Popover>
      )}
    </div>
  );
}

function DocumentsMenu({ files, onView }: { files: PieceFile[]; onView: (id: number) => void }) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const docs = files.filter((f) => DOC_KINDS.includes(f.kind));
  if (docs.length === 0) return null;
  const groups = DOC_KINDS.map((k) => ({ kind: k, items: docs.filter((f) => f.kind === k) })).filter((g) => g.items.length > 0);
  return (
    <div ref={anchorRef} className="relative">
      <Button size="sm" variant="outline" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        Documents ({docs.length}) ▾
      </Button>
      {open && (
        <>
          <Popover anchorRef={anchorRef} onClose={() => setOpen(false)} className="w-80 max-h-96 overflow-auto p-1">
            {groups.map((g) => (
              <div key={g.kind} className="py-1">
                <div className="px-2 pb-1 text-xs uppercase tracking-wide text-muted-foreground">{FILE_KIND_LABEL[g.kind]}</div>
                {g.items.map((f) => {
                  const viewable = isPdfFile(f);
                  return (
                    <div key={f.id} className="flex items-center gap-2 px-2 py-1 rounded hover:bg-accent/40">
                      <div className="flex-1 min-w-0">
                        <div className="text-xs truncate" title={f.filename}>{f.label?.trim() || f.filename}</div>
                        <div className="text-xs text-muted-foreground truncate">
                          {f.label?.trim() ? f.filename : ''}
                          {f.createdByName ? `${f.label?.trim() ? ' · ' : ''}${f.createdByName}` : ''}
                        </div>
                      </div>
                      {viewable && (
                        <button
                          type="button"
                          onClick={() => { onView(f.id); setOpen(false); }}
                          className="text-xs px-1.5 py-0.5 rounded border border-border hover:bg-accent shrink-0"
                        >
                          View
                        </button>
                      )}
                      <a
                        href={f.url}
                        download={f.filename}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs px-1.5 py-0.5 rounded border border-border hover:bg-accent shrink-0"
                      >
                        Download
                      </a>
                    </div>
                  );
                })}
              </div>
            ))}
          </Popover>
        </>
      )}
    </div>
  );
}

// --- Files panel: rename labels, set voice part, delete, see who uploaded ---

type FilePatch = { label?: string | null; sectionId?: number | null; kind?: FileKind };

interface FilesDropdownProps {
  files: PieceFile[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPatch: (id: number, patch: FilePatch) => void;
  onDelete: (id: number) => void;
  /** Called after a file's bytes are replaced in place — refresh the piece. */
  onReplaced: () => void;
}

function FilesDropdown({ files, open, onOpenChange, onPatch, onDelete, onReplaced }: FilesDropdownProps) {
  const { sections } = useSections();
  const anchorRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={anchorRef} className="relative">
      <Button size="sm" variant="outline" onClick={() => onOpenChange(!open)} disabled={files.length === 0}>
        Files ({files.length}) ▾
      </Button>
      {open && files.length > 0 && (
        <Popover anchorRef={anchorRef} onClose={() => onOpenChange(false)} className="w-80 max-h-96 overflow-auto p-1">
          {(['pdf', 'lyrics', 'audio', 'score'] as FileKind[]).map((kind) => {
            const group = files.filter((f) => f.kind === kind);
            if (group.length === 0) return null;
            return (
              <div key={kind} className="py-1">
                <div className="px-1.5 pb-0.5 text-xs uppercase tracking-wide text-muted-foreground">{FILE_KIND_LABEL[kind]}</div>
                {group.map((f) => (
                  <FileRow key={f.id} file={f} sections={sections} onPatch={onPatch} onDelete={onDelete} onReplaced={onReplaced} />
                ))}
              </div>
            );
          })}
        </Popover>
      )}
    </div>
  );
}

/** Accept string for the replace picker, scoped to the file's kind so you can't
 *  swap a PDF for audio (which would orphan its annotations). */
const ACCEPT_BY_KIND: Record<FileKind, string> = {
  pdf: 'application/pdf,.pdf',
  audio: 'audio/*,.mp3,.m4a,.aac,.ogg,.wav,.flac',
  lyrics: 'application/pdf,.pdf,.docx,.doc,.rtf,.txt,.md,.odt',
  score: '.mscz,.mscx,.musicxml,.mxl',
};

function FileRow({
  file,
  sections,
  onPatch,
  onDelete,
  onReplaced,
}: {
  file: PieceFile;
  sections: Section[];
  onPatch: (id: number, patch: FilePatch) => void;
  onDelete: (id: number) => void;
  onReplaced: () => void;
}) {
  const [label, setLabel] = useState(file.label ?? '');
  const [confirming, setConfirming] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [replaceError, setReplaceError] = useState<string | null>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => setLabel(file.label ?? ''), [file.label]);

  function save(): void {
    const next = label.trim() || null;
    if (next !== (file.label ?? null)) onPatch(file.id, { label: next });
  }

  async function handleReplacePicked(picked: File | undefined): Promise<void> {
    if (replaceInputRef.current) replaceInputRef.current.value = '';
    if (!picked) return;
    setReplacing(true);
    setReplaceError(null);
    try {
      await replaceFile(file.id, picked, file.kind);
      onReplaced();
    } catch (e) {
      setReplaceError(e instanceof Error ? e.message : String(e));
    } finally {
      setReplacing(false);
    }
  }

  return (
    <div className="flex items-center gap-2 px-1.5 py-1.5 rounded hover:bg-accent/40">
      {/* A PDF can be re-filed between sheet music and lyrics; other kinds are fixed. */}
      {(file.kind === 'pdf' || file.kind === 'lyrics') && isPdfFile(file) ? (
        <select
          value={file.kind}
          onChange={(e) => onPatch(file.id, { kind: e.target.value as FileKind })}
          aria-label="Filed as"
          title="Sheet music or lyrics?"
          className="text-xs h-6 px-1 rounded border border-border bg-background shrink-0"
        >
          <option value="pdf">Sheet music</option>
          <option value="lyrics">Lyrics</option>
        </select>
      ) : (
        <KindBadge kind={file.kind} />
      )}
      <div className="flex-1 min-w-0">
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
          placeholder={file.kind === 'audio' ? 'Track name (e.g. Full mix, Tenor 1 emphasised)' : 'Label (optional)'}
          className="w-full text-xs h-7 px-1.5 rounded border border-transparent hover:border-border focus:border-border focus:outline-none bg-transparent"
        />
        {file.kind === 'audio' && (
          <select
            value={file.sectionId ?? ''}
            onChange={(e) => onPatch(file.id, { sectionId: e.target.value === '' ? null : Number(e.target.value) })}
            aria-label="Voice part for this track"
            title="Which part this track is for — used when playing a set list for a section"
            className="mt-0.5 ml-1 text-xs h-6 px-1 rounded border border-border bg-background"
          >
            {file.sectionId === null && <option value="" disabled>Choose a part</option>}
            {sections.map((sec) => (
              <option key={sec.id} value={sec.id}>{sec.label}</option>
            ))}
          </select>
        )}
        <div className="text-xs text-muted-foreground truncate px-1.5" title={file.filename}>
          {replacing ? 'Replacing…' : replaceError ? <span className="text-destructive">{replaceError}</span> : (
            <>
              {file.filename}
              {file.createdByName ? ` · ${file.createdByName}` : ''}
            </>
          )}
        </div>
      </div>

      <input
        ref={replaceInputRef}
        type="file"
        accept={ACCEPT_BY_KIND[file.kind]}
        className="hidden"
        onChange={(e) => void handleReplacePicked(e.target.files?.[0])}
      />
      <button
        type="button"
        title={`Replace this ${file.kind === 'audio' ? 'track' : 'file'} (keeps annotations)`}
        aria-label="Replace file"
        disabled={replacing}
        onClick={() => replaceInputRef.current?.click()}
        className="text-xs px-1.5 py-0.5 rounded border border-border text-muted-foreground hover:bg-accent shrink-0 disabled:opacity-50"
      >
        Replace
      </button>

      {confirming ? (
        <div className="flex items-center gap-1 shrink-0">
          <button type="button" onClick={() => onDelete(file.id)} className="text-xs px-1.5 py-0.5 rounded bg-destructive text-white">
            Delete
          </button>
          <button type="button" onClick={() => setConfirming(false)} className="text-xs px-1 text-muted-foreground">
            cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          aria-label="Delete file"
          onClick={() => setConfirming(true)}
          className="text-muted-foreground hover:text-destructive shrink-0"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <path d="M6 6 18 18M18 6 6 18" />
          </svg>
        </button>
      )}
    </div>
  );
}
