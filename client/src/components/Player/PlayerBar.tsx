import { useState } from 'react';
import { Button, Icon, IconButton } from '@/components/ui/button.tsx';
import { cn } from '@/lib/utils.ts';
import { formatTime, usePlayer } from '@/player/PlayerContext.tsx';

interface PlayerBarProps {
  /** Open the song a queued track belongs to. */
  onOpenPiece?: (pieceId: number) => void;
}

/** 0.5x to 1.5x in steps of 0.1 (pitch is preserved by the player). */
const RATES = Array.from({ length: 11 }, (_, i) => Math.round((0.5 + i * 0.1) * 10) / 10);
const rateLabel = (r: number) => `${r}x`;

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
          className="seek absolute top-0 inset-x-0 h-3 w-full appearance-none bg-transparent cursor-pointer"
          aria-label="Seek"
        />

        {open && (
          <div className="px-4 pt-5 pb-3 border-b border-border max-h-[50dvh] overflow-auto">
            <div className="text-base font-semibold mb-3">
              {p.queue.name}
              <span className="text-muted-foreground font-normal ml-2 text-sm">{p.index + 1} of {total}</span>
            </div>

            <div className="flex flex-wrap items-center gap-x-5 gap-y-3 text-sm mb-4">
              <label className="flex items-center gap-2">
                <span className="text-muted-foreground">Speed</span>
                <select
                  value={p.rate}
                  onChange={(e) => p.setRate(Number(e.target.value))}
                  className="h-10 px-2 rounded-md border border-border bg-background text-sm"
                >
                  {RATES.map((r) => (
                    <option key={r} value={r}>{rateLabel(r)}</option>
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

            <ol className="inset-list mb-1">
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

            <Button size="sm" variant="outline" onClick={p.clear} className="sm:hidden mt-2">
              <Icon name="close" className="text-lg" />
              Stop and close player
            </Button>
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
              {p.error && <span className="ml-1.5 text-destructive">· {p.error}</span>}
            </div>
            <div className="text-xs text-muted-foreground tabular-nums">
              {formatTime(p.currentTime)}{hasDuration ? ` / ${formatTime(p.duration)}` : ''}
            </div>
          </button>

          <IconButton icon="skip_previous" label="Previous" size="sm" onClick={p.prev} disabled={total <= 1 && p.currentTime < 3} className="hidden sm:inline-flex" />
          <select
            value={p.rate}
            onChange={(e) => p.setRate(Number(e.target.value))}
            aria-label="Playback speed"
            title="Playback speed"
            className={cn(
              'h-9 w-[3.75rem] px-1.5 rounded-full border text-sm font-semibold tabular-nums text-center shrink-0 appearance-none cursor-pointer',
              p.rate !== 1 ? 'border-primary bg-accent text-accent-foreground' : 'border-border bg-background',
            )}
          >
            {RATES.map((r) => (
              <option key={r} value={r}>{rateLabel(r)}</option>
            ))}
          </select>
          <IconButton icon="first_page" label="Back to start" size="sm" onClick={() => p.seek(0)} />
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
          {/* Stops and removes the player, so it sits in the bar, not the panel. */}
          <IconButton icon="close" label="Stop and close the player" size="sm" onClick={p.clear} className="hidden sm:inline-flex" />
        </div>
      </div>
    </div>
  );
}
