import { useState } from 'react';
import { Button, Icon, IconButton } from '@/components/ui/button.tsx';
import { cn } from '@/lib/utils.ts';
import { ToolButton } from '@/components/PdfViewer/PdfViewer.tsx';
import type { MixMode } from '@/lib/flowing/playback.ts';
import { SOUNDS, type SoundId } from '@/lib/flowing/sampler.ts';

/** 0.5x to 1.5x of the marked tempo, as the recording player offers. */
const RATES = Array.from({ length: 11 }, (_, i) => Math.round((0.5 + i * 0.1) * 10) / 10);

export interface FlowBarProps {
  title: string;
  playState: 'stopped' | 'loading' | 'playing' | 'error';
  canPlay: boolean;
  onToggle: () => void;
  /** Bar labels as printed, one per bar in played order (repeats unrolled). */
  bars: string[];
  /** Bar labels as printed, by written bar, for the loop. */
  writtenBars: string[];
  /** The step in played order sounding now, or where Play will start. */
  bar: number;
  onSeek: (step: number) => void;
  bpm: number;
  markedBpm: number;
  hasMarkedTempo: boolean;
  laterTempo: number | null;
  currentBpm: number;
  onBpm: (bpm: number) => void;
  onResetBpm: () => void;
  loop: { start: number | null; end: number | null };
  onLoopStart: () => void;
  onLoopEnd: () => void;
  onClearLoop: () => void;
  lineChoices: { id: number; label: string; mine: boolean }[];
  lineSectionId: number | null;
  onLine: (id: number | null) => void;
  lineLabel: string | null;
  mixMode: MixMode;
  onMixMode: (m: MixMode) => void;
  sound: SoundId;
  onSound: (s: SoundId) => void;
  /** The headphones button, to swap to a recording. */
  listen?: React.ReactNode;
  /** Stop and put the bar away. */
  onClose: () => void;
}

/**
 * The flowing score's player, docked at the bottom like the recording player
 * and laid out the same: seek bar along the top edge (by bar), title, speed,
 * back to start, a bar back, play, a bar on, and the panel above it for the
 * rest: tempo, the part brought forward, the sound, and looping bars.
 */
