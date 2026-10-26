import { useState } from 'react';
import { Button } from '@/components/ui/button.tsx';
import { cn } from '@/lib/utils.ts';
import { formatTime, usePlayer } from '@/player/PlayerContext.tsx';

interface PlayerBarProps {
  /** Open the song a queued track belongs to. */
  onOpenPiece?: (pieceId: number) => void;
}

const RATES = [0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1, 1.1, 1.25];

/**
 * Persistent bottom bar for the practice player. Hidden until something is
 * queued. Collapsed: what's playing + transport. Expanded: the queue, seek
 * bar, speed, A–B loop and repeat.
 */
export function PlayerBar({ onOpenPiece }: PlayerBarProps) {
  const p = usePlayer();
  const [open, setOpen] = useState(false);

  if (!p.queue || !p.current) return null;
  const total = p.queue.tracks.length;

  return (
    <div className="border-t border-border bg-background/95 backdrop-blur shrink-0">
      {open && (
        <div className="px-4 pt-3 pb-2 border-b border-border max-h-[50dvh] overflow-auto">
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs font-semibold">
              {p.queue.name}
              <span className="text-muted-foreground font-normal ml-2">
                {p.index + 1} of {total}
              </span>
            </div>
            <div className="flex items-center gap-1">
              <Button size="sm" variant={p.repeat !== 'off' ? 'default' : 'outline'} className="h-7 px-2 text-xs" onClick={p.cycleRepeat} title="Repeat: off → all → one">
                Repeat {p.repeat === 'off' ? 'off' : p.repeat === 'all' ? 'all' : 'one'}
              </Button>
            </div>
          </div>

          <ol className="divide-y divide-border rounded-md border border-border overflow-hidden mb-3">
            {p.queue.tracks.map((t, i) => (
              <li
                key={`${t.fileId}-${i}`}
                className={cn(
                  'flex items-center gap-3 px-3 py-1.5 text-sm cursor-pointer hover:bg-accent/40',
                  i === p.index && 'bg-accent/60',
                )}
                onClick={() => p.playAt(i)}
              >
                <span className="w-5 text-right text-xs tabular-nums text-muted-foreground">{i + 1}</span>
                <div className="flex-1 min-w-0">
                  <div className={cn('truncate', i === p.index && 'font-semibold')}>{t.pieceTitle}</div>
                  <div className="text-xs text-muted-foreground truncate">{t.title}</div>
                </div>
                {onOpenPiece && (
                  <button
                    type="button"
                    className="text-xs text-muted-foreground hover:text-foreground shrink-0"
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenPiece(t.pieceId);
                    }}
                  >
                    Score ›
                  </button>
                )}
              </li>
            ))}
          </ol>

          <div className="flex flex-wrap items-center gap-3 text-xs">
            <div className="flex items-center gap-2">
              <label className="text-muted-foreground">Speed</label>
              <select
                value={p.rate}
                onChange={(e) => p.setRate(Number(e.target.value))}
                className="h-7 px-1.5 rounded-md border border-border bg-background text-xs"
              >
                {RATES.map((r) => (
                  <option key={r} value={r}>{r}x</option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-1">
              <span className="text-muted-foreground mr-1">Loop</span>
              <Button size="sm" variant={p.loop.start !== null ? 'default' : 'outline'} onClick={p.setLoopStart} className="h-7 px-2 text-xs">
                {p.loop.start !== null ? `A ${formatTime(p.loop.start)}` : 'Set A'}
              </Button>
              <Button size="sm" variant={p.loop.end !== null ? 'default' : 'outline'} onClick={p.setLoopEnd} className="h-7 px-2 text-xs">
                {p.loop.end !== null ? `B ${formatTime(p.loop.end)}` : 'Set B'}
              </Button>
              {(p.loop.start !== null || p.loop.end !== null) && (
                <Button size="sm" variant="ghost" onClick={p.clearLoop} className="h-7 px-2 text-xs">clear</Button>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="px-3 py-2 flex items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex-1 min-w-0 text-left"
          aria-expanded={open}
          title={open ? 'Hide queue' : 'Show queue'}
        >
          <div className="text-sm font-medium truncate">{p.current.pieceTitle}</div>
          <div className="text-xs text-muted-foreground truncate">
            {p.current.title}
            {total > 1 && <span className="ml-1.5">· {p.index + 1}/{total}</span>}
            {p.error && <span className="ml-1.5 text-destructive">· {p.error}</span>}
          </div>
        </button>

        <IconButton label="Previous" onClick={p.prev} disabled={total <= 1 && p.currentTime < 3}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M6 5h2v14H6zM20 5v14l-10-7z" /></svg>
        </IconButton>
        <IconButton label="Back 10 seconds" onClick={() => p.skip(-10)}>
          <span className="text-[10px] font-semibold">-10</span>
        </IconButton>
        <button
          type="button"
          onClick={p.toggle}
          aria-label={p.isPlaying ? 'Pause' : 'Play'}
          className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-primary text-primary-foreground hover:opacity-90"
        >
          {p.isPlaying ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M8 5v14l11-7z" /></svg>
          )}
        </button>
        <IconButton label="Forward 10 seconds" onClick={() => p.skip(10)}>
          <span className="text-[10px] font-semibold">+10</span>
        </IconButton>
        <IconButton label="Next" onClick={p.next} disabled={p.index >= total - 1 && p.repeat !== 'all'}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M16 5h2v14h-2zM4 5v14l10-7z" /></svg>
        </IconButton>
        <IconButton label="Close player" onClick={p.clear}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M6 6 18 18M18 6 6 18" /></svg>
        </IconButton>
      </div>

      {/* Seek bar always visible — it's the thing you reach for most. */}
      <div className="px-3 pb-2 flex items-center gap-2 text-[11px] text-muted-foreground">
        <span className="tabular-nums w-9 text-right">{formatTime(p.currentTime)}</span>
        <input
          type="range"
          min={0}
          max={Number.isFinite(p.duration) ? p.duration : 1}
          step={0.1}
          value={Math.min(p.currentTime, Number.isFinite(p.duration) ? p.duration : p.currentTime)}
          onChange={(e) => p.seek(Number(e.target.value))}
          disabled={!Number.isFinite(p.duration)}
          className="flex-1 accent-primary"
          aria-label="Seek"
        />
        <span className="tabular-nums w-9">
          {Number.isFinite(p.duration) ? `-${formatTime(p.duration - p.currentTime)}` : '—:—'}
        </span>
      </div>
    </div>
  );
}

function IconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center justify-center w-9 h-9 rounded-md hover:bg-accent disabled:opacity-40 disabled:pointer-events-none shrink-0"
    >
      {children}
    </button>
  );
}
