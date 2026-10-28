import { ReadModeControls } from '@/components/ReadModeControls.tsx';
/**
 * Flowing score viewer: the music engraved live (Verovio) from MusicXML to
 * fit the screen, rather than a fixed PDF page. Same reading controls as the
 * PDF viewer — read mode, Scroll / Pages, shade my part, Listen, Jump to, set
 * lists flowing on — plus what a live score can do: any size, any parts, and
 * playback that follows the markings with the reader's line brought forward.
 *
 * Marks (pen, highlighter, markers) aren't here yet: they need anchoring to
 * bars rather than page positions. The PDF stays a tap away in View.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { VerovioToolkit } from 'verovio/esm';
import { Button, Icon } from '@/components/ui/button.tsx';
import { Popover } from '@/components/ui/popover.tsx';
import { cn } from '@/lib/utils.ts';
import { usePiece } from '@/hooks/usePiece.ts';
import { useSections } from '@/hooks/useSections.ts';
import type { SetListFlow } from '@/hooks/useSetListFlow.ts';
import { ListenButton, ToolButton, useDropStaleRecording } from '@/components/PdfViewer/PdfViewer.tsx';
import { ViewSwitcher, type ViewTarget } from '@/components/ViewSwitcher.tsx';
import { createToolkit } from '@/lib/flowing/verovio.ts';
import { parseScore, tempoAt, type ScoreModel } from '@/lib/flowing/score.ts';
import { assignParts, voicesByStaff, type PartAssignment } from '@/lib/flowing/parts.ts';
import { BALANCE_MIN_WIDTH, MUSIC_TEXT_SCALE, engrave, engraveOriginal } from '@/lib/flowing/engrave.ts';
import { buildPlayNotes, FlowPlayer, Timeline, type MixMode, type PlayNote } from '@/lib/flowing/playback.ts';
import { SOUNDS, type SoundId } from '@/lib/flowing/sampler.ts';
import { usePlayer } from '@/player/PlayerContext.tsx';
import { FlowBar } from './FlowBar.tsx';

interface ScoreViewerProps {
  pieceId: number;
  /** The editable score this flowing view was made from. */
  fileId: number;
  refreshTick?: number;
  readMode?: boolean;
  onExitReadMode?: () => void;
  onEnterReadMode?: () => void;
  mySectionId?: number | null;
  selectedSectionId?: number | null;
  partLineOn?: boolean;
  onPartLineChange?: (on: boolean) => void;
  playerHidden?: boolean;
  onPlayerHiddenChange?: (hidden: boolean) => void;
  setListFlow?: SetListFlow | null;
  onOpenSong?: (pieceId: number) => void;
  /** Switch to a PDF or another flowing score. */
  onOpenView: (target: ViewTarget) => void;
  /** Score managers: convert this score again. */
  canManage?: boolean;
}

type NavMode = 'scroll' | 'page';

const NAV_MODE_KEY = 'choirfriend.navMode'; // shared with the PDF viewer
const SCALE_KEY = 'choirfriend.flowScale';
const LAYOUT_KEY = 'choirfriend.flowLayout';
const ZOOM_KEY = 'choirfriend.flowOriginalZoom';
const SOUND_KEY = 'choirfriend.flowSound';
const MIX_KEY = 'choirfriend.flowMix';
const PDF_HINT_KEY = 'choirfriend.flowPdfHintSeen';
const TOOLS_HIDE_MS = 4000;
const HIGHLIGHT = '#2563eb';

function load<T>(key: string, fallback: T, ok: (v: unknown) => boolean): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const v = JSON.parse(raw) as unknown;
    return ok(v) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, v: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* storage blocked */
  }
}

/** Verovio's SVG is our own engraving of an admin-uploaded file; strip
 *  anything active from it all the same. */
function sanitiseSvg(svg: string): string {
  return svg.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/\son[a-z]+="[^"]*"/gi, '');
}