export function FlowBar(p: FlowBarProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<number | null>(null);
  const last = Math.max(0, p.bars.length - 1);
  const shown = draft ?? p.bar;
  const busy = p.playState === 'playing' || p.playState === 'loading';
  const rate = Math.round((p.bpm / p.markedBpm) * 100) / 100;
  const commit = () => {
    if (draft !== null) p.onSeek(draft);
    setDraft(null);
  };
  const barLabel = (i: number | null) => (i === null ? '' : p.bars[i] ?? String(i + 1));
  const writtenLabel = (i: number | null) => (i === null ? '' : p.writtenBars[i] ?? String(i + 1));
  const soundLabel = SOUNDS.find((s) => s.id === p.sound)?.label ?? '';
  const looping = p.loop.start !== null && p.loop.end !== null;

  return (
    <div className="shrink-0 sm:px-4 sm:pb-3 bg-stage">
      <div className="bg-background text-foreground shadow-float sm:rounded-lg overflow-hidden relative max-w-(--max) mx-auto">
        <input
          type="range"
          min={0}
          max={last}
          step={1}
          value={Math.min(shown, last)}
          onChange={(e) => setDraft(Number(e.target.value))}
          onPointerUp={commit}
          onKeyUp={commit}
          onBlur={commit}
          disabled={!p.canPlay || p.bars.length < 2}
          className="seek absolute top-0 inset-x-0 h-3 w-full appearance-none bg-transparent cursor-pointer"
          aria-label="Bar"
          aria-valuetext={`Bar ${barLabel(shown)}`}
        />

        {open && (
          <div className="px-4 pt-5 pb-3 border-b border-border max-h-[50dvh] overflow-auto flex flex-col gap-4 text-sm">
            <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
              <div className="flex items-center gap-1" title={p.hasMarkedTempo ? 'Tempo (the score’s marking, adjusted)' : 'Starting tempo (no initial fixed tempo marking)'}>
                <span className="text-muted-foreground mr-1">Starting tempo</span>
                <Button size="sm" variant="outline" onClick={() => p.onBpm(p.bpm - 2)} aria-label="Slower">−</Button>
                <span className="tabular-nums w-16 text-center">♩ = {p.bpm}</span>
                <Button size="sm" variant="outline" onClick={() => p.onBpm(p.bpm + 2)} aria-label="Faster">+</Button>
                {p.bpm !== Math.round(p.markedBpm) && (
                  <Button size="sm" variant="ghost" onClick={p.onResetBpm}>
                    {p.hasMarkedTempo ? `Marked (${Math.round(p.markedBpm)})` : 'Reset'}
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {p.hasMarkedTempo ? `Initial marking: ♩ = ${p.markedBpm}.` : p.laterTempo !== null ? `No initial fixed tempo; introduction defaults to ♩ = 120. Later marking: ♩ = ${p.laterTempo}.` : 'No fixed tempo markings; playback defaults to ♩ = 120.'}
                {' '}Current playback tempo: ♩ = {p.currentBpm}. Speed changes scale subsequent markings too.
              </p>
              <div className="flex items-center gap-1">
                <span className="text-muted-foreground mr-1">Loop bars</span>
                <Button size="sm" variant={p.loop.start !== null ? 'default' : 'outline'} onClick={p.onLoopStart} title="Loop from the current bar">
                  {p.loop.start !== null ? `From ${writtenLabel(p.loop.start)}` : 'Set start'}
                </Button>
                <Button size="sm" variant={p.loop.end !== null ? 'default' : 'outline'} onClick={p.onLoopEnd} title="Loop to the end of the current bar">
                  {p.loop.end !== null ? `To ${writtenLabel(p.loop.end)}` : 'Set end'}
                </Button>
                {(p.loop.start !== null || p.loop.end !== null) && (
                  <Button size="sm" variant="ghost" onClick={p.onClearLoop}>Clear</Button>
                )}
              </div>
            </div>

            <div className="flex flex-wrap items-start gap-x-5 gap-y-3">
              <label className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">Part to bring forward</span>
                <select
                  value={p.lineSectionId ?? ''}
                  onChange={(e) => p.onLine(e.target.value === '' ? null : Number(e.target.value))}
                  className="h-10 rounded-md border border-border bg-background px-2"
                >
                  <option value="">None: every part equally</option>
                  {p.lineChoices.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                      {s.mine ? ' (you)' : ''}
                    </option>
                  ))}
                </select>
              </label>
              {p.lineLabel && (
                <div className="flex flex-col gap-1">
                  <span className="text-xs text-muted-foreground">The other parts</span>
                  <div className="flex items-center rounded-md border border-border overflow-hidden" role="group" aria-label="How the other parts sound">
                    <ToolButton active={p.mixMode !== 'solo'} onClick={() => p.onMixMode('mine')} title="Your part loud, the others quietly behind it">
                      Quieter
                    </ToolButton>
                    <ToolButton active={p.mixMode === 'solo'} onClick={() => p.onMixMode('solo')} title="Only this part">
                      Silent
                    </ToolButton>
                  </div>
                </div>
              )}
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">Sound</span>
                <div className="flex items-center rounded-md border border-border overflow-hidden">
                  {SOUNDS.map((s) => (
                    <ToolButton key={s.id} active={p.sound === s.id} onClick={() => p.onSound(s.id)}>
                      {s.label}
                    </ToolButton>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="h-[72px] px-3 sm:px-4 flex items-center gap-1 sm:gap-2">
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="flex-1 min-w-0 text-left h-full"
            aria-expanded={open}
            title={open ? 'Hide playback settings' : 'Tempo, part, sound and looping'}
          >
            <div className="text-base font-semibold truncate">{p.title}</div>
            <div className="text-sm text-muted-foreground truncate">
              {p.lineLabel ? `${p.lineLabel} ${p.mixMode === 'solo' ? 'only' : 'forward'}` : 'All parts'} · {soundLabel}
              {p.playState === 'error' && <span className="ml-1.5 text-destructive">· couldn’t play</span>}
            </div>
            <div className="text-xs text-muted-foreground tabular-nums truncate">
              Bar {barLabel(shown)}{p.bars.length ? ` / ${p.bars[last]}` : ''} · ♩ = {p.currentBpm}
              {looping && <span className="ml-1.5 text-primary">· loop {writtenLabel(p.loop.start)}–{writtenLabel(p.loop.end)}</span>}
            </div>
          </button>

          <select
            value={RATES.includes(rate) ? rate : 'custom'}
            onChange={(e) => p.onBpm(p.markedBpm * Number(e.target.value))}
            aria-label="Playback speed"
            title={`Speed (♩ = ${p.bpm})`}
            className={cn(
              'h-9 w-[3.75rem] px-1.5 rounded-full border text-sm font-semibold tabular-nums text-center shrink-0 appearance-none cursor-pointer',
              rate !== 1 ? 'border-primary bg-accent text-accent-foreground' : 'border-border bg-background',
            )}
          >
            {!RATES.includes(rate) && <option value="custom" disabled>{rate}x</option>}
            {RATES.map((r) => (
              <option key={r} value={r}>{r}x</option>
            ))}
          </select>
          <IconButton icon="first_page" label="Back to the start" size="sm" onClick={() => p.onSeek(p.loop.start ?? 0)} disabled={!p.canPlay} className="hidden sm:inline-flex" />
          <IconButton icon="fast_rewind" label="Back a bar" size="sm" onClick={() => p.onSeek(Math.max(0, p.bar - 1))} disabled={!p.canPlay || p.bar <= 0} />
          <button
            type="button"
            onClick={p.onToggle}
            disabled={!p.canPlay}
            aria-label={busy ? 'Pause' : `Play from bar ${barLabel(p.bar)}`}
            className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-primary text-primary-foreground hover:bg-primary-hover active:bg-primary-active shadow-card shrink-0 disabled:opacity-50"
          >
            {p.playState === 'loading' ? (
              <svg className="animate-spin h-6 w-6" viewBox="0 0 24 24" fill="none" aria-hidden>
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.3" />
                <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
              </svg>
            ) : (
              <Icon name={busy ? 'pause' : 'play_arrow'} filled className="text-3xl" />
            )}
          </button>
          <IconButton icon="fast_forward" label="On a bar" size="sm" onClick={() => p.onSeek(Math.min(last, p.bar + 1))} disabled={!p.canPlay || p.bar >= last} />
          <IconButton
            icon="repeat"
            label={looping ? 'Stop looping' : 'Loop bars (set in the panel)'}
            size="sm"
            onClick={() => (looping ? p.onClearLoop() : setOpen(true))}
            className={cn('hidden sm:inline-flex', looping && 'text-primary')}
          />
          {p.listen && <div className="hidden sm:block">{p.listen}</div>}
          <IconButton icon={open ? 'expand_more' : 'expand_less'} label={open ? 'Hide playback settings' : 'Playback settings'} size="sm" onClick={() => setOpen((o) => !o)} />
          <IconButton icon="close" label="Stop and close the player" size="sm" onClick={p.onClose} />
        </div>
      </div>
    </div>
  );
}
