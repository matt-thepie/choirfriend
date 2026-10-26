/**
 * Web Audio piano. Plays Salamander Grand Piano samples (Alexander Holm,
 * CC BY 3.0; the mp3 set from tonejs/audio) self-hosted under
 * /piano/*.mp3 at minor-third spacing, pitch-shifted to the nearest
 * sampled note. Polyphonic — multiple keys can be held at once.
 *
 * Samples are fetched lazily the first time the piano is used (~2 MB in
 * total). Until a note's sample has decoded, a triangle-wave oscillator
 * stands in so the first key press still makes a sound.
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
  osc: OscillatorNode | AudioBufferSourceNode;
  gain: GainNode;
}

const ATTACK_S = 0.008;
const RELEASE_S = 0.25;
const PEAK_GAIN = 0.22;
const SAMPLE_GAIN = 0.9;
const SAMPLE_RELEASE_S = 0.4;

/** Sampled notes: A, C, D# and F# of each octave, as MIDI numbers → file stem. */
const SAMPLE_NOTES: { midi: number; name: string }[] = [];
for (let octave = 0; octave <= 8; octave++) {
  for (const [pc, stem] of [[0, 'C'], [3, 'Ds'], [6, 'Fs'], [9, 'A']] as const) {
    const midi = (octave + 1) * 12 + pc;
    if (midi < 21 || midi > 108) continue; // A0..C8
    SAMPLE_NOTES.push({ midi, name: `${stem}${octave}` });
  }
}

const bufferCache = new Map<string, Promise<AudioBuffer>>();

function loadSample(ctx: AudioContext, name: string): Promise<AudioBuffer> {
  let p = bufferCache.get(name);
  if (!p) {
    p = fetch(`/piano/${name}.mp3`)
      .then((r) => {
        if (!r.ok) throw new Error(`piano sample ${name}: ${r.status}`);
        return r.arrayBuffer();
      })
      .then((ab) => ctx.decodeAudioData(ab));
    p.catch(() => bufferCache.delete(name));
    bufferCache.set(name, p);
  }
  return p;
}

/** Already-decoded buffer for a sample, or null if still loading. */
const decoded = new Map<string, AudioBuffer>();

function nearestSample(midi: number): { midi: number; name: string } {
  let best = SAMPLE_NOTES[0];
  for (const s of SAMPLE_NOTES) if (Math.abs(s.midi - midi) < Math.abs(best.midi - midi)) best = s;
  return best;
}

/** Kick off loading every sample; resolves when all are decoded. */
function preloadAll(ctx: AudioContext): void {
  for (const s of SAMPLE_NOTES) {
    void loadSample(ctx, s.name).then((buf) => decoded.set(s.name, buf)).catch(() => undefined);
  }
}

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
      preloadAll(ctx);
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

    const gain = ctx.createGain();
    gain.connect(master);
    const now = ctx.currentTime;
    const sample = nearestSample(midi);
    const buf = decoded.get(sample.name);
    let osc: OscillatorNode | AudioBufferSourceNode;
    if (buf) {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = Math.pow(2, (midi - sample.midi) / 12);
      gain.gain.setValueAtTime(SAMPLE_GAIN, now);
      osc = src;
    } else {
      // Sample not decoded yet: triangle stand-in with a short attack.
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = midiToFreq(midi);
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(PEAK_GAIN, now + ATTACK_S);
      osc = o;
    }
    osc.connect(gain);
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
  const release = voice.osc instanceof OscillatorNode ? RELEASE_S : SAMPLE_RELEASE_S;
  voice.gain.gain.exponentialRampToValueAtTime(0.0001, now + release);
  voice.osc.stop(now + release + 0.01);
}
