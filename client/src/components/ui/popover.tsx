import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils.ts';

interface PopoverProps {
  /** The element the panel drops down from (usually a wrapper round the button). */
  anchorRef: RefObject<HTMLElement | null>;
  /** Which edge of the anchor the panel lines up with. */
  align?: 'left' | 'right';
  /** If given, tapping outside the panel closes it. */
  onClose?: () => void;
  className?: string;
  children: ReactNode;
}

const GAP = 4;
const MARGIN = 8;

/**
 * A drop-down panel rendered into document.body. Toolbars scroll sideways on
 * narrow screens and the sticky header uses backdrop-blur, both of which clip
 * or trap an absolutely-positioned child — so panels live outside them and
 * are placed with fixed coordinates taken from the anchor.
 *
 * Fixed panels can't be scrolled into view, so the panel opens upwards when
 * there's no room below the anchor (a button near the bottom of a phone
 * screen), is kept inside the viewport sideways, and scrolls internally if
 * neither side has room for all of it.
 */
export function Popover({ anchorRef, align = 'left', onClose, className, children }: PopoverProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; maxHeight: number } | null>(null);

  useLayoutEffect(() => {
    const place = () => {
      const r = anchorRef.current?.getBoundingClientRect();
      if (!r) return;
      const vw = document.documentElement.clientWidth;
      const vh = window.innerHeight;
      const panel = panelRef.current;
      const w = panel?.offsetWidth ?? 0;
      // scrollHeight is the panel's natural height even while maxHeight caps it.
      const h = panel?.scrollHeight ?? 0;

      const below = vh - r.bottom - GAP - MARGIN;
      const above = r.top - GAP - MARGIN;
      const up = h > below && above > below;
      const maxHeight = Math.max(120, up ? above : below);
      const top = up ? Math.max(MARGIN, r.top - GAP - Math.min(h, maxHeight)) : r.bottom + GAP;

      const preferred = align === 'right' ? r.right - w : r.left;
      const left = Math.max(MARGIN, Math.min(preferred, vw - w - MARGIN));
      setPos((p) => (p && p.top === top && p.left === left && p.maxHeight === maxHeight ? p : { top, left, maxHeight }));
    };
    place();
    // A second pass once the panel has rendered and can be measured.
    const raf = requestAnimationFrame(place);
    const ro = new ResizeObserver(place);
    if (panelRef.current) ro.observe(panelRef.current);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [anchorRef, align]);

  return createPortal(
    <>
      {onClose && <div className="fixed inset-0 z-40" onClick={onClose} aria-hidden />}
      <div
        ref={panelRef}
        data-popover
        style={
          pos
            ? { top: pos.top, left: pos.left, maxHeight: pos.maxHeight, maxWidth: `calc(100vw - ${MARGIN * 2}px)` }
            : { top: 0, left: 0, visibility: 'hidden', maxWidth: `calc(100vw - ${MARGIN * 2}px)` }
        }
        className={cn('fixed z-50 overflow-auto bg-background border border-border rounded-md shadow-lg', className)}
      >
        {children}
      </div>
    </>,
    document.body,
  );
}
