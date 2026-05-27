/**
 * Bare Web Audio piano. Triangle-wave oscillators with an attack/release
 * envelope per active note. Polyphonic — multiple keys can be held at once.
 *
 * Deliberately no Tone.js / SoundFont / sample library: the purpose is
 * notebashing (let a chorister hear pitch when they're lost in a part),
 * not realistic timbre. A 3-line oscillator gets there with zero kB of
 * dependency.
 *
 * AudioContext is lazy-instantiated on first user gesture so we don't
 * trip the browser's autoplay restrictions.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

/** Standard MIDI note → frequency in Hz, A4 = 440. */
export function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

interface Voice {
  osc: OscillatorNode;
  gain: GainNode;
}

const ATTACK_S = 0.008;
const RELEASE_S = 0.25;
const PEAK_GAIN = 0.22;

export interface UsePianoResult {
  noteOn: (midi: number) => void;
  noteOff: (midi: number) => void;
  /** Currently held note set, mostly for visual highlight on the keyboard. */
  activeNotes: ReadonlySet<number>;
  /** True once the AudioContext has been resumed by a user gesture. */
  ready: boolean;
}

export function usePiano(): UsePianoResult {
  const ctxRef = useRef<AudioContext | null>(null);
  const masterRef = useRef<GainNode | null>(null);
  const voicesRef = useRef<Map<number, Voice>>(new Map());
  const [activeNotes, setActiveNotes] = useState<Set<number>>(new Set());
  const [ready, setReady] = useState(false);

  /** Get-or-create the AudioContext + master gain. Called from user gestures. */
  function ensureCtx(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    if (!ctxRef.current) {
      const ctx = new AC();
      const master = ctx.createGain();
      // Light master to leave headroom for several simultaneous notes.
      master.gain.value = 0.6;
      master.connect(ctx.destination);
      ctxRef.current = ctx;
      masterRef.current = master;
    }
    if (ctxRef.current.state === 'suspended') {
      void ctxRef.current.resume().then(() => setReady(true));
    } else {
      setReady(true);
    }
    return ctxRef.current;
  }

  const noteOn = useCallback((midi: number): void => {
    const ctx = ensureCtx();
    const master = masterRef.current;
    if (!ctx || !master) return;

    // If this note is already sounding (e.g. a quick re-trigger), release the
    // existing voice first so we don't pile up oscillators.
    const existing = voicesRef.current.get(midi);
    if (existing) {
      releaseVoice(existing, ctx);
      voicesRef.current.delete(midi);
    }

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = midiToFreq(midi);

    osc.connect(gain);
    gain.connect(master);

    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(PEAK_GAIN, now + ATTACK_S);

    osc.start(now);

    voicesRef.current.set(midi, { osc, gain });
    setActiveNotes((prev) => {
      const next = new Set(prev);
      next.add(midi);
      return next;
    });
  }, []);

  const noteOff = useCallback((midi: number): void => {
    const ctx = ctxRef.current;
    const voice = voicesRef.current.get(midi);
    if (!ctx || !voice) return;
    releaseVoice(voice, ctx);
    voicesRef.current.delete(midi);
    setActiveNotes((prev) => {
      if (!prev.has(midi)) return prev;
      const next = new Set(prev);
      next.delete(midi);
      return next;
    });
  }, []);

  // Make sure any held notes don't keep playing after the component unmounts.
  useEffect(() => {
    const voices = voicesRef.current;
    return () => {
      const ctx = ctxRef.current;
      if (!ctx) return;
      for (const voice of voices.values()) releaseVoice(voice, ctx);
      voices.clear();
    };
  }, []);

  return { noteOn, noteOff, activeNotes, ready };
}

function releaseVoice(voice: Voice, ctx: AudioContext): void {
  const now = ctx.currentTime;
  // Take the current gain value (mid-attack OK) and ramp down from there to
  // avoid clicks.
  const currentGain = voice.gain.gain.value;
  voice.gain.gain.cancelScheduledValues(now);
  voice.gain.gain.setValueAtTime(currentGain, now);
  voice.gain.gain.exponentialRampToValueAtTime(0.0001, now + RELEASE_S);
  voice.osc.stop(now + RELEASE_S + 0.01);
}
