import { useRef } from 'react';

/** Touches end in touchend, below; some report an empty pointerType. */
const isMouseOrPen = (e: React.PointerEvent) => e.pointerType === 'mouse' || e.pointerType === 'pen';

/** Tap or drag-past-12px handling shared by both pull tabs. `dir` is the way
 *  the drag has to go: 1 down, -1 up. A tap counts on release, however long
 *  the press: Android turns a press of over half a second into a long-press
 *  and sends no click, and slow, deliberate presses are common. */
function usePull(dir: 1 | -1, onPull: () => void) {
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const reset = () => { dragRef.current = null; };
  const tapped = (x: number, y: number) => {
    const s = dragRef.current;
    reset();
    if (s && Math.hypot(x - s.x, y - s.y) <= 12) onPull();
  };
  return {
    // Pointers are handled on release; this is Enter or Space (detail 0).
    onClick: (e: React.MouseEvent) => { if (e.detail === 0) onPull(); },
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
      // Capture so a drag keeps reporting here once it leaves the tab.
      e.currentTarget.setPointerCapture(e.pointerId);
      dragRef.current = { x: e.clientX, y: e.clientY };
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (dragRef.current !== null && (e.clientY - dragRef.current.y) * dir > 12) {
        reset();
        onPull();
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

/** The drawer handle: hangs from the edge above it, like a tab on a blind. */
function Tab({ path }: { path: string }) {
  return (
    <span className="flex h-8 w-16 items-end justify-center pb-1.5 rounded-b-xl bg-primary text-primary-foreground shadow-md transition-colors group-hover:bg-primary-hover group-focus-visible:ring-2 group-focus-visible:ring-primary/40 group-focus-visible:ring-offset-1">
      <svg aria-hidden="true" viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d={path} />
      </svg>
    </span>
  );
}

/** A pull tab at the top edge: the way back to the hidden read-mode
 *  toolbar for touch and keyboard readers. Tap it, drag it down, or Tab to it.
 *  It only shows while the toolbar is hidden. It is tall enough that a finger
 *  lands on it well clear of the status bar, so a drag isn't taken for
 *  Android's notification-shade swipe. */
export function ReadModeControls({ toolsOpen, onShow }: {
  toolsOpen: boolean;
  onShow: () => void;
}) {
  const pull = usePull(1, onShow);
  if (toolsOpen) return null;
  return (
    <button
      type="button"
      aria-label="Show controls"
      title="Show controls"
      {...pull}
      className="group absolute top-0 left-1/2 -translate-x-1/2 z-30 flex h-12 w-20 touch-none items-start justify-center focus-visible:outline-none"
    >
      <Tab path={CHEVRON_DOWN} />
    </button>
  );
}

/** The matching tab hanging under the open toolbar: tap it or push it up to
 *  hide the toolbar again. Place inside the (positioned) toolbar header. */
export function ReadModeHideTab({ onHide }: { onHide: () => void }) {
  const pull = usePull(-1, onHide);
  return (
    <button
      type="button"
      aria-label="Hide controls"
      title="Hide controls"
      {...pull}
      className="group absolute top-full left-1/2 -translate-x-1/2 flex h-12 w-20 touch-none items-start justify-center focus-visible:outline-none"
    >
      <Tab path={CHEVRON_UP} />
    </button>
  );
}
