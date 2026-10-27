import { useEffect, useMemo, useState } from 'react';
import { Button, Icon } from '@/components/ui/button.tsx';
import { cn } from '@/lib/utils.ts';
import type { PieceSummary } from '@/hooks/usePieces.ts';
import type { Section } from '@/hooks/useSections.ts';
import {
  copySetList,
  deleteSetList,
  patchSetList,
  pickTrackForSection,
  useSetList,
  type SetList,
  type SetListSong,
} from '@/hooks/useSetLists.ts';
import { usePlayer, type Queue } from '@/player/PlayerContext.tsx';
import { toQueueTrack } from '@/components/AudioPlayer/AudioPlayer.tsx';

interface SetListScreenProps {
  /** 0 = the virtual "All songs" list (read-only). */
  setListId: number;
  pieces: PieceSummary[];
  sections: Section[];
  mySectionId: number | null;
  isAdmin: boolean;
  onBack: () => void;
  onOpenPiece: (id: number) => void;
  /** After create/update/copy/delete — refresh the overview. */
  onMutated: () => void;
  /** Jump to another set list (used after Copy). */
  onOpenSetList: (id: number) => void;
}

/**
 * One set list. Members: numbered song list, a section picker (defaulting to
 * their own part) and a Play button that queues one track per song. Admins
 * additionally get edit mode: rename, reorder, add/remove songs, archive,
 * copy, delete.
 */
