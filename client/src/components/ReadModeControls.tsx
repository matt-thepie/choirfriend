import { useRef } from 'react';

/** A slim pull tab at the top edge: the way back to the hidden read-mode
 *  toolbar for touch and keyboard readers. Tap it, drag it down, or Tab to it.
 *  It only shows while the toolbar is hidden, and sits clear of the music. */
export function ReadModeControls({ toolsOpen, onShow }: {
  toolsOpen: boolean;
  onShow: () => void;
}) {
  const dragRef = useRef<number | null>(null);
  if (toolsOpen) return null;
  return (
    <button
      type="button"
      aria-label="Show controls"
      title="Show controls"
      onClick={onShow}
      onPointerDown={(e) => {
        // Capture so a drag keeps reporting here once it leaves the 24px tab.
        e.currentTarget.setPointerCapture(e.pointerId);
        dragRef.current = e.clientY;
      }}
      onPointerMove={(e) => {
        if (dragRef.current !== null && e.clientY - dragRef.current > 12) {
          dragRef.current = null;
          onShow();
        }
      }}
      onPointerUp={() => { dragRef.current = null; }}
      onPointerCancel={() => { dragRef.current = null; }}
      onLostPointerCapture={() => { dragRef.current = null; }}
      className="group absolute top-0 left-1/2 -translate-x-1/2 z-30 flex h-6 w-20 touch-none items-start justify-center pt-1 focus-visible:outline-none"
    >
      <span className="block h-1.5 w-10 rounded-full bg-foreground/25 shadow-sm transition-colors group-hover:bg-foreground/50 group-focus-visible:bg-primary group-focus-visible:ring-2 group-focus-visible:ring-primary/40" />
    </button>
  );
}
