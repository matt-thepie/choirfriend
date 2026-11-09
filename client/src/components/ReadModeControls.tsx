import { useRef, useState } from 'react';

/** Touches end in touchend, below; some report an empty pointerType. */
const isMouseOrPen = (e: React.PointerEvent) => e.pointerType === 'mouse' || e.pointerType === 'pen';

/** Tap-on-release handling, optionally with a drag past 12px in direction
 *  `dir` (1 down, -1 up; null means drags do nothing). A tap counts on
 *  release, however long the press: Android turns a press of over half a
 *  second into a long-press and sends no click, and slow, deliberate presses
 *  are common. A finger that moves more than 12px is not a tap. */
function usePressTap(dir: 1 | -1 | null, onTap: () => void) {
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const reset = () => { dragRef.current = null; };
  const tapped = (x: number, y: number) => {
    const s = dragRef.current;
    reset();
    if (s && Math.hypot(x - s.x, y - s.y) <= 12) onTap();
  };
  return {
    // Pointers are handled on release; this is Enter or Space (detail 0).
    onClick: (e: React.MouseEvent) => { if (e.detail === 0) onTap(); },
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
    // A touch tap counts here rather than on pointerup, so that cancelling
    // the click still reaches us: otherwise the tab has gone by now and the
    // click lands on whatever is under the finger (a toolbar button).
    onTouchEnd: (e: React.TouchEvent) => {
      e.preventDefault();
      const t = e.changedTouches[0];
      if (t) tapped(t.clientX, t.clientY);
    },
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      // Capture so a drag keeps reporting here once it leaves the element.
      e.currentTarget.setPointerCapture(e.pointerId);
      dragRef.current = { x: e.clientX, y: e.clientY };
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (dir !== null && dragRef.current !== null && (e.clientY - dragRef.current.y) * dir > 12) {
        reset();
        onTap();
      }
    },
    onPointerUp: (e: React.PointerEvent) => {
      if (isMouseOrPen(e)) tapped(e.clientX, e.clientY);
    },
    onPointerCancel: reset,
    // Capture ends before touchend, which still needs the start point.
    onLostPointerCapture: (e: React.PointerEvent) => { if (isMouseOrPen(e)) reset(); },
  };
}

const CHEVRON_DOWN = 'M4 6l4 4 4-4';
const CHEVRON_UP = 'M4 10l4-4 4 4';

/** The drawer handle: stands up from the bottom edge, like a tab on a folder. */
function Tab({ path }: { path: string }) {
  return (
    <span className="flex h-8 w-16 items-start justify-center pt-1.5 rounded-t-xl bg-primary text-primary-foreground shadow-md transition-colors group-hover:bg-primary-hover group-focus-visible:ring-2 group-focus-visible:ring-primary/40 group-focus-visible:ring-offset-1">
      <svg aria-hidden="true" viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d={path} />
      </svg>
    </span>
  );
}

/** A pull tab at the bottom edge: the way back to the hidden read-mode
 *  toolbar for touch and keyboard readers. Tap it, drag it up, or Tab to it.
 *  It only shows while the toolbar is hidden. It lives at the bottom because
 *  a tab at the top edge kept pulling down Android's notification shade; it
 *  sits above the home-gesture inset so a swipe for Home misses it. */
export function ReadModeControls({ toolsOpen, onShow }: {
  toolsOpen: boolean;
  onShow: () => void;
}) {
  const pull = usePressTap(-1, onShow);
  if (toolsOpen) return null;
  return (
    <button
      type="button"
      aria-label="Show controls"
      title="Show controls"
      {...pull}
      className="group absolute bottom-0 left-1/2 -translate-x-1/2 z-30 flex h-12 w-20 touch-none items-end justify-center focus-visible:outline-none pb-[env(safe-area-inset-bottom)]"
    >
      <Tab path={CHEVRON_UP} />
    </button>
  );
}

/** The matching tab standing on the open toolbar: tap it or push it down to
 *  hide the toolbar again. Place inside the (positioned) toolbar header. */
export function ReadModeHideTab({ onHide }: { onHide: () => void }) {
  const pull = usePressTap(1, onHide);
  return (
    <button
      type="button"
      aria-label="Hide controls"
      title="Hide controls"
      {...pull}
      className="group absolute bottom-full left-1/2 -translate-x-1/2 flex h-12 w-20 touch-none items-end justify-center focus-visible:outline-none"
    >
      <Tab path={CHEVRON_DOWN} />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Page turning
// ---------------------------------------------------------------------------

/** How a reader turns pages in page view. Swipe: a sideways flick turns, a
 *  tap anywhere shows the toolbar. Edges: a tap in the outer quarter turns,
 *  swipes do nothing. One or the other, never both, so a flick that starts
 *  at the edge can't turn twice. */
export type TurnMode = 'swipe' | 'edges';
const TURN_MODE_KEY = 'choirfriend.turnMode';

/** Remembered per device, shared by the PDF and flowing-score viewers. Until
 *  chosen, touch-only devices swipe and devices with a mouse tap the edges. */
export function useTurnMode(): [TurnMode, (m: TurnMode) => void] {
  const [mode, setModeState] = useState<TurnMode>(() => {
    try {
      const v = localStorage.getItem(TURN_MODE_KEY);
      if (v === 'swipe' || v === 'edges') return v;
    } catch {
      /* storage blocked */
    }
    return typeof window !== 'undefined' && window.matchMedia('(hover: none)').matches ? 'swipe' : 'edges';
  });
  const setMode = (m: TurnMode) => {
    setModeState(m);
    try {
      localStorage.setItem(TURN_MODE_KEY, m);
    } catch {
      /* not remembered this time */
    }
  };
  return [mode, setMode];
}

/** A page-turn zone: the outer quarter of the stage. Turns on release so a
 *  slow press counts (see usePressTap); a marker badge under the zone is not
 *  followed from here, since margin marks used to send readers back pages. */
function EdgeZone({ side, label, enabled, onTurn }: { side: 'left' | 'right'; label: string; enabled: boolean; onTurn: () => void }) {
  const press = usePressTap(null, onTurn);
  return (
    <button
      type="button"
      aria-label={label}
      {...press}
      disabled={!enabled}
      className={`absolute ${side === 'left' ? 'left-0' : 'right-0'} top-0 bottom-0 w-1/4 min-w-16 z-10 disabled:opacity-30 disabled:cursor-not-allowed hover:bg-black/5 focus-visible:bg-black/10 transition-colors`}
      style={{ cursor: enabled ? (side === 'left' ? 'w-resize' : 'e-resize') : 'not-allowed' }}
    />
  );
}

export function EdgeTurnZones({ canPrev, canNext, onPrev, onNext }: {
  canPrev: boolean;
  canNext: boolean;
  onPrev: () => void;
  onNext: () => void;
}) {
  return (
    <>
      <EdgeZone side="left" label="Previous page" enabled={canPrev} onTurn={onPrev} />
      <EdgeZone side="right" label="Next page" enabled={canNext} onTurn={onNext} />
    </>
  );
}