export function SetListScreen({
  setListId,
  pieces,
  sections,
  mySectionId,
  isAdmin,
  onBack,
  onOpenPiece,
  onMutated,
  onOpenSetList,
}: SetListScreenProps) {
  const isVirtual = setListId === 0;
  const { setList, loading, error, refresh, setSetList } = useSetList(isVirtual ? null : setListId);
  const [all, setAll] = useState<SetList | null>(null);
  const [allError, setAllError] = useState<string | null>(null);

  useEffect(() => {
    if (!isVirtual) return;
    let cancelled = false;
    fetch('/api/setlists/all', { credentials: 'include' })
      .then((r) => (r.ok ? (r.json() as Promise<SetList>) : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => {
        if (!cancelled) setAll(d);
      })
      .catch((e: Error) => {
        if (!cancelled) setAllError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [isVirtual]);

  const list = isVirtual ? all : setList;
  const err = isVirtual ? allError : error;

  const player = usePlayer();
  const [sectionId, setSectionId] = useState<number | null>(mySectionId);
  useEffect(() => setSectionId(mySectionId), [mySectionId]);
  const [editing, setEditing] = useState(false);
  // Filters the list on screen only; numbers stay as the running order and
  // Play still queues the whole list.
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();

  const queue = useMemo<Queue | null>(() => {
    if (!list) return null;
    const secLabel = sections.find((s) => s.id === sectionId)?.label;
    const tracks = list.songs.flatMap((song) => {
      const f = pickTrackForSection(song.audio, sectionId);
      return f ? [toQueueTrack(song, f)] : [];
    });
    return { name: secLabel ? `${list.name} · ${secLabel}` : list.name, tracks };
  }, [list, sectionId, sections]);

  const songsWithoutAudio = list ? list.songs.filter((s) => !pickTrackForSection(s.audio, sectionId)).length : 0;
  const isThisQueuePlaying = player.queue?.name === queue?.name && player.isPlaying;

  if (err) {
    return (
      <div className="p-6 text-sm">
        <p className="text-destructive">Couldn't load set list: {err}</p>
        <Button size="sm" variant="outline" className="mt-3" onClick={onBack}>Back</Button>
      </div>
    );
  }
  if (!list) {
    return <div className="p-6 text-base text-on-field-muted">{loading || isVirtual ? 'Loading…' : ''}</div>;
  }

  if (editing && isAdmin && !isVirtual) {
    return (
      <SetListEditor
        setList={list}
        pieces={pieces}
        onSaved={(updated) => {
          setSetList(updated);
          onMutated();
        }}
        onClose={() => {
          setEditing(false);
          refresh();
        }}
        onDeleted={() => {
          onMutated();
          onBack();
        }}
        onCopied={(copy) => {
          onMutated();
          onOpenSetList(copy.id);
        }}
      />
    );
  }

  return (
    <div className="h-full overflow-auto">
      <div className="max-w-(--max) mx-auto px-4 sm:px-6 py-5 space-y-5">
        <nav aria-label="Breadcrumb" className="text-sm text-on-field-muted flex items-center gap-1">
          <button type="button" onClick={onBack} className="hover:text-on-field">Set lists</button>
          <span aria-hidden>›</span>
          <span className="text-on-field">{list.name}</span>
        </nav>
        <div className="flex items-center gap-3">
          <h1 className="text-2xl md:text-4xl font-semibold text-on-field flex-1 truncate">
            {list.name}
            {list.pinned && <span className="ml-3 text-sm font-medium uppercase tracking-wide text-on-field-muted align-middle">this week</span>}
            {list.status === 'archived' && <span className="ml-3 text-sm font-medium uppercase tracking-wide text-on-field-muted align-middle">archived</span>}
          </h1>
          {isAdmin && !isVirtual && (
            <Button variant="outline" onClick={() => setEditing(true)}>Edit set list</Button>
          )}
        </div>

        <div className="grid grid-cols-1 gap-6 md:grid-cols-[minmax(0,1fr)_320px] items-start">
        {/* Practice list panel */}
        <div className="card p-4 sm:p-6 space-y-4 min-w-0 md:order-2 md:sticky md:top-4">
          <div className="text-base font-semibold">Practice list</div>
          <label className="block text-sm">
            <span className="text-muted-foreground">Viewing content for</span>
            <select
              value={sectionId ?? ''}
              onChange={(e) => setSectionId(e.target.value === '' ? null : Number(e.target.value))}
              className="mt-1 w-full h-11 px-3 rounded-md border border-border bg-background text-base"
            >
              <option value="">Any / full mix</option>
              {sections.map((s) => (
                <option key={s.id} value={s.id}>{s.label}</option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={!queue || queue.tracks.length === 0}
            onClick={() => (isThisQueuePlaying ? player.toggle() : queue && player.playQueue(queue, 0))}
            className="w-full inset-row flex items-center gap-4 px-4 py-3 hover:shadow-card disabled:opacity-50 text-left"
          >
            <span className="w-16 h-16 rounded-full bg-primary text-primary-foreground inline-flex items-center justify-center shrink-0 shadow-card">
              <Icon name={isThisQueuePlaying ? 'pause' : 'play_arrow'} filled className="text-4xl" />
            </span>
            <span className="min-w-0">
              <span className="block text-base font-semibold">{isThisQueuePlaying ? 'Pause' : 'Play'}</span>
              <span className="block text-sm text-muted-foreground">
                {queue?.tracks.length ?? 0} track{queue?.tracks.length === 1 ? '' : 's'}, one per song
                {songsWithoutAudio > 0 && `; ${songsWithoutAudio} without audio skipped`}
              </span>
            </span>
          </button>
        </div>

        <div className="card p-4 sm:p-6 min-w-0 md:order-1">

        {list.songs.length === 0 ? (
          <p className="text-base text-muted-foreground text-center py-6">
            {isAdmin ? 'No songs yet. Use Edit set list to add some.' : 'No songs in this set list yet.'}
          </p>
        ) : (
          <>
          <input
            type="search"
            aria-label="Search this set list"
            placeholder="Search this set list…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full h-11 px-4 mb-3 rounded-full border border-border bg-background text-base"
          />
          {q && !list.songs.some((s) => `${s.title} ${s.composer ?? ''} ${s.arranger ?? ''}`.toLowerCase().includes(q)) && (
            <p className="text-base text-muted-foreground text-center py-6">No songs match “{query.trim()}”.</p>
          )}
          <ol className="inset-list">
            {list.songs.map((song, i) => {
              if (q && !`${song.title} ${song.composer ?? ''} ${song.arranger ?? ''}`.toLowerCase().includes(q)) return null;
              const track = queue ? pickTrackForSection(song.audio, sectionId) : null;
              const qIndex = queue && track ? queue.tracks.findIndex((t) => t.fileId === track.id) : -1;
              const playing = player.current?.pieceId === song.id && player.queue?.name === queue?.name;
              return (
                <li key={song.id} className={cn('inset-row flex items-center gap-3 px-3', playing && 'ring-2 ring-primary')}>
                  <span className="w-8 h-8 rounded-full bg-primary/10 text-accent-foreground text-sm font-semibold flex items-center justify-center tabular-nums shrink-0">{i + 1}</span>
                  <button type="button" onClick={() => onOpenPiece(song.id)} className="flex-1 min-w-0 text-left py-2">
                    <div className="text-base font-medium truncate">{song.title}</div>
                    {(song.composer || song.arranger) && (
                      <div className="text-sm text-muted-foreground truncate">
                        {[song.composer, song.arranger].filter(Boolean).join(' / ')}
                      </div>
                    )}
                  </button>
                  {track ? (
                    <button
                      type="button"
                      aria-label={`Play ${song.title}`}
                      title={track.label?.trim() || track.filename}
                      onClick={() => queue && qIndex >= 0 && player.playQueue(queue, qIndex)}
                      className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-primary text-primary-foreground hover:bg-primary-hover shrink-0"
                    >
                      <Icon name="play_arrow" filled />
                    </button>
                  ) : (
                    <span className="text-xs text-muted-foreground shrink-0">no audio</span>
                  )}
                  <Icon name="chevron_right" className="text-muted-foreground" />
                </li>
              );
            })}
          </ol>
          </>
        )}
        </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Admin editor
// ---------------------------------------------------------------------------

interface SetListEditorProps {
  setList: SetList;
  pieces: PieceSummary[];
  onSaved: (updated: SetList) => void;
  onClose: () => void;
  onDeleted: () => void;
  onCopied: (copy: SetList) => void;
}

function SetListEditor({ setList, pieces, onSaved, onClose, onDeleted, onCopied }: SetListEditorProps) {
  const [name, setName] = useState(setList.name);
  const [status, setStatus] = useState(setList.status);
  const [pinned, setPinned] = useState(setList.pinned);
  const [order, setOrder] = useState(String(setList.sortOrder));
  const [songs, setSongs] = useState<SetListSong[]>(setList.songs);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  const dirty =
    name.trim() !== setList.name ||
    status !== setList.status ||
    pinned !== setList.pinned ||
    Number(order) !== setList.sortOrder ||
    songs.length !== setList.songs.length ||
    songs.some((s, i) => s.id !== setList.songs[i]?.id);

  const inList = useMemo(() => new Set(songs.map((s) => s.id)), [songs]);
  const q = query.trim().toLowerCase();
  const candidates = useMemo(() => {
    if (!q) return [];
    return pieces
      .filter((p) => !inList.has(p.id))
      .filter((p) => `${p.title} ${p.composer ?? ''} ${p.arranger ?? ''}`.toLowerCase().includes(q))
      .slice(0, 8);
  }, [pieces, inList, q]);

  function move(from: number, to: number): void {
    if (to < 0 || to >= songs.length || from === to) return;
    setSongs((prev) => {
      const next = [...prev];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item!);
      return next;
    });
  }

  function add(p: PieceSummary): void {
    setSongs((prev) => [...prev, { position: prev.length, id: p.id, title: p.title, composer: p.composer, arranger: p.arranger, audio: [] }]);
    setQuery('');
  }

  async function run<T>(label: string, fn: () => Promise<T>, after: (r: T) => void): Promise<void> {
    if (busy) return;
    setBusy(label);
    setError(null);
    try {
      after(await fn());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const save = (): Promise<void> =>
    run('save', () => patchSetList(setList.id, { name: name.trim(), status, pinned, sortOrder: Number.isInteger(Number(order)) ? Number(order) : setList.sortOrder, pieceIds: songs.map((s) => s.id) }), (updated) => {
      onSaved(updated);
      setSongs(updated.songs);
    });

  return (
    <div className="h-full overflow-auto">
      <div className="max-w-(--max) mx-auto px-4 sm:px-6 py-5 space-y-5">
        <div className="flex items-center gap-3">
          <button type="button" onClick={onClose} className="text-sm text-on-field-muted hover:text-on-field">‹ Done</button>
          <h1 className="text-2xl font-semibold text-on-field flex-1 truncate">Edit set list</h1>
          <Button size="sm" onClick={() => void save()} disabled={!dirty || !name.trim() || busy !== null}>
            {busy === 'save' ? 'Saving…' : 'Save'}
          </Button>
        </div>

        {error && <p className="text-xs text-destructive">{error}</p>}

        <div className="card p-4 sm:p-6 grid gap-3 sm:grid-cols-[1fr_auto_auto]">
          <label className="text-xs space-y-1">
            <span className="text-muted-foreground">Name</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full h-9 px-2 rounded-md border border-border bg-background text-sm"
            />
          </label>
          <label className="text-xs space-y-1">
            <span className="text-muted-foreground">Status</span>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as SetList['status'])}
              className="w-full h-9 px-2 rounded-md border border-border bg-background text-sm"
            >
              <option value="active">Active</option>
              <option value="archived">Archived</option>
            </select>
          </label>
          <label className="text-xs space-y-1">
            <span className="text-muted-foreground">Order</span>
            <input
              type="number"
              value={order}
              onChange={(e) => setOrder(e.target.value)}
              className="w-24 h-9 px-2 rounded-md border border-border bg-background text-sm"
            />
          </label>
          <label className="text-xs flex items-center gap-2 sm:col-span-3 cursor-pointer select-none">
            <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} />
            <span>
              <span className="font-medium">This week's rehearsal</span>
              <span className="text-muted-foreground"> — show this list at the top of everyone's home screen. Pinning it unpins any other.</span>
            </span>
          </label>
        </div>

        <section className="card p-4 sm:p-6 space-y-3">
          <h2 className="text-base font-semibold">Songs <span className="text-muted-foreground font-normal">({songs.length})</span></h2>
          {songs.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing yet. Search below to add songs.</p>
          ) : (
            <ol className="inset-list">
              {songs.map((song, i) => (
                <li
                  key={song.id}
                  draggable
                  onDragStart={() => setDragIndex(i)}
                  onDragOver={(e) => {
                    e.preventDefault();
                    if (dragIndex !== null && dragIndex !== i) {
                      move(dragIndex, i);
                      setDragIndex(i);
                    }
                  }}
                  onDragEnd={() => setDragIndex(null)}
                  className={cn('flex items-center gap-2 px-3 py-2', dragIndex === i && 'opacity-50')}
                >
                  <span className="cursor-grab text-muted-foreground select-none" title="Drag to reorder" aria-hidden>⋮⋮</span>
                  <span className="w-6 text-xs tabular-nums text-muted-foreground text-right">{i + 1}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm truncate">{song.title}</div>
                    {song.composer && <div className="text-xs text-muted-foreground truncate">{song.composer}</div>}
                  </div>
                  <button type="button" aria-label="Move up" disabled={i === 0} onClick={() => move(i, i - 1)} className="text-xs px-1.5 py-0.5 rounded border border-border disabled:opacity-30">▲</button>
                  <button type="button" aria-label="Move down" disabled={i === songs.length - 1} onClick={() => move(i, i + 1)} className="text-xs px-1.5 py-0.5 rounded border border-border disabled:opacity-30">▼</button>
                  <button
                    type="button"
                    aria-label={`Remove ${song.title}`}
                    onClick={() => setSongs((prev) => prev.filter((s) => s.id !== song.id))}
                    className="text-muted-foreground hover:text-destructive ml-1"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M6 6 18 18M18 6 6 18" /></svg>
                  </button>
                </li>
              ))}
            </ol>
          )}

          <div className="relative">
            <input
              type="search"
              placeholder="Search or add songs"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-full h-10 px-3 rounded-md border border-border bg-background text-sm"
            />
            {candidates.length > 0 && (
              <ul className="absolute left-0 right-0 top-full mt-1 z-20 bg-background border border-border rounded-md shadow-lg overflow-hidden">
                {candidates.map((p) => (
                  <li key={p.id}>
                    <button type="button" onClick={() => add(p)} className="w-full text-left px-3 py-2 text-sm hover:bg-accent/60 flex items-center gap-2">
                      <span className="flex-1 truncate">{p.title}</span>
                      {p.composer && <span className="text-xs text-muted-foreground truncate">{p.composer}</span>}
                      <span className="text-xs text-muted-foreground">{p.audioCount} audio</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {q && candidates.length === 0 && (
              <p className="text-xs text-muted-foreground mt-1 px-1">No songs match “{query.trim()}”.</p>
            )}
          </div>
        </section>

        <section className="card p-4 sm:p-6 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void run('copy', () => copySetList(setList.id), onCopied)}>
            <Icon name="content_copy" className="text-xl" />
            {busy === 'copy' ? 'Copying…' : 'Copy'}
          </Button>
          <div className="flex-1" />
          {confirmDelete ? (
            <>
              <span className="text-xs text-muted-foreground">Delete “{setList.name}”?</span>
              <Button size="sm" variant="danger" disabled={busy !== null} onClick={() => void run('delete', () => deleteSetList(setList.id), onDeleted)}>
                {busy === 'delete' ? 'Deleting…' : 'Delete'}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>Cancel</Button>
            </>
          ) : (
            <Button size="sm" variant="danger" onClick={() => setConfirmDelete(true)}>Delete set list</Button>
          )}
        </section>
      </div>
    </div>
  );
}
