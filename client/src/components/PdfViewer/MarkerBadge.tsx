import { useState } from 'react';
import { cn } from '@/lib/utils.ts';
import { markerLabel, type MarkerAnnotation, type MarkerKind } from '@/types/annotations.ts';

/** Tailwind classes for the badge per marker kind. Keeps the visual
 *  vocabulary tight so a quick glance at the score reads as "Segno",
 *  "Coda", etc. without having to read the text. */
const KIND_STYLES: Record<MarkerKind, string> = {
  segno: 'bg-amber-100 text-amber-900 border-amber-400',
  coda: 'bg-amber-200 text-amber-900 border-amber-500',
  ds: 'bg-emerald-100 text-emerald-900 border-emerald-400',
  dc: 'bg-emerald-100 text-emerald-900 border-emerald-400',
  fine: 'bg-rose-100 text-rose-900 border-rose-400',
  'to-coda': 'bg-amber-50 text-amber-900 border-amber-300',
  'repeat-start': 'bg-violet-100 text-violet-900 border-violet-400',
  'repeat-end': 'bg-violet-100 text-violet-900 border-violet-400',
  'volta-1': 'bg-sky-100 text-sky-900 border-sky-400',
  'volta-2': 'bg-sky-100 text-sky-900 border-sky-400',
  bar: 'bg-slate-100 text-slate-900 border-slate-400',
  custom: 'bg-slate-100 text-slate-900 border-slate-400',
};

interface MarkerBadgeProps {
  marker: MarkerAnnotation;
  pageWidth: number;
  pageHeight: number;
  /** If interactive, the badge captures clicks for the action menu. */
  interactive: boolean;
  onJump?: () => void;
  onDelete?: (id: string) => void;
}

export function MarkerBadge({ marker, pageWidth, pageHeight, interactive, onJump, onDelete }: MarkerBadgeProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const styles = KIND_STYLES[marker.markerKind];
  const label = markerLabel(marker);
  const canDelete = onDelete && (marker.layer === 'shared' || marker.isMine !== false);

  return (
    <div
      className="absolute"
      style={{
        left: marker.position.x * pageWidth,
        top: marker.position.y * pageHeight,
        transform: 'translate(-50%, -50%)',
        pointerEvents: interactive ? 'auto' : 'none',
      }}
      onClick={(e) => {
        if (!interactive) return;
        e.stopPropagation();
        setMenuOpen((o) => !o);
      }}
    >
      <button
        type="button"
        className={cn(
          'inline-flex items-center px-2 py-0.5 rounded-md border text-xs font-semibold shadow-sm',
          'whitespace-nowrap select-none',
          styles,
          interactive && 'cursor-pointer hover:shadow-md',
        )}
        title={`${marker.markerKind}${marker.label ? ` · ${marker.label}` : ''}`}
      >
        {label}
      </button>

      {menuOpen && (
        <div
          className="absolute left-1/2 top-full mt-1 -translate-x-1/2 bg-background border border-border rounded-md shadow-lg text-xs z-20 min-w-32"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="block w-full text-left px-3 py-1.5 hover:bg-accent disabled:opacity-50"
            onClick={() => {
              onJump?.();
              setMenuOpen(false);
            }}
            disabled={!onJump}
          >
            Jump here
          </button>
          {canDelete && (
            <button
              type="button"
              className="block w-full text-left px-3 py-1.5 hover:bg-accent text-destructive"
              onClick={() => {
                onDelete!(marker.id);
                setMenuOpen(false);
              }}
            >
              Delete
            </button>
          )}
        </div>
      )}
    </div>
  );
}
