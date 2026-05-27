import { useRef, useState } from 'react';
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

const OCTAVE_RANGE_LOW = 2; // MIDI octave 2 → starts at C2 (very low)
const OCTAVE_RANGE_HIGH = 7; // starts at C7
const DEFAULT_BOTTOM_OCTAVE = 4; // C4 (middle C is C4 → MIDI 60)

/** Width of a white key in px. Black keys are 60% of this. */
const WHITE_WIDTH = 36;
const WHITE_HEIGHT = 110;
const BLACK_WIDTH = Math.round(WHITE_WIDTH * 0.6);
const BLACK_HEIGHT = Math.round(WHITE_HEIGHT * 0.62);

export function Piano({ onClose }: PianoProps) {
  const { noteOn, noteOff, activeNotes, ready } = usePiano();
  // Bottom MIDI note of the lowest visible octave. Two octaves shown at once.
  const [bottomOctave, setBottomOctave] = useState(DEFAULT_BOTTOM_OCTAVE);

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

  // Build two octaves' worth of keys.
  for (let octaveOffset = 0; octaveOffset < 2; octaveOffset++) {
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
        <span className="text-xs text-muted-foreground">A4 = 440 · click or touch keys</span>
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
          <span className="text-xs tabular-nums w-16 text-center">
            C{bottomOctave} – B{bottomOctave + 1}
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setBottomOctave((o) => Math.min(OCTAVE_RANGE_HIGH - 1, o + 1))}
            disabled={bottomOctave + 1 >= OCTAVE_RANGE_HIGH}
            aria-label="Shift up one octave"
          >
            Octave ▶
          </Button>
          {!ready && <span className="text-xs text-muted-foreground">tap any key to enable audio</span>}
          {onClose && (
            <Button size="sm" variant="ghost" onClick={onClose} aria-label="Close piano">
              ✕
            </Button>
          )}
        </div>
      </div>

      <div className="overflow-x-auto">
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
                  <span className="absolute bottom-1 left-0 right-0 text-center text-[10px] text-muted-foreground pointer-events-none">
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
