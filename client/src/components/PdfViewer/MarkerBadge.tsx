import { cn } from '@/lib/utils.ts';
import { markerLabel, type MarkerAnnotation, type MarkerKind } from '@/types/annotations.ts';
import { MarkerGlyph } from './markerIcons.tsx';

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
  /** Reading follows a jump; editing selects the marker and exposes deletion. */
  interactive: boolean;
  editing?: boolean;
  selected?: boolean;
  erasing?: boolean;
  onSelect?: (marker: MarkerAnnotation) => void;
  /** Context "follow" action (e.g. D.S. → Go to Segno), or null. A single tap
   *  on the badge runs it — no menu, no second tap. */
  follow?: { label: string; run: () => void } | null;
  onDelete?: (id: string) => void;
}

export function MarkerBadge({ marker, pageWidth, pageHeight, interactive, follow, onDelete, editing, selected, erasing, onSelect }: MarkerBadgeProps) {
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
    >
      <button
        type="button"
        onClick={(e) => {
          if (!interactive) return;
          e.stopPropagation();
          if (erasing && canDelete) { onDelete!(marker.id); return; }
          if (editing && canDelete) { onSelect?.(marker); return; }
          if (editing || erasing) return;
          follow?.run(); // single tap jumps; no-op for markers that aren't a jump source
        }}
        className={cn(
          'inline-flex items-center px-2 py-0.5 rounded-md border text-xs font-semibold shadow-sm whitespace-nowrap select-none',
          styles,
          selected && 'ring-4 ring-primary',
          (editing || erasing) && 'min-w-11 min-h-11 justify-center',
          // Pad the hit area well beyond the small badge so a finger can find it.
          interactive && follow && !editing && !erasing ? "relative cursor-pointer hover:shadow-md after:absolute after:-inset-3 after:content-['']" : 'cursor-default',
        )}
        tabIndex={interactive ? 0 : -1}
        aria-label={editing ? `Edit ${label} marker` : erasing ? `Erase ${label} marker` : undefined}
        title={follow ? follow.label : `${marker.markerKind}${marker.label ? ` · ${marker.label}` : ''}`}
      >
        <MarkerGlyph kind={marker.markerKind} label={label} className="w-4 h-4" />
        {follow && !editing && !erasing && <span className="ml-1 opacity-70">→</span>}
      </button>


    </div>
  );
}
