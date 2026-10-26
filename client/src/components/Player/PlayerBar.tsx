import { useState } from 'react';
import { Button, Icon, IconButton } from '@/components/ui/button.tsx';
import { cn } from '@/lib/utils.ts';
import { formatTime, usePlayer } from '@/player/PlayerContext.tsx';

interface PlayerBarProps {
  /** Open the song a queued track belongs to. */
  onOpenPiece?: (pieceId: number) => void;
}

const RATES = [0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1, 1.1, 1.25, 1.5];

/**
 * The mini player: a white card docked to the bottom, 72px tall, with a thin
 * seek bar across its top edge. Hidden until something is queued. Tap the
 * title to expand the full player: the queue, speed, A-B loop and repeat.
 */
export function PlayerBar({ onOpenPiece }: PlayerBarProps) {
  const p = usePlayer();
  const [open, setOpen] = useState(false);

  if (!p.queue || !p.current) return null;
  const total = p.queue.tracks.length;
  const hasDuration = Number.isFinite(p.duration);

  return (
    <div className="shrink-0 sm:px-4 sm:pb-3">
      <div className="bg-background text-foreground shadow-float sm:rounded-lg overflow-hidden relative max-w-(--max) mx-auto">
        <input
          type="range"
          min={0}
          max={hasDuration ? p.duration : 1}
          step={0.1}
          value={Math.min(p.currentTime, hasDuration ? p.duration : p.currentTime)}
          onChange={(e) => p.seek(Number(e.target.value))}
          disabled={!hasDuration}
          className="absolute top-0 inset-x-0 h-1.5 w-full appearance-none bg-card-2 cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary"
          aria-label="Seek"
        />

        {open && (
          <div className="px-4 pt-5 pb-3 border-b border-border max-h-[50dvh] overflow-auto">
            <div className="flex items-center justify-between mb-3">
              <div className="text-base font-semibold">
                {p.queue.name}
                <span className="text-muted-foreground font-normal ml-2 text-sm">{p.index + 1} of {total}</span>
              </div>
              <IconButton icon="close" label="Close player" onClick={p.clear} size="sm" />
            </div>

            <ol className="inset-list mb-4">
              {p.queue.tracks.map((t, i) => (
                <li
                  key={`${t.fileId}-${i}`}
                  className={cn('inset-row flex items-center gap-3 px-4 cursor-pointer hover:shadow-card', i === p.index && 'ring-2 ring-primary')}
                  onClick={() => p.playAt(i)}
                >
                  <span className="w-6 text-right text-sm tabular-nums text-muted-foreground">{i + 1}</span>
                  <div className="flex-1 min-w-0 py-2">
                    <div className={cn('text-base truncate', i === p.index && 'font-semibold')}>{t.pieceTitle}</div>
                    <div className="text-sm text-muted-foreground truncate">{t.title}</div>
                  </div>
                  {onOpenPiece && (
                    <IconButton
                      icon="library_music"
                      label="Open song"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenPiece(t.pieceId);
                      }}
                    />
                  )}
                </li>
              ))}
            </ol>

            <div className="flex flex-wrap items-center gap-x-5 gap-y-3 text-sm">
              <label className="flex items-center gap-2">
                <span className="text-muted-foreground">Speed</span>
                <select
                  value={p.rate}
                  onChange={(e) => p.setRate(Number(e.target.value))}
                  className="h-10 px-2 rounded-md border border-border bg-background text-sm"
                >
                  {RATES.map((r) => (
                    <option key={r} value={r}>{r}x</option>
                  ))}
                </select>
              </label>
              <div className="flex items-center gap-1">
                <span className="text-muted-foreground mr-1">A-B loop</span>
                <Button size="sm" variant={p.loop.start !== null ? 'default' : 'outline'} onClick={p.setLoopStart}>
                  {p.loop.start !== null ? `A ${formatTime(p.loop.start)}` : 'Set A'}
                </Button>
                <Button size="sm" variant={p.loop.end !== null ? 'default' : 'outline'} onClick={p.setLoopEnd}>
                  {p.loop.end !== null ? `B ${formatTime(p.loop.end)}` : 'Set B'}
                </Button>
                {(p.loop.start !== null || p.loop.end !== null) && (
                  <Button size="sm" variant="ghost" onClick={p.clearLoop}>Clear</Button>
                )}
              </div>
              <Button size="sm" variant={p.repeat !== 'off' ? 'default' : 'outline'} onClick={p.cycleRepeat} title="Repeat: off → all → one">
                <Icon name={p.repeat === 'one' ? 'repeat_one' : 'repeat'} className="text-xl" />
                Repeat {p.repeat === 'off' ? 'off' : p.repeat}
              </Button>
            </div>
          </div>
        )}

        <div className="h-[72px] px-3 sm:px-4 flex items-center gap-1 sm:gap-2">
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="flex-1 min-w-0 text-left h-full"
            aria-expanded={open}
            title={open ? 'Hide queue' : 'Show queue'}
          >
            <div className="text-base font-semibold truncate">{p.current.pieceTitle}</div>
            <div className="text-sm text-muted-foreground truncate">
              {p.current.title}
              {total > 1 && <span className="ml-1.5">· {p.index + 1}/{total}</span>}
              {p.rate !== 1 && <span className="ml-1.5">· {p.rate}x</span>}
              {p.error && <span className="ml-1.5 text-destructive">· {p.error}</span>}
            </div>
            <div className="text-xs text-muted-foreground tabular-nums">
              {formatTime(p.currentTime)}{hasDuration ? ` / ${formatTime(p.duration)}` : ''}
            </div>
          </button>

          <IconButton icon="skip_previous" label="Previous" size="sm" onClick={p.prev} disabled={total <= 1 && p.currentTime < 3} className="hidden sm:inline-flex" />
          <IconButton icon="replay_10" label="Back 10 seconds" size="sm" onClick={() => p.skip(-10)} />
          <button
            type="button"
            onClick={p.toggle}
            aria-label={p.isPlaying ? 'Pause' : 'Play'}
            className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-primary text-primary-foreground hover:bg-primary-hover active:bg-primary-active shadow-card shrink-0"
          >
            <Icon name={p.isPlaying ? 'pause' : 'play_arrow'} filled className="text-3xl" />
          </button>
          <IconButton icon="forward_10" label="Forward 10 seconds" size="sm" onClick={() => p.skip(10)} />
          <IconButton icon="skip_next" label="Next" size="sm" onClick={p.next} disabled={p.index >= total - 1 && p.repeat !== 'all'} className="hidden sm:inline-flex" />
          <IconButton icon={open ? 'expand_more' : 'expand_less'} label={open ? 'Hide queue' : 'Show queue'} size="sm" onClick={() => setOpen((o) => !o)} />
        </div>
      </div>
    </div>
  );
}