export function ScoreViewer({
  pieceId,
  fileId,
  refreshTick = 0,
  readMode = false,
  onExitReadMode,
  onEnterReadMode,
  mySectionId = null,
  selectedSectionId = mySectionId,
  partLineOn = false,
  onPartLineChange,
  playerHidden = false,
  onPlayerHiddenChange,
  setListFlow = null,
  onOpenSong,
  onOpenView,
  canManage = false,
}: ScoreViewerProps) {
  const { piece, loading: pieceLoading, error: pieceError, refresh: refreshPiece } = usePiece(pieceId, refreshTick);
  useDropStaleRecording(pieceId);
  const { sections } = useSections();
  const flowing = piece?.flowing?.find((f) => f.fileId === fileId) ?? null;

  // A score still converting: look again every few seconds.
  useEffect(() => {
    if (flowing?.status !== 'pending') return;
    const id = setInterval(refreshPiece, 3000);
    return () => clearInterval(id);
  }, [flowing?.status, refreshPiece]);

  // ------- Load the MusicXML and the engraver ------------------------------

  const [model, setModel] = useState<ScoreModel | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const viewTkRef = useRef<VerovioToolkit | null>(null);
  const playTkRef = useRef<VerovioToolkit | null>(null);
  const url = flowing?.status === 'ready' ? flowing.url : null;
  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    setModel(null);
    setLoadError(null);
    Promise.all([
      fetch(url, { mode: 'cors', credentials: 'omit' }).then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`)))),
      createToolkit(),
      createToolkit(),
    ])
      .then(([xml, viewTk, playTk]) => {
        if (cancelled) return;
        viewTkRef.current = viewTk;
        playTkRef.current = playTk;
        setModel(parseScore(xml));
      })
      .catch((e: Error) => {
        if (!cancelled) setLoadError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  // ------- Reader settings --------------------------------------------------

  const [navMode, setNavModeState] = useState<NavMode>(() => {
    try {
      const v = localStorage.getItem(NAV_MODE_KEY);
      if (v === 'scroll' || v === 'page') return v;
    } catch {
      /* storage blocked */
    }
    return window.innerWidth < 768 ? 'scroll' : 'page';
  });
  const setNavMode = (m: NavMode) => {
    setNavModeState(m);
    try {
      localStorage.setItem(NAV_MODE_KEY, m);
    } catch {
      /* storage blocked */
    }
  };
  const effectiveNavMode: NavMode = readMode ? navMode : 'scroll';

  const [scale, setScaleState] = useState<number>(() =>
    load(SCALE_KEY, window.innerWidth < 600 ? 34 : 42, (v) => typeof v === 'number' && v >= 20 && v <= 90),
  );
  const setScale = (s: number) => {
    const v = Math.min(90, Math.max(20, Math.round(s)));
    setScaleState(v);
    save(SCALE_KEY, v);
  };

  // Flow fits the music to the screen; Original keeps MuseScore's lines and
  // pages, so "top of page 3" means the same thing on every device.
  const [layoutPref, setLayoutPref] = useState<'flow' | 'original'>(() =>
    load(LAYOUT_KEY, 'flow', (v) => v === 'flow' || v === 'original'),
  );
  const setLayout = (l: 'flow' | 'original') => {
    setLayoutPref(l);
    save(LAYOUT_KEY, l);
  };
  const canOriginal = !!model?.hasLayout && !!model.layoutWidth;
  const layout = canOriginal ? layoutPref : 'flow';
  const [zoom, setZoomState] = useState<number>(() => load(ZOOM_KEY, 1, (v) => typeof v === 'number' && v >= 1 && v <= 1.6));
  const [showPdfHint, setShowPdfHint] = useState(() => !load(PDF_HINT_KEY, false, (v) => v === true));
  const setZoom = (z: number) => {
    const v = Math.min(1.6, Math.max(1, Math.round(z * 10) / 10));
    setZoomState(v);
    save(ZOOM_KEY, v);
  };

  const hiddenKey = `choirfriend.flowHidden.${fileId}`;
  const [hidden, setHiddenState] = useState<string[]>(() => load(hiddenKey, [], Array.isArray));
  const setHidden = (ids: string[]) => {
    setHiddenState(ids);
    save(hiddenKey, ids);
  };

  const [sound, setSoundState] = useState<SoundId>(() =>
    load(SOUND_KEY, 'piano', (v) => SOUNDS.some((s) => s.id === v)),
  );
  const [mixMode, setMixModeState] = useState<MixMode>(() =>
    load(MIX_KEY, 'mine', (v) => v === 'balanced' || v === 'mine' || v === 'solo'),
  );
  // The player's "emphasise" picker is local to this score: it follows the
  // browsing section but changing it doesn't change the app-wide section.
  const [lineSectionId, setLineSectionId] = useState<number | null>(selectedSectionId);
  useEffect(() => setLineSectionId(selectedSectionId), [selectedSectionId]);

  const tempoKey = `choirfriend.flowTempo.${fileId}`;
  const [bpmOverride, setBpmOverride] = useState<number | null>(() =>
    load(tempoKey, null, (v) => typeof v === 'number' && v >= 20 && v <= 300),
  );
  const bpm = bpmOverride ?? Math.round(model?.markedTempo ?? 120);
  const setBpm = (v: number) => {
    const b = Math.min(300, Math.max(20, Math.round(v)));
    setBpmOverride(b);
    save(tempoKey, b);
  };

  // ------- Parts and the reader's line --------------------------------------

  const assignments = useMemo(() => (model ? assignParts(model, sections) : new Map<number, PartAssignment>()), [model, sections]);
  const voices = useMemo(() => (model ? voicesByStaff(model) : new Map<string, string[]>()), [model]);
  const myLine = selectedSectionId !== null ? assignments.get(selectedSectionId) ?? null : null;
  const hearLine = lineSectionId !== null ? assignments.get(lineSectionId) ?? null : null;
  const visibleParts = useMemo(() => model?.parts.filter((p) => !hidden.includes(p.id)) ?? [], [model, hidden]);

  // ------- Engraving ---------------------------------------------------------

  const scrollRef = useRef<HTMLDivElement>(null);
  const scoreRef = useRef<HTMLDivElement>(null);
  /** The title plus the music: what scrolls and what pages are cut from. */
  const sheetRef = useRef<HTMLDivElement>(null);

  // In read mode the toolbar floats over the music and is open when the
  // score first appears, so the sheet starts with a gap its height.
  const headerRef = useRef<HTMLElement>(null);
  const [headerH, setHeaderH] = useState(0);
  useLayoutEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const measure = () => {
      const h = el.offsetHeight;
      if (h > 0) setHeaderH((old) => (Math.abs(old - h) > 1 ? h : old));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [readMode]);
  const topGap = readMode ? headerH : 0;

  const [width, setWidth] = useState(0);
  const [viewportH, setViewportH] = useState(0);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let timer = 0;
    const measure = () => {
      const w = el.clientWidth;
      setWidth((old) => (Math.abs(old - w) > 24 || old === 0 ? w : old));
      setViewportH(el.clientHeight);
    };
    measure();
    const ro = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = window.setTimeout(measure, 150);
    });
    ro.observe(el);
    return () => {
      clearTimeout(timer);
      ro.disconnect();
    };
  }, []);

  const filteredXml = useMemo(() => {
    if (!model) return null;
    if (!hidden.length) return model.xml;
    const doc = new DOMParser().parseFromString(model.xml, 'application/xml');
    doc.querySelectorAll('part-list > part-group').forEach((g) => g.remove());
    doc.querySelectorAll('part-list > score-part').forEach((sp) => {
      if (hidden.includes(sp.getAttribute('id') ?? '')) sp.remove();
    });
    doc.querySelectorAll('score-partwise > part').forEach((p) => {
      if (hidden.includes(p.getAttribute('id') ?? '')) p.remove();
    });
    return new XMLSerializer().serializeToString(doc);
  }, [model, hidden]);

  const [svg, setSvg] = useState<string | null>(null);
  // One object per engraving: React re-writes innerHTML whenever this prop
  // object changes, which would wipe the shading and playback highlights.
  const svgHtml = useMemo(() => (svg ? { __html: svg } : undefined), [svg]);
  const [engraving, setEngraving] = useState(false);
  useEffect(() => {
    const tk = viewTkRef.current;
    if (!tk || !filteredXml || width === 0) return;
    setEngraving(true);
    // Let the spinner paint before the (synchronous) engraving starts.
    const id = requestAnimationFrame(() => {
      const pad = readMode ? 8 : 16;
      const w = width - pad;
      try {
        const out = layout === 'original' && model?.layoutWidth
          ? engraveOriginal(tk, filteredXml, { width: w, layoutWidth: model.layoutWidth, zoom })
          : engrave(tk, filteredXml, { width: w, scale, balance: w >= BALANCE_MIN_WIDTH });
        setSvg(sanitiseSvg(out));
      } catch (e) {
        setLoadError((e as Error).message);
      }
      setEngraving(false);
    });
    return () => cancelAnimationFrame(id);
    // model only supplies layoutWidth, which changes with filteredXml.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredXml, width, scale, readMode, layout, zoom]);

  // ------- After each engraving: shade my line, find lines and bars ----------

  const [systems, setSystems] = useState<Array<{ top: number; bottom: number }>>([]);
  /** Where each of MuseScore's pages starts, in sheet coordinates. */
  const [pageMarks, setPageMarks] = useState<Array<{ label: string; system: number; top: number; left: number }>>([]);
  const measureEls = useRef<SVGGElement[]>([]);
  useLayoutEffect(() => {
    const root = scoreRef.current;
    if (!root || !svg || !model) return;
    measureEls.current = Array.from(root.querySelectorAll<SVGGElement>('g.measure'));

    // Shade my line: a pale band behind my part's staves, bar by bar.
    if (partLineOn && myLine) {
      const part = model.parts[myLine.part];
      const visIndex = visibleParts.findIndex((p) => p.id === part?.id);
      if (part && visIndex >= 0) {
        const first = visibleParts.slice(0, visIndex).reduce((n, p) => n + p.staves, 0);
        for (const m of measureEls.current) {
          const staves = Array.from(m.children).filter((c) => c.classList.contains('staff')) as SVGGElement[];
          for (let s = first; s < first + part.staves; s++) {
            const staff = staves[s];
            if (!staff) continue;
            const lines = Array.from(staff.children).filter((c) => c.tagName.toLowerCase() === 'path') as SVGGraphicsElement[];
            if (!lines.length) continue;
            const boxes = lines.map((l) => l.getBBox());
            const x = Math.min(...boxes.map((b) => b.x));
            const y = Math.min(...boxes.map((b) => b.y));
            const right = Math.max(...boxes.map((b) => b.x + b.width));
            const bottom = Math.max(...boxes.map((b) => b.y + b.height));
            const gap = (bottom - y) / 4;
            const band = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
            band.setAttribute('x', String(x));
            band.setAttribute('y', String(y - gap * 1.5));
            band.setAttribute('width', String(right - x));
            band.setAttribute('height', String(bottom - y + gap * 3));
            band.setAttribute('class', 'cf-myline');
            staff.insertBefore(band, staff.firstChild);
          }
        }
      }
    }

    // Lines (systems) in sheet coordinates (title included), for page turns
    // and following.
    const sheetBox = (sheetRef.current ?? root).getBoundingClientRect();
    const base = sheetBox.top;
    const systemEls = Array.from(root.querySelectorAll('g.system'));
    setSystems(
      systemEls.map((s) => {
        const r = s.getBoundingClientRect();
        return { top: r.top - base, bottom: r.bottom - base };
      }),
    );
    setPageMarks(
      model.pages.slice(1).flatMap((pg) => {
        const m = measureEls.current[pg.measure];
        const sys = m?.closest('g.system');
        if (!m || !sys) return [];
        const s = sys.getBoundingClientRect();
        return [{ label: pg.label, system: systemEls.indexOf(sys), top: s.top - base, left: m.getBoundingClientRect().left - sheetBox.left }];
      }),
    );
  }, [svg, model, partLineOn, myLine, visibleParts, topGap]);

  // ------- Pages: screenfuls of whole lines --------------------------------

  const pages = useMemo(() => {
    if (effectiveNavMode !== 'page' || !systems.length || viewportH === 0) return [] as Array<{ top: number; bottom: number }>;
    const room = viewportH - 16;
    const out: Array<{ top: number; bottom: number }> = [];
    let cur: { top: number; bottom: number } | null = null;
    const pageStarts = new Set(layout === 'original' ? pageMarks.map((m) => m.system) : []);
    for (const [i, s] of systems.entries()) {
      // A small lead-in above each line catches dynamics and bar numbers
      // (and an original page's label); the first page starts at the top so
      // it carries the title.
      const lead = pageStarts.has(i) ? 36 : 12;
      const top: number = cur || out.length ? Math.max(0, s.top - lead) : 0;
      if (!cur || s.bottom - cur.top > room || pageStarts.has(i)) {
        if (cur) out.push(cur);
        cur = { top, bottom: s.bottom };
      } else cur.bottom = s.bottom;
    }
    if (cur) out.push(cur);
    return out;
  }, [effectiveNavMode, systems, viewportH, layout, pageMarks]);
  const [pageIndex, setPageIndex] = useState(0);
  useEffect(() => setPageIndex((i) => Math.min(i, Math.max(0, pages.length - 1))), [pages.length]);
  const page = pages[pageIndex] ?? null;
  // In the original layout, name screen pages after MuseScore's pages.
  const pageLabel = (() => {
    if (!page) return '';
    if (layout !== 'original' || !model?.pages.length) return `${pageIndex + 1} / ${pages.length}`;
    const at = (p: { top: number }) => [...pageMarks].reverse().find((m) => m.top <= p.top + 40)?.label ?? model.pages[0]!.label;
    const label = at(page);
    const prev = pages[pageIndex - 1];
    return `p. ${label}${prev && at(prev) === label ? ' cont.' : ''}`;
  })();
  const atEnd = effectiveNavMode === 'page' ? pageIndex >= pages.length - 1 : false;
  const nextSong = setListFlow?.next ?? null;
  const prevSong = setListFlow?.prev ?? null;
  const canPrev = pageIndex > 0;
  const canNext = !atEnd || (nextSong !== null && !!onOpenSong);
  const nextPage = useCallback(() => {
    if (pageIndex < pages.length - 1) setPageIndex(pageIndex + 1);
    else if (nextSong && onOpenSong) onOpenSong(nextSong.id);
  }, [pageIndex, pages.length, nextSong, onOpenSong]);
  const prevPage = useCallback(() => setPageIndex((i) => Math.max(0, i - 1)), []);

  /** Bring a line into view: its page, or scrolled to near the top. */
  const showY = useCallback(
    (y: number, smooth = true) => {
      if (effectiveNavMode === 'page') {
        const i = pages.findIndex((p) => y >= p.top - 1 && y < p.bottom);
        if (i >= 0) setPageIndex(i);
        return;
      }
      const sc = scrollRef.current;
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      sc?.scrollTo({ top: Math.max(0, y - 24), behavior: smooth && !reduce ? 'smooth' : 'auto' });
    },
    [effectiveNavMode, pages],
  );
  const systemOf = (el: Element | null): { top: number; bottom: number } | null => {
    const root = scoreRef.current;
    const sys = el?.closest('g.system');
    if (!root || !sys) return null;
    const i = Array.from(root.querySelectorAll('g.system')).indexOf(sys);
    return systems[i] ?? null;
  };

  // ------- Playback ----------------------------------------------------------

  const perf = useMemo(() => {
    const tk = playTkRef.current;
    if (!tk || !model) return null;
    tk.setOptions({ breaks: 'none' });
    tk.loadData(model.xml);
    return buildPlayNotes(tk, model);
  }, [model]);
  const timeline = useMemo(() => (perf && model ? new Timeline(perf.notes, perf.endQ, model, bpm) : null), [perf, model, bpm]);
  const mix = useMemo(() => ({ mode: mixMode, line: hearLine, voices }), [mixMode, hearLine, voices]);

  const playerRef = useRef<FlowPlayer | null>(null);
  const [playState, setPlayState] = useState<'stopped' | 'loading' | 'playing' | 'error'>('stopped');
  /** Where Play will start, as a step in played order (repeats unrolled). */
  const [fromStep, setFromStep] = useState<number | null>(null);
  const fromMeasure = fromStep !== null ? (perf?.bars[fromStep]?.measure ?? null) : null;
  /** A written bar's first time through, in played order. */
  const stepOf = (measure: number) => Math.max(0, perf?.bars.findIndex((b) => b.measure === measure) ?? 0);
  /** Bumped on every (re)start, so the highlighter re-reads where play is. */
  const [run, setRun] = useState(0);
  /** The step in played order sounding now, while playing. */
  const [nowStep, setNowStep] = useState<number | null>(null);
  const [loop, setLoop] = useState<{ start: number | null; end: number | null }>({ start: null, end: null });
  // Read mode is for reading: the player stays away until asked for.
  const [barOpen, setBarOpen] = useState(!readMode);
  useEffect(() => setBarOpen(!readMode), [readMode]);
  useEffect(() => () => playerRef.current?.dispose(), []);
  // Settings change the player in place for notes not yet scheduled.
  useEffect(() => {
    playerRef.current?.update({ mix, sound });
  }, [mix, sound]);

  const highlighted = useRef(new Set<Element>());
  const clearHighlight = () => {
    for (const el of highlighted.current) el.classList.remove('cf-playing');
    highlighted.current.clear();
  };

  const startAt = useCallback(
    async (q: number) => {
      if (!perf || !model || !timeline) return;
      clearHighlight();
      if (!playerRef.current) playerRef.current = new FlowPlayer({ model, notes: perf.notes, timeline, sound, mix });
      const p = playerRef.current;
      p.update({ model, notes: perf.notes, timeline, sound, mix });
      p.onEnded = () => {
        const l = loopRef.current;
        if (l) return void startAtRef.current?.(l.startQ);
        setPlayState('stopped');
        setNowStep(null);
        clearHighlight();
      };
      setPlayState('loading');
      try {
        if (await p.play(q)) {
          setPlayState('playing');
          setRun((r) => r + 1);
        }
      } catch {
        setPlayState('error');
      }
    },
    [perf, model, timeline, sound, mix],
  );
  const startAtRef = useRef(startAt);
  startAtRef.current = startAt;
  const stop = useCallback(() => {
    playerRef.current?.stop();
    setPlayState('stopped');
    setNowStep(null);
    clearHighlight();
  }, []);

  // A set loop, in score time: from the start of its first bar to the start
  // of the bar after its last (first time through, if there are repeats).
  const loopQ = useMemo(() => {
    if (!perf || loop.start === null || loop.end === null) return null;
    const startQ = perf.measureQ.get(loop.start);
    if (startQ === undefined) return null;
    const endQ = perf.measureQ.get(loop.end + 1) ?? perf.endQ;
    return endQ > startQ ? { startQ, endQ } : null;
  }, [perf, loop]);
  const loopRef = useRef(loopQ);
  loopRef.current = loopQ;

  // The recording player and this one share the bottom of the screen: only
  // one shows, and only one sounds.
  const recordings = usePlayer();
  const recordingShowing = !!recordings.queue && !playerHidden;
  useEffect(() => {
    if (recordingShowing || recordings.isPlaying) stop();
  }, [recordingShowing, recordings.isPlaying, stop]);

  // A new tempo or sound restarts from where playback had got to.
  const restartRef = useRef<{ bpm: number; sound: SoundId }>({ bpm, sound });
  useEffect(() => {
    const was = restartRef.current;
    restartRef.current = { bpm, sound };
    const p = playerRef.current;
    if (!p?.playing || (was.bpm === bpm && was.sound === sound)) return;
    const q = p.nowQ();
    void startAt(q);
  }, [bpm, sound, startAt]);

  // Light up what's sounding, and keep it in view.
  useEffect(() => {
    if (playState !== 'playing' || !perf) return;
    clearHighlight();
    const root = scoreRef.current;
    const notes: PlayNote[] = perf.notes;
    const els = new Map<string, Element | null>();
    const elOf = (id: string) => {
      if (!els.has(id)) els.set(id, root?.querySelector(`[id="${id}"]`) ?? null);
      return els.get(id)!;
    };
    let idx = notes.findIndex((n) => n.q >= (playerRef.current?.nowQ() ?? 0) - 1e-6);
    if (idx < 0) idx = notes.length;
    const active: PlayNote[] = [];
    const bars = perf.bars;
    let barIdx = -1;
    let lastSystem: Element | null = null;
    let lastBar: Element | null = null;
    let raf = 0;
    const frame = () => {
      const p = playerRef.current;
      if (!p?.playing) return;
      const q = p.nowQ();
      const l = loopRef.current;
      if (l && q >= l.endQ - 1e-6) {
        void startAtRef.current?.(l.startQ);
        return;
      }
      while (idx < notes.length && notes[idx]!.q <= q) {
        const n = notes[idx++]!;
        const el = elOf(n.baseId);
        if (n.qEnd > q && el) {
          el.classList.add('cf-playing');
          highlighted.current.add(el);
          active.push(n);
        }
      }
      for (let i = active.length - 1; i >= 0; i--) {
        const n = active[i]!;
        if (n.qEnd > q) continue;
        const el = elOf(n.baseId);
        el?.classList.remove('cf-playing');
        if (el) highlighted.current.delete(el);
        active.splice(i, 1);
      }
      // Follow the bar clock, not the notes, so the page still turns while
      // the reader's part (or everyone) is resting.
      while (barIdx + 1 < bars.length && bars[barIdx + 1]!.q <= q + 1e-6) barIdx++;
      const bar = barIdx >= 0 ? (measureEls.current[bars[barIdx]!.measure] ?? null) : null;
      if (bar && bar !== lastBar) {
        lastBar = bar;
        setNowStep(barIdx);
      }
      const sys = bar?.closest('g.system') ?? null;
      if (sys && sys !== lastSystem) {
        lastSystem = sys;
        const box = systemOf(bar);
        if (box) {
          const sc = scrollRef.current;
          if (effectiveNavMode === 'page') showY(box.top + 13, false);
          else if (sc && (box.top < sc.scrollTop + 8 || box.bottom > sc.scrollTop + sc.clientHeight - 24)) showY(box.top);
        }
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
    // systemOf reads systems through state; re-run when the layout changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playState, run, perf, effectiveNavMode, showY, systems]);

  const qOf = (step: number) => perf?.bars[step]?.q ?? 0;
  const play = (i: number | null) => {
    if (recordings.isPlaying) recordings.pause();
    if (recordings.queue && !playerHidden) onPlayerHiddenChange?.(true);
    void startAt(i !== null ? qOf(i) : loopQ?.startQ ?? 0);
  };
  // Pause is a stop that remembers the bar, so Play carries on from there.
  const togglePlay = () => {
    if (playState === 'playing' || playState === 'loading') {
      if (nowStep !== null) setFromStep(nowStep);
      return stop();
    }
    play(fromStep);
  };
  // The player's strip and bar buttons go through bars in played order, so
  // a repeat moves on rather than jumping back; loops use written bars.
  const currentStep = nowStep ?? fromStep ?? 0;
  const currentBar = perf?.bars[currentStep]?.measure ?? 0;
  const seekStep = (step: number) => {
    if (playState === 'playing') play(step);
    else setFromStep(step);
  };

  // ------- Read mode chrome ---------------------------------------------------

  const [toolsOpen, setToolsOpen] = useState(() => readMode);
  const [moreOpen, setMoreOpen] = useState(false);
  const [jumpOpen, setJumpOpen] = useState(false);
  const [partsOpen, setPartsOpen] = useState(false);
  const toolsTouchedRef = useRef(0);
  const touchTools = useCallback(() => {
    toolsTouchedRef.current = Date.now();
  }, []);
  const toolsBusy = moreOpen || jumpOpen || partsOpen;
  useEffect(() => {
    if (!readMode || !toolsOpen || toolsBusy) return;
    touchTools();
    const id = setInterval(() => {
      if (headerRef.current?.contains(document.activeElement) || document.querySelector('[data-popover]')) return touchTools();
      if (Date.now() - toolsTouchedRef.current > TOOLS_HIDE_MS) setToolsOpen(false);
    }, 500);
    return () => clearInterval(id);
  }, [readMode, toolsOpen, toolsBusy, touchTools]);

  // A quick tap on the music: while playing, play on from that bar; otherwise
  // choose that bar to play from (see below for read mode).
  const tapRef = useRef<{ x: number; y: number; t: number } | null>(null);
  function onPointerDown(e: React.PointerEvent): void {
    tapRef.current = e.isPrimary ? { x: e.clientX, y: e.clientY, t: Date.now() } : null;
  }
  function onPointerUp(e: React.PointerEvent): void {
    const s = tapRef.current;
    tapRef.current = null;
    if (!s || !e.isPrimary) return;
    if (Math.hypot(e.clientX - s.x, e.clientY - s.y) > 10 || Date.now() - s.t > 400) return;
    const target = e.target as Element;
    if (target.closest('button, a, input, select, textarea, [role="button"]')) return;
    const m = target.closest('g.measure');
    const i = m ? measureEls.current.indexOf(m as SVGGElement) : -1;
    if (i >= 0 && playState === 'playing') {
      const q = perf?.measureQ.get(i);
      if (q !== undefined) void startAt(q);
      return;
    }
    // In read mode a tap first brings the tools back; with them showing, a
    // tap on a bar picks where Play starts (again to clear), off a bar hides them.
    if (readMode && !toolsOpen) return setToolsOpen(true);
    if (i >= 0) {
      setFromStep(fromMeasure === i ? null : stepOf(i));
      touchTools();
    } else if (readMode) setToolsOpen(false);
  }
  // Mark the chosen start bar.
  useLayoutEffect(() => {
    measureEls.current.forEach((m, i) => m.classList.toggle('cf-from', i === fromMeasure));
  }, [fromMeasure, svg]);

  // Swipes and keys turn pages; Esc leaves read mode.
  const swipeRef = useRef<{ x: number; y: number; t: number } | null>(null);
  function onTouchStart(e: React.TouchEvent): void {
    swipeRef.current = e.touches.length === 1 ? { x: e.touches[0]!.clientX, y: e.touches[0]!.clientY, t: Date.now() } : null;
  }
  function onTouchEnd(e: React.TouchEvent): void {
    const s = swipeRef.current;
    swipeRef.current = null;
    if (!s || effectiveNavMode !== 'page' || (window.visualViewport?.scale ?? 1) > 1.05) return;
    const t = e.changedTouches[0];
    if (!t || Date.now() - s.t > 800) return;
    const dx = t.clientX - s.x;
    const dy = t.clientY - s.y;
    const MIN = 50;
    if (Math.abs(dx) > MIN && Math.abs(dx) > 1.5 * Math.abs(dy)) (dx < 0 ? nextPage : prevPage)();
    else if (Math.abs(dy) > MIN && Math.abs(dy) > 1.5 * Math.abs(dx)) (dy < 0 ? nextPage : prevPage)();
  }
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      if (e.key === 'Escape' && readMode && onExitReadMode) {
        onExitReadMode();
        e.preventDefault();
        return;
      }
      if (effectiveNavMode !== 'page') return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
        nextPage();
        e.preventDefault();
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        prevPage();
        e.preventDefault();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [effectiveNavMode, nextPage, prevPage, readMode, onExitReadMode]);

  // Keep the screen awake while reading, as a music stand would.
  useEffect(() => {
    if (!readMode || !('wakeLock' in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    let cancelled = false;
    const take = (): void => {
      if (document.visibilityState !== 'visible') return;
      navigator.wakeLock
        .request('screen')
        .then((l) => {
          if (cancelled) void l.release();
          else lock = l;
        })
        .catch(() => {
          /* refused (low battery, unsupported): the screen just dims */
        });
    };
    take();
    document.addEventListener('visibilitychange', take);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', take);
      void lock?.release();
    };
  }, [readMode]);

  // The page itself mustn't scroll or bounce while a score is open (iOS).
  useEffect(() => {
    const html = document.documentElement;
    const prev = [html.style.overflow, html.style.overscrollBehavior, document.body.style.overflow];
    html.style.overflow = 'hidden';
    html.style.overscrollBehavior = 'none';
    document.body.style.overflow = 'hidden';
    return () => {
      [html.style.overflow, html.style.overscrollBehavior, document.body.style.overflow] = prev as [string, string, string];
    };
  }, []);

  function jumpToMeasure(i: number): void {
    const box = systemOf(measureEls.current[i] ?? null);
    if (box) showY(box.top + 13);
    setFromStep(stepOf(i));
    setJumpOpen(false);
  }

  // ------- Toolbar pieces -----------------------------------------------------

  const extra = cn('contents', !moreOpen && 'max-md:hidden');
  const current: ViewTarget = { kind: 'flow', id: fileId };
  const barLabels = useMemo(() => model?.measures.map((m, i) => m.number || String(i + 1)) ?? [], [model]);
  const stepLabels = useMemo(() => perf?.bars.map((b) => barLabels[b.measure] ?? String(b.measure + 1)) ?? [], [perf, barLabels]);

  // In the original layout bigger music means squeezing each line, as far
  // as it will sensibly go; the bars on each line stay the same.
  const smaller = () => (layout === 'original' ? setZoom(zoom - 0.1) : setScale(scale - 4));
  const larger = () => (layout === 'original' ? setZoom(zoom + 0.1) : setScale(scale + 4));
  const sizeControl = (
    <div className="flex items-center gap-1">
      <Button size="sm" variant="outline" onClick={smaller} disabled={layout === 'original' && zoom <= 1} aria-label="Smaller music">
        <span className="text-[11px]">A</span>
      </Button>
      <Button size="sm" variant="outline" onClick={larger} disabled={layout === 'original' && zoom >= 1.6} aria-label="Larger music">
        <span className="text-base leading-none">A</span>
      </Button>
    </div>
  );

  const myLineToggle = myLine && onPartLineChange && (
    <ToolButtonWrap>
      <ToolButton active={partLineOn} onClick={() => onPartLineChange(!partLineOn)} title="Shade your own part's stave in pale blue">
        Shade my part
      </ToolButton>
    </ToolButtonWrap>
  );

  const partsAnchor = useRef<HTMLDivElement>(null);
  const partsMenu = model && model.parts.length > 1 && (
    <div ref={partsAnchor} className="relative">
      <Button size="sm" variant="outline" onClick={() => setPartsOpen((o) => !o)} aria-expanded={partsOpen}>
        Parts ▾
      </Button>
      {partsOpen && (
        <Popover anchorRef={partsAnchor} onClose={() => setPartsOpen(false)} className="min-w-48 p-2">
          <p className="px-1 pb-1 text-xs text-muted-foreground">Show on screen (all parts still play)</p>
          {model.parts.map((p) => {
            const on = !hidden.includes(p.id);
            return (
              <label key={p.id} className="flex items-center gap-2 px-1 py-1 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={on}
                  disabled={on && visibleParts.length === 1}
                  onChange={() => setHidden(on ? [...hidden, p.id] : hidden.filter((h) => h !== p.id))}
                />
                {p.name || p.id}
              </label>
            );
          })}
        </Popover>
      )}
    </div>
  );

  const jumpAnchor = useRef<HTMLDivElement>(null);
  const [barInput, setBarInput] = useState('');
  const jumpMenu = model && (
    <div ref={jumpAnchor} className="relative">
      <Button size="sm" variant="outline" onClick={() => setJumpOpen((o) => !o)} aria-expanded={jumpOpen}>
        Jump to ▾
      </Button>
      {jumpOpen && (
        <Popover anchorRef={jumpAnchor} align="right" onClose={() => setJumpOpen(false)} className="min-w-52 max-h-80 overflow-auto p-2">
          <form
            className="flex items-center gap-2 px-1 pb-2"
            onSubmit={(e) => {
              e.preventDefault();
              const i = model.measures.findIndex((m) => m.number === barInput.trim());
              if (i >= 0) jumpToMeasure(i);
            }}
          >
            <label className="text-xs text-muted-foreground" htmlFor="cf-bar">Bar</label>
            <input
              id="cf-bar"
              inputMode="numeric"
              value={barInput}
              onChange={(e) => setBarInput(e.target.value)}
              className="h-8 w-16 rounded-md border border-border bg-background px-2 text-sm"
            />
            <Button size="sm" type="submit">Go</Button>
          </form>
          <button type="button" className="block w-full text-left px-3 py-1.5 text-xs hover:bg-accent rounded" onClick={() => jumpToMeasure(0)}>
            Start
          </button>
          {model.pages.length > 1 && (
            <div className="flex flex-wrap items-center gap-1 px-1 py-1.5">
              <span className="text-xs text-muted-foreground mr-1">Page</span>
              {model.pages.map((pg) => (
                <button
                  key={pg.label}
                  type="button"
                  className="h-8 min-w-8 px-2 rounded border border-border text-xs tabular-nums hover:bg-accent"
                  onClick={() => jumpToMeasure(pg.measure)}
                  title={`Top of page ${pg.label} (bar ${model.measures[pg.measure]?.number ?? pg.measure + 1})`}
                >
                  {pg.label}
                </button>
              ))}
            </div>
          )}
          {model.rehearsals.map((r) => (
            <button
              key={`${r.label}-${r.measure}`}
              type="button"
              className="block w-full text-left px-3 py-1.5 text-xs hover:bg-accent rounded"
              onClick={() => jumpToMeasure(r.measure)}
            >
              <span className="font-semibold">{r.label}</span>
              <span className="ml-2 text-muted-foreground">bar {model.measures[r.measure]?.number}</span>
            </button>
          ))}
        </Popover>
      )}
    </div>
  );

  const pageNav = effectiveNavMode === 'page' && pages.length > 0 && (
    <div className="flex items-center gap-1">
      <Button size="sm" variant="outline" onClick={prevPage} disabled={!canPrev} aria-label="Previous">◀</Button>
      <span className="hidden md:inline text-xs tabular-nums min-w-14 text-center">{pageLabel}</span>
      <Button size="sm" variant="outline" onClick={nextPage} disabled={!canNext} aria-label="Next">▶</Button>
    </div>
  );

  const moreButton = (
    <button
      type="button"
      onClick={() => setMoreOpen((o) => !o)}
      aria-expanded={moreOpen}
      className="md:hidden inline-flex items-center gap-1 h-9 px-3 rounded-md border border-border bg-background text-xs font-medium"
    >
      <Icon name={moreOpen ? 'expand_less' : 'more_horiz'} className="text-lg" />
      {moreOpen ? 'Less' : 'More'}
    </button>
  );

  const viewSwitcher = piece && <ViewSwitcher piece={piece} current={current} onSelect={onOpenView} />;

  const playerButton = !barOpen && (
    <Button size="sm" variant="outline" onClick={() => setBarOpen(true)} title="Play the score">
      <Icon name="play_arrow" className="text-xl" />
      Play
    </Button>
  );

  const readingControls = (
    <>
      {myLineToggle}
      <div className="hidden md:block h-5 w-px bg-border mx-1" />
      {readMode && (
        <div className="flex items-center rounded-md border border-border overflow-hidden">
          <ToolButton active={navMode === 'scroll'} onClick={() => setNavMode('scroll')}>Scroll</ToolButton>
          <ToolButton active={navMode === 'page'} onClick={() => setNavMode('page')}>Pages</ToolButton>
        </div>
      )}
      {canOriginal && (
        <div className="flex items-center rounded-md border border-border overflow-hidden" title="Flow fits the music to your screen; Original keeps the score’s own lines and pages">
          <ToolButton active={layout === 'flow'} onClick={() => setLayout('flow')}>Flow</ToolButton>
          <ToolButton active={layout === 'original'} onClick={() => setLayout('original')}>Original</ToolButton>
        </div>
      )}
      {sizeControl}
      {partsMenu}
    </>
  );

  const fullToolbar = (
    <div className="px-3 py-2 md:px-4 flex flex-wrap items-center gap-2">
      {piece && <h2 className="hidden md:block text-sm font-semibold mr-2">{piece.title}</h2>}
      {onEnterReadMode && (
        <Button size="sm" variant="outline" onClick={onEnterReadMode} title="Hide the other tools and sing from the score">
          <Icon name="auto_stories" className="text-xl" />
          Read mode
        </Button>
      )}
      {viewSwitcher}
      {jumpMenu}
      {moreButton}
      <div className={extra}>{readingControls}</div>
      <div className="ml-auto flex items-center gap-2">
        {playerButton}
        {piece && onPlayerHiddenChange && (
          <ListenButton piece={piece} playerHidden={playerHidden} onPlayerHiddenChange={onPlayerHiddenChange} />
        )}
      </div>
    </div>
  );

  const minimalToolbar = (
    <div className="px-3 py-1.5 flex flex-wrap items-center gap-2">
      {piece && <h2 className="hidden md:block text-sm font-semibold mr-1 truncate max-w-[12rem]" title={piece.title}>{piece.title}</h2>}
      {viewSwitcher}
      {pageNav}
      {moreButton}
      <div className={extra}>{readingControls}</div>
      <div className="flex ml-auto items-center gap-2">
        {playerButton}
        {piece && onPlayerHiddenChange && (
          <ListenButton piece={piece} playerHidden={playerHidden} onPlayerHiddenChange={onPlayerHiddenChange} />
        )}
        {jumpMenu}
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

  // ------- Render ---------------------------------------------------------------

  const status = (() => {
    if (pieceLoading && !piece) return <p className="text-sm text-muted-foreground">Loading piece…</p>;
    if (pieceError) return <p className="text-sm text-destructive">Couldn’t load the piece: {pieceError}</p>;
    if (!flowing) return <p className="text-sm text-muted-foreground">This flowing score isn’t available.</p>;
    if (flowing.status === 'pending') return <Spinner text="Preparing the flowing score… this takes a few seconds" />;
    if (flowing.status === 'failed') {
      return (
        <div className="max-w-md text-center flex flex-col gap-3 items-center">
          <p className="text-sm text-destructive">The flowing score couldn’t be made from this file.</p>
          {flowing.error && <p className="text-xs text-muted-foreground">{flowing.error}</p>}
          {canManage && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void fetch(`/api/files/${fileId}/render`, { method: 'POST', credentials: 'include' }).then(refreshPiece)}
            >
              Try again
            </Button>
          )}
        </div>
      );
    }
    if (loadError) return <p className="text-sm text-destructive">The score didn’t load: {loadError}</p>;
    if (!svg) return <Spinner text="Engraving the score…" />;
    return null;
  })();

  return (
    <div className="relative flex flex-col h-full">
      <style>{`
        .cf-score svg { display: block; margin: 0 auto; max-width: 100%; height: auto; }
        /* Verovio spaces text with Times metrics; Tinos has the same widths. */
        .cf-score svg text { font-family: Tinos, "Times New Roman", Times, serif; }
        /* Music characters in text (see musicText in engrave.ts). */
        @font-face { font-family: Leland; src: url(/fonts/Leland.woff2) format("woff2"); font-display: swap; }
        /* Leland lacks a few (the ♯ Verovio uses in chord symbols): Bravura, cut down to the text-symbol ranges, fills in. */
        @font-face { font-family: "Bravura Text"; src: url(/fonts/BravuraText-subset.woff2) format("woff2"); font-display: swap; }
        .cf-score svg [font-family="Leipzig"], .cf-score svg .cf-smufl { font-family: Leland, "Bravura Text"; }
        .cf-score svg .cf-smufl { font-size: ${Math.round(MUSIC_TEXT_SCALE * 100)}%; }
        .cf-score .cf-myline { fill: rgb(59 130 246 / 0.13); }
        .cf-score g.cf-playing, .cf-score g.cf-playing * { fill: ${HIGHLIGHT}; stroke: ${HIGHLIGHT}; }
        .cf-score g.cf-from > g.staff > path { stroke: ${HIGHLIGHT}; }
        .cf-score g.measure { cursor: pointer; }
        .cf-original > svg + svg { margin-top: 40px; }
      `}</style>
      {readMode && <ReadModeControls toolsOpen={toolsOpen} onExit={onExitReadMode} onShow={() => {
        setToolsOpen(true);
        requestAnimationFrame(() => headerRef.current?.querySelector<HTMLElement>('button, select, input')?.focus());
      }} />}
      <header
        ref={headerRef}
        onPointerDown={touchTools}
        onKeyDown={touchTools}
        className={cn(
          'top-0 bg-background/95 backdrop-blur border-b border-border',
          readMode ? 'absolute inset-x-0 z-30 shadow-card' : 'sticky z-10',
          readMode && !toolsOpen && 'hidden',
        )}
      >
        {readMode ? minimalToolbar : fullToolbar}
        {!readMode && showPdfHint && (
          <div className="px-3 pb-2 text-xs text-muted-foreground flex flex-wrap items-center gap-2">
            <span>Highlighting, pen marks and navigation markers are available on PDFs only{piece?.files.some((f) => f.kind === 'pdf') ? ' — switch with View.' : '. No PDF is attached to this song.'}</span>
            {piece?.files.some((f) => f.kind === 'pdf') && (
              <Button size="sm" variant="outline" onClick={() => onOpenView({ kind: 'pdf', id: piece.files.find((f) => f.kind === 'pdf')!.id })}>Annotate the PDF</Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => { setShowPdfHint(false); save(PDF_HINT_KEY, true); }}>Got it</Button>
          </div>
        )}
      </header>

      <div
        className="flex-1 relative min-h-0"
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        onTouchCancel={() => { swipeRef.current = null; }}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={() => { tapRef.current = null; }}
      >
        {readMode && effectiveNavMode === 'page' && pages.length > 0 && (
          <div className="absolute bottom-2 left-1/2 -translate-x-1/2 z-20 px-2.5 h-7 rounded-full bg-background/90 text-xs tabular-nums shadow-card inline-flex items-center pointer-events-none">
            {pageLabel}
          </div>
        )}
        <div
          ref={scrollRef}
          className={cn('absolute inset-0 overscroll-contain bg-stage', effectiveNavMode === 'page' ? 'overflow-hidden' : 'overflow-auto')}
        >
          {status && <div className="flex justify-center py-16 px-4">{status}</div>}
          {engraving && svg && (
            <div className="absolute top-2 right-2 z-10"><Spinner small text="" /></div>
          )}
          <div
            className={cn('bg-white mx-auto', readMode ? 'px-1' : 'px-2 my-2 shadow-card rounded-sm max-w-full', !svg && 'hidden')}
            style={
              effectiveNavMode === 'page' && page
                ? { height: page.bottom - page.top + 8, overflow: 'hidden', marginTop: 8 }
                : undefined
            }
          >
            <div
              ref={sheetRef}
              className="relative"
              style={effectiveNavMode === 'page' && page ? { transform: `translateY(${-page.top}px)` } : undefined}
            >
              <ScoreTitle
                title={piece?.title || model?.credits.title || null}
                composer={piece?.composer || model?.credits.composer || null}
                arranger={piece?.arranger || model?.credits.arranger || null}
                lyricist={model?.credits.lyricist ?? null}
                gap={topGap}
              />
              <div ref={scoreRef} className={cn('cf-score', layout === 'original' && 'cf-original')} dangerouslySetInnerHTML={svgHtml} />
              {svg && pageMarks.map((m) =>
                layout === 'original' ? (
                  <div key={m.label} className="absolute inset-x-0 pointer-events-none" style={{ top: m.top - 34 }}>
                    <div className="border-t border-dashed border-border" />
                    <span className="absolute left-2 top-1 text-xs font-semibold text-muted-foreground">Page {m.label}</span>
                  </div>
                ) : (
                  <span
                    key={m.label}
                    className="absolute pointer-events-none rounded bg-accent text-accent-foreground px-1 text-[10px] font-semibold leading-4"
                    style={{ top: Math.max(0, m.top - 18), left: Math.max(0, m.left) }}
                    title={`Page ${m.label} of the original starts here`}
                  >
                    p.{m.label}
                  </span>
                ),
              )}
            </div>
          </div>

          {svg && effectiveNavMode === 'scroll' && setListFlow && onOpenSong && (
            <div className="w-full max-w-md mx-auto my-6 px-4 flex flex-col gap-2 text-center">
              <p className="text-sm text-muted-foreground">
                {setListFlow.name} · song {setListFlow.position} of {setListFlow.total}
              </p>
              {nextSong ? (
                <Button size="lg" onClick={() => onOpenSong(nextSong.id)} className="h-14 text-base">
                  Next: {nextSong.title} <Icon name="arrow_forward" />
                </Button>
              ) : (
                <p className="text-base font-medium">End of the set list</p>
              )}
              {prevSong && (
                <Button size="sm" variant="ghost" onClick={() => onOpenSong(prevSong.id)}>
                  <Icon name="arrow_back" /> Previous: {prevSong.title}
                </Button>
              )}
            </div>
          )}
        </div>

        {effectiveNavMode === 'page' && pages.length > 0 && setListFlow && onOpenSong && (
          <>
            {atEnd && nextSong && (
              <button
                type="button"
                onClick={() => onOpenSong(nextSong.id)}
                className="absolute right-3 bottom-3 z-20 max-w-[70%] truncate rounded-full bg-primary text-primary-foreground px-4 py-2 text-sm font-medium shadow-md"
              >
                Next: {nextSong.title} ›
              </button>
            )}
            {atEnd && !nextSong && (
              <span className="absolute right-3 bottom-3 z-20 rounded-full bg-card border px-4 py-2 text-sm text-muted-foreground shadow-sm">
                End of the set list
              </span>
            )}
            {!canPrev && prevSong && (
              <button
                type="button"
                onClick={() => onOpenSong(prevSong.id)}
                className="absolute left-3 bottom-3 z-20 max-w-[45%] truncate rounded-full bg-card border px-3 py-2 text-sm text-muted-foreground shadow-sm"
              >
                ‹ {prevSong.title}
              </button>
            )}
          </>
        )}

        {effectiveNavMode === 'page' && pages.length > 1 && (
          <>
            <button
              type="button"
              aria-label="Previous page"
              onClick={prevPage}
              disabled={!canPrev}
              className="absolute left-0 top-0 bottom-0 w-16 z-10 disabled:opacity-30 disabled:cursor-not-allowed hover:bg-black/5 focus-visible:bg-black/10 transition-colors"
            />
            <button
              type="button"
              aria-label="Next page"
              onClick={nextPage}
              disabled={!canNext}
              className="absolute right-0 top-0 bottom-0 w-16 z-10 disabled:opacity-30 disabled:cursor-not-allowed hover:bg-black/5 focus-visible:bg-black/10 transition-colors"
            />
          </>
        )}
      </div>

      {!recordingShowing && model && barOpen && (
        <FlowBar
          title={piece?.title || model.credits.title || 'Score'}
          playState={playState}
          canPlay={!!perf}
          onToggle={togglePlay}
          bars={stepLabels}
          writtenBars={barLabels}
          bar={currentStep}
          onSeek={seekStep}
          bpm={bpm}
          markedBpm={model.markedTempo ?? 120}
          hasMarkedTempo={model.markedTempo != null}
          laterTempo={model.markedTempo === null ? model.tempo.find((t) => t.kind === 'set')?.bpm ?? null : null}
          currentBpm={Math.round(tempoAt(model, model.measures[currentBar]?.pos ?? 0, model.markedTempo ?? 120) * bpm / (model.markedTempo ?? 120))}
          onBpm={setBpm}
          onResetBpm={() => { setBpmOverride(null); save(tempoKey, null); }}
          loop={loop}
          onLoopStart={() => setLoop((l) => ({ start: currentBar, end: l.end !== null && l.end >= currentBar ? l.end : null }))}
          onLoopEnd={() => setLoop((l) => ({ start: l.start !== null && l.start <= currentBar ? l.start : 0, end: currentBar }))}
          onClearLoop={() => setLoop({ start: null, end: null })}
          lineChoices={sections.filter((s) => assignments.has(s.id)).map((s) => ({ id: s.id, label: s.label, mine: s.id === mySectionId }))}
          lineSectionId={lineSectionId}
          onLine={setLineSectionId}
          lineLabel={lineSectionId !== null && hearLine ? sections.find((s) => s.id === lineSectionId)?.label ?? null : null}
          mixMode={mixMode}
          onMixMode={(m) => { setMixModeState(m); save(MIX_KEY, m); }}
          sound={sound}
          onSound={(id) => { setSoundState(id); save(SOUND_KEY, id); }}
          listen={piece && onPlayerHiddenChange && (
            <ListenButton piece={piece} playerHidden={playerHidden} onPlayerHiddenChange={onPlayerHiddenChange} />
          )}
          onClose={() => {
            stop();
            setBarOpen(false);
          }}
        />
      )}
    </div>
  );
}

/** The heading on the first page: title, then who wrote and arranged it. */
function ScoreTitle({
  title,
  composer,
  arranger,
  lyricist,
  gap,
}: {
  title: string | null;
  composer: string | null;
  arranger: string | null;
  lyricist: string | null;
  gap: number;
}) {
  const by = [composer, arranger && `arr. ${arranger}`, lyricist && lyricist !== arranger && `words ${lyricist}`].filter(Boolean);
  return (
    <div style={{ paddingTop: gap }}>
      {title && (
        <div className="px-3 pt-4 pb-1 text-center text-black font-[Tinos,'Times_New_Roman',serif]">
          <h1 className="text-2xl md:text-3xl leading-tight">{title}</h1>
          {by.length > 0 && <p className="mt-1 text-sm md:text-base text-neutral-700">{by.join(' · ')}</p>}
        </div>
      )}
    </div>
  );
}

function ToolButtonWrap({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center rounded-md border border-border overflow-hidden">{children}</div>;
}

function Spinner({ text, small = false }: { text: string; small?: boolean }) {
  return (
    <div role="status" className="flex flex-col items-center gap-3 text-muted-foreground">
      <svg className={cn('animate-spin', small ? 'h-5 w-5' : 'h-8 w-8')} viewBox="0 0 24 24" fill="none" aria-hidden>
        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25" />
        <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      </svg>
      {text && <p className="text-sm text-center">{text}</p>}
    </div>
  );
}

