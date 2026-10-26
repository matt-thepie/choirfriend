import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button.tsx';
import { cn } from '@/lib/utils.ts';
import { usePiano } from '@/hooks/usePiano.ts';

/**
 * Two-octave piano for notebashing. White keys in a flex row, black keys
 * absolutely positioned over the gaps between specific whites.
 *
 * Pointer events handle press / release / leave-while-held so dragging off
 * a key doesn't leave the note hanging. Multiple keys can be held at once
 * — useful for double-checking an interval.
 *
 * The full keyboard isn't visible at once on a phone; the octave shift
 * buttons let you slide the visible range without breaking interaction.
 */

const NOTE_NAMES_SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

function isBlack(midi: number): boolean {
  const pc = ((midi % 12) + 12) % 12;
  return pc === 1 || pc === 3 || pc === 6 || pc === 8 || pc === 10;
}

function noteName(midi: number): string {
  const pc = ((midi % 12) + 12) % 12;
  const octave = Math.floor(midi / 12) - 1; // MIDI 60 = C4
  return `${NOTE_NAMES_SHARP[pc]}${octave}`;
}

interface PianoProps {
  onClose?: () => void;
}

const OCTAVE_RANGE_LOW = 1; // lowest visible octave starts at C1
const OCTAVE_RANGE_HIGH = 8; // keyboard never extends past C8
const DEFAULT_BOTTOM_OCTAVE = 4; // C4 (middle C is C4 → MIDI 60)
const MIN_OCTAVES = 2;
const MAX_OCTAVES = 5;

/** Width of a white key in px. Black keys are 60% of this. */
const WHITE_WIDTH = 36;
const WHITE_HEIGHT = 110;
const BLACK_WIDTH = Math.round(WHITE_WIDTH * 0.6);
const BLACK_HEIGHT = Math.round(WHITE_HEIGHT * 0.62);

