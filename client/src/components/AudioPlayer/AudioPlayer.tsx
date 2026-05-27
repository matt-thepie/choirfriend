import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button.tsx';
import { cn } from '@/lib/utils.ts';
import { usePiece } from '@/hooks/usePiece.ts';
import { formatTime, useAudioPlayer } from '@/hooks/useAudioPlayer.ts';

interface AudioPlayerProps {
  pieceId: number | null;
  /** Triggers a refetch — keeps audio player in sync with upload events
   *  fired by the PDF viewer. */
  refreshTick?: number;
}

const RATE_PRESETS = [0.5, 0.65, 0.75, 0.85, 1.0, 1.15, 1.25] as const;

/**
 * Sticky bottom panel for the current piece's audio tracks. Renders nothing
 * when there's no audio attached, so a piece with only sheet music is
 * unaffected.
 *
 * Includes a track picker (defaults to the first audio file), play/pause +
 * scrub, mm:ss time display, tempo slowdown that preserves pitch
 * (audio.preservesPitch = true), and a loop A/B for drilling on bars.
 */
export function AudioPlayer({ pieceId, refreshTick = 0 }: AudioPlayerProps) {
  const { piece } = usePiece(pieceId, refreshTick);
  const audioFiles = useMemo(() => piece?.files.filter((f) => f.kind === 'audio') ?? [], [piece]);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  // Auto-pick the first track when piece changes / tracks first appear.
  const effectiveId = selectedId ?? audioFiles[0]?.id ?? null;
  const current = audioFiles.find((f) => f.id === effectiveId) ?? null;

  const player = useAudioPlayer(current?.url ?? null);

  if (audioFiles.length === 0) return null;

  const ratePct = Math.round(player.rate * 100);

  return (
    <div className="border-t border-border bg-background/95 backdrop-blur px-4 py-2">
      <audio ref={player.audioRef} src={current?.url ?? undefined} preload="metadata" crossOrigin="anonymous" />

      <div className="flex flex-wrap items-center gap-3 text-xs">
        {/* Track picker */}
        <select
          value={effectiveId ?? ''}
          onChange={(e) => setSelectedId(Number(e.target.value))}
          className="h-8 px-2 rounded-md border border-border bg-background text-sm min-w-44"
        >
          {audioFiles.map((f) => (
            <option key={f.id} value={f.id}>
              {f.label?.trim() || f.filename}
            </option>
          ))}
        </select>

        {/* Transport */}
        <button
          type="button"
          onClick={player.toggle}
          aria-label={player.isPlaying ? 'Pause' : 'Play'}
          className="inline-flex items-center justify-center w-9 h-9 rounded-full bg-primary text-primary-foreground hover:opacity-90"
        >
          {player.isPlaying ? <PauseIcon /> : <PlayIcon />}
        </button>

        {/* Scrubber */}
        <div className="flex items-center gap-2 flex-1 min-w-48">
          <span className="tabular-nums text-muted-foreground w-10 text-right">
            {formatTime(player.currentTime)}
          </span>
          <input
            type="range"
            min={0}
            max={Number.isFinite(player.duration) ? player.duration : 1}
            step={0.1}
            value={player.currentTime}
            onChange={(e) => player.seek(Number(e.target.value))}
            disabled={!Number.isFinite(player.duration)}
            className="flex-1 accent-primary"
          />
          <span className="tabular-nums text-muted-foreground w-10">{formatTime(player.duration)}</span>
        </div>

        {/* Tempo */}
        <div className="flex items-center gap-2">
          <label className="text-muted-foreground select-none">Speed</label>
          <input
            type="range"
            min={0.5}
            max={1.25}
            step={0.05}
            value={player.rate}
            onChange={(e) => player.setRate(Number(e.target.value))}
            className="w-24 accent-primary"
          />
          <span className="tabular-nums w-10 text-right">{ratePct}%</span>
          {RATE_PRESETS.includes(player.rate as typeof RATE_PRESETS[number]) ? null : (
            <Button size="sm" variant="ghost" onClick={() => player.setRate(1.0)} className="h-6 px-2">
              reset
            </Button>
          )}
        </div>

        {/* Loop A/B */}
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant={player.loop.start !== null ? 'default' : 'outline'}
            onClick={player.setLoopStart}
            title={player.loop.start !== null ? `A at ${formatTime(player.loop.start)}` : 'Set loop A at current time'}
            className="h-7"
          >
            {player.loop.start !== null ? `A ${formatTime(player.loop.start)}` : 'Set A'}
          </Button>
          <Button
            size="sm"
            variant={player.loop.end !== null ? 'default' : 'outline'}
            onClick={player.setLoopEnd}
            title={player.loop.end !== null ? `B at ${formatTime(player.loop.end)}` : 'Set loop B at current time'}
            className="h-7"
          >
            {player.loop.end !== null ? `B ${formatTime(player.loop.end)}` : 'Set B'}
          </Button>
          {(player.loop.start !== null || player.loop.end !== null) && (
            <Button size="sm" variant="ghost" onClick={player.clearLoop} className="h-7 px-2">
              clear
            </Button>
          )}
        </div>
      </div>

      {player.error && (
        <div className={cn('mt-1 text-xs text-destructive')}>Audio: {player.error}</div>
      )}
    </div>
  );
}

function PlayIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <rect x="6" y="5" width="4" height="14" rx="1" />
      <rect x="14" y="5" width="4" height="14" rx="1" />
    </svg>
  );
}
