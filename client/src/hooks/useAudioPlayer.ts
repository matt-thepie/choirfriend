/**
 * Thin wrapper around an HTMLAudioElement: exposes play/pause/seek/rate
 * state as React state, plus an A/B loop.
 *
 * Pitch-preserving tempo slowdown comes for free from `audio.preservesPitch
 * = true` (supported in every shipping browser as of 2026). No Web Audio,
 * no SoundTouch, no AudioWorklet — the browser does it for us.
 *
 * Loop logic lives in the `timeupdate` handler: if both A and B are set and
 * currentTime >= B, jump back to A. We keep the loop in a ref so changing
 * it doesn't re-bind every listener.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export interface LoopRegion {
  start: number | null;
  end: number | null;
}

export interface UseAudioPlayerResult {
  audioRef: React.RefObject<HTMLAudioElement | null>;
  isPlaying: boolean;
  /** Seconds. */
  currentTime: number;
  /** Seconds; NaN until metadata loads. */
  duration: number;
  rate: number;
  loop: LoopRegion;
  error: string | null;
  toggle: () => void;
  seek: (t: number) => void;
  setRate: (rate: number) => void;
  /** Marks the current position as the loop start. Auto-orders A < B. */
  setLoopStart: () => void;
  setLoopEnd: () => void;
  clearLoop: () => void;
}

export function useAudioPlayer(src: string | null): UseAudioPlayerResult {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(NaN);
  const [rate, setRateState] = useState(1.0);
  const [loop, setLoop] = useState<LoopRegion>({ start: null, end: null });
  const [error, setError] = useState<string | null>(null);

  // Keep latest loop in a ref so the timeupdate handler always sees fresh
  // values without re-binding listeners.
  const loopRef = useRef(loop);
  useEffect(() => {
    loopRef.current = loop;
  }, [loop]);

  // Reset transient state when the source changes.
  useEffect(() => {
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(NaN);
    setLoop({ start: null, end: null });
    setError(null);
  }, [src]);

  // Apply rate + preservesPitch whenever rate or source changes.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.preservesPitch = true;
    audio.playbackRate = rate;
  }, [rate, src]);

  // Bind listeners once on mount.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    function handlePlay(): void {
      setIsPlaying(true);
    }
    function handlePause(): void {
      setIsPlaying(false);
    }
    function handleTimeUpdate(): void {
      const t = audio!.currentTime;
      setCurrentTime(t);
      const l = loopRef.current;
      if (l.start !== null && l.end !== null && t >= l.end) {
        audio!.currentTime = l.start;
      }
    }
    function handleLoadedMetadata(): void {
      setDuration(audio!.duration);
    }
    function handleEnded(): void {
      setIsPlaying(false);
    }
    function handleError(): void {
      const code = audio!.error?.code;
      const message =
        code === 4 ? 'audio format not supported or file missing' :
        code === 2 ? 'network error' :
        code === 3 ? 'decode failed' :
        'audio error';
      setError(message);
      setIsPlaying(false);
    }

    audio.addEventListener('play', handlePlay);
    audio.addEventListener('pause', handlePause);
    audio.addEventListener('timeupdate', handleTimeUpdate);
    audio.addEventListener('loadedmetadata', handleLoadedMetadata);
    audio.addEventListener('ended', handleEnded);
    audio.addEventListener('error', handleError);

    return () => {
      audio.removeEventListener('play', handlePlay);
      audio.removeEventListener('pause', handlePause);
      audio.removeEventListener('timeupdate', handleTimeUpdate);
      audio.removeEventListener('loadedmetadata', handleLoadedMetadata);
      audio.removeEventListener('ended', handleEnded);
      audio.removeEventListener('error', handleError);
    };
  }, []);

  const toggle = useCallback((): void => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) {
      void a.play().catch((e) => setError(e instanceof Error ? e.message : String(e)));
    } else {
      a.pause();
    }
  }, []);

  const seek = useCallback((t: number): void => {
    const a = audioRef.current;
    if (!a) return;
    a.currentTime = Math.max(0, Number.isFinite(a.duration) ? Math.min(t, a.duration) : t);
  }, []);

  const setRate = useCallback((r: number): void => {
    setRateState(r);
  }, []);

  const setLoopStart = useCallback((): void => {
    setLoop((l) => {
      const start = audioRef.current?.currentTime ?? 0;
      // If end is set and would now be < start, push it back to null so the
      // user re-picks. Avoids "loop goes backwards" surprises.
      const end = l.end !== null && l.end <= start ? null : l.end;
      return { start, end };
    });
  }, []);

  const setLoopEnd = useCallback((): void => {
    setLoop((l) => {
      const end = audioRef.current?.currentTime ?? 0;
      // Same protection: if start hasn't been set or is after end, clear it.
      const start = l.start !== null && l.start >= end ? null : l.start;
      return { start, end };
    });
  }, []);

  const clearLoop = useCallback((): void => {
    setLoop({ start: null, end: null });
  }, []);

  return {
    audioRef,
    isPlaying,
    currentTime,
    duration,
    rate,
    loop,
    error,
    toggle,
    seek,
    setRate,
    setLoopStart,
    setLoopEnd,
    clearLoop,
  };
}

/** mm:ss formatting; "—:—" for NaN. */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return '—:—';
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}
