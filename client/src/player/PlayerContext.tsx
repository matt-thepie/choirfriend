/**
 * App-wide practice player.
 *
 * One <audio> element lives here for the whole session, so playback keeps
 * going while the member navigates between the song list, a set list and a
 * score. Everything else (the bottom bar, the piece-page track strip, the
 * set list "play" tile) talks to it through usePlayer().
 *
 * The player plays a *queue*: a named, ordered list of tracks. A queue can
 * be one song's tracks, a set list resolved to one track per song for a
 * section, or (later) a personal practice list.
 *
 * Media Session hooks the lock-screen / headphone controls, which matters on
 * phones at rehearsal. Tempo change keeps pitch (audio.preservesPitch).
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

export interface QueueTrack {
  /** files.id — used as the React key and to highlight the playing track. */
  fileId: number;
  url: string;
  /** Primary line: the track name (label or filename). */
  title: string;
  /** Secondary line: song title, plus composer when known. */
  subtitle: string;
  pieceId: number;
  pieceTitle: string;
  sectionId: number | null;
}

export interface Queue {
  /** Shown in the player, e.g. "Rehearsal · Tenor 2" or a song title. */
  name: string;
  tracks: QueueTrack[];
}

export type RepeatMode = 'off' | 'all' | 'one';

export interface LoopRegion {
  start: number | null;
  end: number | null;
}

export interface PlayerState {
  queue: Queue | null;
  index: number;
  current: QueueTrack | null;
  isPlaying: boolean;
  currentTime: number;
  /** NaN until metadata loads. */
  duration: number;
  rate: number;
  loop: LoopRegion;
  repeat: RepeatMode;
  error: string | null;
}

export interface PlayerApi extends PlayerState {
  /** Replace the queue and start playing from `startIndex`. */
  playQueue: (queue: Queue, startIndex?: number) => void;
  /** Jump to a track in the current queue. */
  playAt: (index: number) => void;
  toggle: () => void;
  pause: () => void;
  next: () => void;
  prev: () => void;
  /** Relative seek in seconds (negative = back). */
  skip: (seconds: number) => void;
  seek: (t: number) => void;
  setRate: (rate: number) => void;
  setLoopStart: () => void;
  setLoopEnd: () => void;
  clearLoop: () => void;
  cycleRepeat: () => void;
  /** Stop and drop the queue — hides the player bar. */
  clear: () => void;
}

const PlayerContext = createContext<PlayerApi | null>(null);

