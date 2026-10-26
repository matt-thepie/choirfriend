import { cn } from '@/lib/utils.ts';
import type { FileKind } from '@/hooks/usePiece.ts';

const STYLE: Record<FileKind, { text: string; cls: string }> = {
  pdf: { text: 'PDF', cls: 'bg-sky-100 text-sky-800' },
  audio: { text: 'Audio', cls: 'bg-violet-100 text-violet-800' },
  lyrics: { text: 'Lyrics', cls: 'bg-emerald-100 text-emerald-800' },
  score: { text: 'Score', cls: 'bg-amber-100 text-amber-800' },
};

/** Small coloured tag naming a file's kind. */
export function KindBadge({ kind, className }: { kind: FileKind; className?: string }) {
  const s = STYLE[kind];
  return (
    <span className={cn('text-xs uppercase font-semibold px-1 py-0.5 rounded shrink-0', s.cls, className)}>
      {s.text}
    </span>
  );
}
