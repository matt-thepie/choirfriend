import { useLayoutEffect, useState, type ReactNode, type RefObject } from 'react';
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

/**
 * A drop-down panel rendered into document.body. Toolbars scroll sideways on
 * narrow screens and the sticky header uses backdrop-blur, both of which clip
 * or trap an absolutely-positioned child — so panels live outside them and
 * are placed with fixed coordinates taken from the anchor.
 */
export function Popover({ anchorRef, align = 'left', onClose, className, children }: PopoverProps) {
  const [pos, setPos] = useState<{ top: number; left?: number; right?: number } | null>(null);

  useLayoutEffect(() => {
    const place = () => {
      const r = anchorRef.current?.getBoundingClientRect();
      if (!r) return;
      const vw = document.documentElement.clientWidth;
      setPos(align === 'right'
        ? { top: r.bottom + 4, right: Math.max(8, vw - r.right) }
        : { top: r.bottom + 4, left: Math.max(8, r.left) });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [anchorRef, align]);

  if (!pos) return null;
  return createPortal(
    <>
      {onClose && <div className="fixed inset-0 z-40" onClick={onClose} aria-hidden />}
      <div
        style={{ top: pos.top, left: pos.left, right: pos.right, maxWidth: 'calc(100vw - 1rem)' }}
        className={cn('fixed z-50 bg-background border border-border rounded-md shadow-lg', className)}
      >
        {children}
      </div>
    </>,
    document.body,
  );
}