export function PlayerProvider({ children }: { children: ReactNode }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [queue, setQueue] = useState<Queue | null>(null);
  const [index, setIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(NaN);
  const [rate, setRateState] = useState(1);
  const [loop, setLoop] = useState<LoopRegion>({ start: null, end: null });
  const [repeat, setRepeat] = useState<RepeatMode>('off');
  const [error, setError] = useState<string | null>(null);

  const current = queue?.tracks[index] ?? null;
  const src = current?.url ?? null;

  // Refs so the (stable) event handlers always see fresh values.
  const loopRef = useRef(loop);
  loopRef.current = loop;
  const repeatRef = useRef(repeat);
  repeatRef.current = repeat;
  const queueRef = useRef(queue);
  queueRef.current = queue;
  const indexRef = useRef(index);
  indexRef.current = index;
  // Whether to auto-play once the new src is ready. Set by playQueue/playAt/
  // next/prev; cleared after we act on it.
  const wantPlayRef = useRef(false);

  // --- Source changes ------------------------------------------------------

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    setCurrentTime(0);
    setDuration(NaN);
    setLoop({ start: null, end: null });
    setError(null);
    if (!src) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      setIsPlaying(false);
      return;
    }
    audio.src = src;
    audio.preservesPitch = true;
    audio.playbackRate = rate;
    audio.load();
    if (wantPlayRef.current) {
      wantPlayRef.current = false;
      void audio.play().catch((e) => setError(e instanceof Error ? e.message : String(e)));
    }
    // rate is applied in its own effect; only re-run on src.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.preservesPitch = true;
    audio.playbackRate = rate;
  }, [rate]);

  // --- Navigation (stable callbacks) ---------------------------------------

  const goTo = useCallback((i: number, autoplay: boolean): void => {
    const q = queueRef.current;
    if (!q || i < 0 || i >= q.tracks.length) return;
    wantPlayRef.current = autoplay;
    if (i === indexRef.current) {
      // Same track: restart it rather than relying on the src effect.
      const audio = audioRef.current;
      if (audio) {
        audio.currentTime = 0;
        if (autoplay) void audio.play().catch(() => undefined);
      }
      wantPlayRef.current = false;
      return;
    }
    setIndex(i);
  }, []);

  const next = useCallback((): void => {
    const q = queueRef.current;
    if (!q) return;
    const i = indexRef.current + 1;
    if (i < q.tracks.length) goTo(i, true);
    else if (repeatRef.current === 'all') goTo(0, true);
  }, [goTo]);

  const prev = useCallback((): void => {
    const audio = audioRef.current;
    // Like every music player: early in a track, go back a track; otherwise
    // restart the current one.
    if (audio && audio.currentTime > 3) {
      audio.currentTime = 0;
      return;
    }
    goTo(Math.max(0, indexRef.current - 1), true);
  }, [goTo]);

  // --- Audio element events ------------------------------------------------

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onPlay = (): void => setIsPlaying(true);
    const onPause = (): void => setIsPlaying(false);
    const onTime = (): void => {
      const t = audio.currentTime;
      setCurrentTime(t);
      const l = loopRef.current;
      if (l.start !== null && l.end !== null && t >= l.end) audio.currentTime = l.start;
    };
    const onMeta = (): void => setDuration(audio.duration);
    const onEnded = (): void => {
      if (repeatRef.current === 'one') {
        audio.currentTime = 0;
        void audio.play().catch(() => undefined);
        return;
      }
      const q = queueRef.current;
      const i = indexRef.current + 1;
      if (q && i < q.tracks.length) {
        goTo(i, true);
      } else if (q && repeatRef.current === 'all') {
        goTo(0, true);
      } else {
        setIsPlaying(false);
      }
    };
    const onError = (): void => {
      const code = audio.error?.code;
      setError(
        code === 4 ? 'audio format not supported or file missing'
          : code === 2 ? 'network error'
          : code === 3 ? 'decode failed'
          : 'audio error',
      );
      setIsPlaying(false);
    };

    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('loadedmetadata', onMeta);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('error', onError);
    return () => {
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('timeupdate', onTime);
      audio.removeEventListener('loadedmetadata', onMeta);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('error', onError);
    };
  }, [goTo]);

  // --- Media Session (lock screen / headphone buttons) ---------------------

  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    if (!current) {
      ms.metadata = null;
      ms.playbackState = 'none';
      return;
    }
    ms.metadata = new MediaMetadata({
      title: current.title,
      artist: current.subtitle,
      album: queue?.name ?? 'choirfriend',
      artwork: [
        { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      ],
    });
    ms.playbackState = isPlaying ? 'playing' : 'paused';
  }, [current, queue?.name, isPlaying]);

  // Lock-screen scrubber: keep the OS's position and speed in step.
  useEffect(() => {
    if (!('mediaSession' in navigator) || !current || !Number.isFinite(duration) || duration <= 0) return;
    try {
      navigator.mediaSession.setPositionState({
        duration,
        playbackRate: rate,
        position: Math.min(Math.max(0, currentTime), duration),
      });
    } catch {
      // Some browsers reject transient states (e.g. position past duration).
    }
  }, [current, duration, rate, currentTime]);

  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    const audio = audioRef.current;
    const set = (action: MediaSessionAction, handler: MediaSessionActionHandler | null): void => {
      try {
        ms.setActionHandler(action, handler);
      } catch {
        // Older browsers throw on unknown actions; ignore.
      }
    };
    set('play', () => void audio?.play().catch(() => undefined));
    set('pause', () => audio?.pause());
    set('previoustrack', prev);
    set('nexttrack', next);
    set('seekbackward', (d) => {
      if (audio) audio.currentTime = Math.max(0, audio.currentTime - (d.seekOffset ?? 10));
    });
    set('seekforward', (d) => {
      if (audio) audio.currentTime = audio.currentTime + (d.seekOffset ?? 10);
    });
    set('seekto', (d) => {
      if (audio && d.seekTime !== undefined && d.seekTime !== null) audio.currentTime = d.seekTime;
    });
    return () => {
      for (const a of ['play', 'pause', 'previoustrack', 'nexttrack', 'seekbackward', 'seekforward', 'seekto'] as const) {
        set(a, null);
      }
    };
  }, [next, prev]);

  // --- Public API ----------------------------------------------------------

  const playQueue = useCallback((q: Queue, startIndex = 0): void => {
    if (q.tracks.length === 0) return;
    const i = Math.min(Math.max(0, startIndex), q.tracks.length - 1);
    wantPlayRef.current = true;
    // If the track at the target index is the one already loaded, the src
    // effect won't fire; restart it explicitly.
    const same = queueRef.current?.tracks[indexRef.current]?.url === q.tracks[i]!.url;
    setQueue(q);
    setIndex(i);
    if (same) {
      wantPlayRef.current = false;
      const audio = audioRef.current;
      if (audio) {
        audio.currentTime = 0;
        void audio.play().catch(() => undefined);
      }
    }
  }, []);

  const playAt = useCallback((i: number): void => goTo(i, true), [goTo]);

  const toggle = useCallback((): void => {
    const audio = audioRef.current;
    if (!audio || !audio.src) return;
    if (audio.paused) void audio.play().catch((e) => setError(e instanceof Error ? e.message : String(e)));
    else audio.pause();
  }, []);

  const pause = useCallback((): void => audioRef.current?.pause(), []);

  const seek = useCallback((t: number): void => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = Math.max(0, Number.isFinite(audio.duration) ? Math.min(t, audio.duration) : t);
  }, []);

  const skip = useCallback((seconds: number): void => {
    const audio = audioRef.current;
    if (audio) seek(audio.currentTime + seconds);
  }, [seek]);

  const setRate = useCallback((r: number): void => setRateState(r), []);

  const setLoopStart = useCallback((): void => {
    setLoop((l) => {
      const start = audioRef.current?.currentTime ?? 0;
      return { start, end: l.end !== null && l.end <= start ? null : l.end };
    });
  }, []);
  const setLoopEnd = useCallback((): void => {
    setLoop((l) => {
      const end = audioRef.current?.currentTime ?? 0;
      return { start: l.start !== null && l.start >= end ? null : l.start, end };
    });
  }, []);
  const clearLoop = useCallback((): void => setLoop({ start: null, end: null }), []);

  const cycleRepeat = useCallback((): void => {
    setRepeat((r) => (r === 'off' ? 'all' : r === 'all' ? 'one' : 'off'));
  }, []);

  const clear = useCallback((): void => {
    wantPlayRef.current = false;
    setQueue(null);
    setIndex(0);
  }, []);

  const api = useMemo<PlayerApi>(
    () => ({
      queue,
      index,
      current,
      isPlaying,
      currentTime,
      duration,
      rate,
      loop,
      repeat,
      error,
      playQueue,
      playAt,
      toggle,
      pause,
      next,
      prev,
      skip,
      seek,
      setRate,
      setLoopStart,
      setLoopEnd,
      clearLoop,
      cycleRepeat,
      clear,
    }),
    [
      queue, index, current, isPlaying, currentTime, duration, rate, loop, repeat, error,
      playQueue, playAt, toggle, pause, next, prev, skip, seek, setRate, setLoopStart, setLoopEnd, clearLoop, cycleRepeat, clear,
    ],
  );

  return (
    <PlayerContext.Provider value={api}>
      {/* crossOrigin lets the B2/CDN response be used by Web Audio later (track mixer). */}
      <audio ref={audioRef} preload="metadata" crossOrigin="anonymous" />
      {children}
    </PlayerContext.Provider>
  );
}

export function usePlayer(): PlayerApi {
  const ctx = useContext(PlayerContext);
  if (!ctx) throw new Error('usePlayer must be used inside <PlayerProvider>');
  return ctx;
}

/** mm:ss formatting; "—:—" for NaN. */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return '—:—';
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}
