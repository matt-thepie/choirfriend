import { useMemo } from 'react';
import { Button } from '@/components/ui/button.tsx';
import { cn } from '@/lib/utils.ts';
import { usePiece, type Piece, type PieceFile } from '@/hooks/usePiece.ts';
import { useSections } from '@/hooks/useSections.ts';
import { usePlayer, type Queue, type QueueTrack } from '@/player/PlayerContext.tsx';

interface AudioPlayerProps {
  pieceId: number | null;
  /** Triggers a refetch — keeps the strip in sync with upload events fired
   *  by the PDF viewer. */
  refreshTick?: number;
  /** The signed-in member's own voice part; its tracks are listed first. */
  mySectionId?: number | null;
}

/** Build a queue track from a file and its piece. */
export function toQueueTrack(piece: Pick<Piece, 'id' | 'title' | 'composer'>, f: PieceFile): QueueTrack {
  return {
    fileId: f.id,
    url: f.url,
    title: f.label?.trim() || f.filename,
    subtitle: piece.composer ? `${piece.title} · ${piece.composer}` : piece.title,
    pieceId: piece.id,
    pieceTitle: piece.title,
    sectionId: f.sectionId,
  };
}

/**
 * Track strip for the open piece. Lists learning tracks grouped by voice
 * part (your own part first, then the others, then untagged full mixes);
 * tapping one queues the whole piece and starts on that track. Playback
 * itself is handled by the app-wide player bar below this strip.
 */
export function AudioPlayer({ pieceId, refreshTick = 0, mySectionId = null }: AudioPlayerProps) {
  const { piece } = usePiece(pieceId, refreshTick);
  const { sections, byId } = useSections();
  const player = usePlayer();

  const audioFiles = useMemo(() => piece?.files.filter((f) => f.kind === 'audio') ?? [], [piece]);

  // Order: my section, then sections in choir order, then untagged.
  const ordered = useMemo(() => {
    const rank = new Map<number | null, number>();
    sections.forEach((s, i) => rank.set(s.id, i + 1));
    if (mySectionId !== null) rank.set(mySectionId, 0);
    rank.set(null, sections.length + 1);
    return [...audioFiles].sort(
      (a, b) => (rank.get(a.sectionId) ?? 99) - (rank.get(b.sectionId) ?? 99) || a.sortOrder - b.sortOrder || a.id - b.id,
    );
  }, [audioFiles, sections, mySectionId]);

  if (!piece || ordered.length === 0) return null;

  const queue: Queue = { name: piece.title, tracks: ordered.map((f) => toQueueTrack(piece, f)) };
  const playingId = player.current?.fileId ?? null;

  return (
    <div className="border-t border-border bg-muted/30 px-3 py-2 flex items-center gap-2 overflow-x-auto">
      <span className="text-xs text-muted-foreground shrink-0">Tracks</span>
      {ordered.map((f, i) => {
        const sec = f.sectionId !== null ? byId.get(f.sectionId) : null;
        const active = playingId === f.id;
        return (
          <Button
            key={f.id}
            size="sm"
            variant={active ? 'default' : 'outline'}
            className={cn('h-8 px-2.5 text-xs shrink-0 gap-1.5', active && player.isPlaying && 'animate-pulse')}
            onClick={() => (active ? player.toggle() : player.playQueue(queue, i))}
            title={f.filename}
          >
            {sec && (
              <span className={cn('text-xs uppercase font-semibold px-1 rounded', active ? 'bg-primary-foreground/20' : 'bg-violet-100 text-violet-800')}>
                {sec.badge}
              </span>
            )}
            <span className="max-w-40 truncate">{f.label?.trim() || f.filename}</span>
          </Button>
        );
      })}
    </div>
  );
}