export function Piano({ onClose }: PianoProps) {
  const { noteOn, noteOff, activeNotes, ready } = usePiano();
  // Bottom MIDI note of the lowest visible octave.
  const [bottomOctave, setBottomOctave] = useState(DEFAULT_BOTTOM_OCTAVE);
  // How many octaves fit: as many as the container is wide for, 2 on a
  // phone, up to 5 on a desktop. Centred on middle C when there is room.
  const wrapRef = useRef<HTMLDivElement>(null);
  const [octaves, setOctaves] = useState(MIN_OCTAVES);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => {
      const fit = Math.floor(el.clientWidth / (7 * WHITE_WIDTH));
      const n = Math.max(MIN_OCTAVES, Math.min(MAX_OCTAVES, fit));
      setOctaves(n);
      // Keep middle C in view: bottom octave shifts down as more octaves fit.
      setBottomOctave((b) => (b === DEFAULT_BOTTOM_OCTAVE || b === DEFAULT_BOTTOM_OCTAVE - Math.floor((n - 2) / 2) ? DEFAULT_BOTTOM_OCTAVE - Math.floor((n - 2) / 2) : Math.min(b, OCTAVE_RANGE_HIGH - n)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Track which pointer is holding which note so a lifted pointer always
  // releases the note it started on, even if it slid to a different key.
  const pointerNoteRef = useRef<Map<number, number>>(new Map());

  function startNote(midi: number, pointerId: number): void {
    pointerNoteRef.current.set(pointerId, midi);
    noteOn(midi);
  }
  function endNote(pointerId: number): void {
    const midi = pointerNoteRef.current.get(pointerId);
    if (midi === undefined) return;
    pointerNoteRef.current.delete(pointerId);
    noteOff(midi);
  }

  const startMidi = bottomOctave * 12 + 12; // MIDI for C{bottomOctave}
  const whiteKeys: number[] = [];
  const blackKeys: { midi: number; leftWhiteIndex: number }[] = [];

  // Build the visible octaves' worth of keys.
  for (let octaveOffset = 0; octaveOffset < octaves; octaveOffset++) {
    const octaveStart = startMidi + octaveOffset * 12;
    let whiteIndexInOctave = 0;
    for (let semitone = 0; semitone < 12; semitone++) {
      const midi = octaveStart + semitone;
      if (isBlack(midi)) {
        // Black key sits just to the right of the previous white key.
        blackKeys.push({
          midi,
          leftWhiteIndex: whiteKeys.length - 1 + octaveOffset * 0, // adjust below
        });
      } else {
        whiteKeys.push(midi);
        whiteIndexInOctave++;
      }
    }
    void whiteIndexInOctave;
  }

  // Recompute black-key positions cleanly: each black key sits between
  // two specific white keys; place it centered on the right edge of the
  // white key that precedes it within the octave.
  const blackKeyEntries = blackKeys.map((bk) => {
    // White keys lower than bk.midi:
    const whiteIndex = whiteKeys.findIndex((m) => m > bk.midi) - 1;
    const leftPx = (whiteIndex + 1) * WHITE_WIDTH - BLACK_WIDTH / 2;
    return { midi: bk.midi, leftPx };
  });

  const totalWidth = whiteKeys.length * WHITE_WIDTH;

  return (
    <div className="border-t border-border bg-background/95 backdrop-blur px-4 py-2 select-none">
      <div className="flex items-center gap-3 mb-2">
        <span className="text-sm font-semibold">Piano</span>
        <span className="text-xs text-muted-foreground hidden md:inline whitespace-nowrap">A4 = 440 · click or touch keys</span>
        <div className="ml-auto flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setBottomOctave((o) => Math.max(OCTAVE_RANGE_LOW, o - 1))}
            disabled={bottomOctave <= OCTAVE_RANGE_LOW}
            aria-label="Shift down one octave"
          >
            ◀ Octave
          </Button>
          <span className="text-xs tabular-nums w-16 text-center whitespace-nowrap">
            C{bottomOctave} – B{bottomOctave + octaves - 1}
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setBottomOctave((o) => Math.min(OCTAVE_RANGE_HIGH - octaves, o + 1))}
            disabled={bottomOctave + octaves >= OCTAVE_RANGE_HIGH}
            aria-label="Shift up one octave"
          >
            Octave ▶
          </Button>
          {!ready && <span className="text-xs text-muted-foreground hidden md:inline whitespace-nowrap">tap any key to enable audio</span>}
          {onClose && (
            <Button size="sm" variant="ghost" onClick={onClose} aria-label="Close piano">
              ✕
            </Button>
          )}
        </div>
      </div>

      <div className="overflow-x-auto" ref={wrapRef}>
        <div
          className="relative inline-block"
          style={{ width: totalWidth, height: WHITE_HEIGHT, touchAction: 'none' }}
        >
          {whiteKeys.map((midi, i) => {
            const active = activeNotes.has(midi);
            const isC = ((midi % 12) + 12) % 12 === 0;
            return (
              <button
                key={midi}
                type="button"
                aria-label={noteName(midi)}
                className={cn(
                  'absolute top-0 border border-slate-300 rounded-b-sm',
                  active ? 'bg-amber-200' : 'bg-white hover:bg-slate-50',
                )}
                style={{
                  left: i * WHITE_WIDTH,
                  width: WHITE_WIDTH,
                  height: WHITE_HEIGHT,
                }}
                onPointerDown={(e) => {
                  (e.target as Element).setPointerCapture(e.pointerId);
                  startNote(midi, e.pointerId);
                }}
                onPointerUp={(e) => endNote(e.pointerId)}
                onPointerCancel={(e) => endNote(e.pointerId)}
                onPointerLeave={(e) => endNote(e.pointerId)}
              >
                {isC && (
                  <span className="absolute bottom-1 left-0 right-0 text-center text-xs text-muted-foreground pointer-events-none">
                    {noteName(midi)}
                  </span>
                )}
              </button>
            );
          })}
          {blackKeyEntries.map(({ midi, leftPx }) => {
            const active = activeNotes.has(midi);
            return (
              <button
                key={midi}
                type="button"
                aria-label={noteName(midi)}
                className={cn(
                  'absolute top-0 rounded-b-sm shadow-sm',
                  active ? 'bg-amber-700' : 'bg-slate-900 hover:bg-slate-700',
                )}
                style={{
                  left: leftPx,
                  width: BLACK_WIDTH,
                  height: BLACK_HEIGHT,
                  zIndex: 1,
                }}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  (e.target as Element).setPointerCapture(e.pointerId);
                  startNote(midi, e.pointerId);
                }}
                onPointerUp={(e) => endNote(e.pointerId)}
                onPointerCancel={(e) => endNote(e.pointerId)}
                onPointerLeave={(e) => endNote(e.pointerId)}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
