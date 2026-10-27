import type { Piece } from '@/hooks/usePiece.ts';
import { isPdfFile } from '@/hooks/usePiece.ts';

export type ViewTarget = { kind: 'pdf' | 'flow'; id: number };

/** What a piece can be read from: its PDFs and its ready flowing scores. */
export function viewTargets(piece: Piece): Array<ViewTarget & { label: string }> {
  const pdfs = piece.files
    .filter((f) => f.kind === 'pdf' || (f.kind === 'lyrics' && isPdfFile(f)))
    .map((f, i) => ({ kind: 'pdf' as const, id: f.id, label: f.label?.trim() || f.filename || `PDF ${i + 1}` }));
  const flowing = (piece.flowing ?? [])
    .filter((s) => s.status === 'ready')
    .map((s) => ({ kind: 'flow' as const, id: s.fileId, label: `${s.title} (flowing)` }));
  return [...flowing, ...pdfs];
}

/**
 * Pick which version of the music to read: a flowing score or one of the
 * PDFs. Shared by both viewers; hidden when there's only one choice.
 */
export function ViewSwitcher({ piece, current, onSelect }: {
  piece: Piece;
  current: ViewTarget | null;
  onSelect: (target: ViewTarget) => void;
}) {
  const targets = viewTargets(piece);
  if (targets.length < 2) return null;
  const value = current ? `${current.kind}:${current.id}` : `${targets[0]!.kind}:${targets[0]!.id}`;
  return (
    <label className="flex items-center gap-1 text-xs shrink-0">
      <span className="text-muted-foreground hidden sm:inline">View</span>
      <select
        value={value}
        onChange={(e) => {
          const [kind, id] = e.target.value.split(':');
          onSelect({ kind: kind as ViewTarget['kind'], id: Number(id) });
        }}
        aria-label="Choose what to read from"
        className="h-8 max-w-[12rem] rounded-md border border-border bg-background px-2 text-xs font-medium"
      >
        {targets.map((t) => (
          <option key={`${t.kind}:${t.id}`} value={`${t.kind}:${t.id}`}>
            {t.label}
          </option>
        ))}
      </select>
    </label>
  );
}
