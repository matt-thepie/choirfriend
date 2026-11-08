import { useState } from 'react';
import { Button, Icon } from '@/components/ui/button.tsx';
import { cn } from '@/lib/utils.ts';
import { createSetList, type SetListSummary } from '@/hooks/useSetLists.ts';

interface SetListsScreenProps {
  setLists: SetListSummary[];
  loading: boolean;
  isAdmin: boolean;
  /** 0 opens the virtual "All songs" list. */
  onOpen: (id: number) => void;
  onMutated: () => void;
}

/**
 * Set lists overview: picture tiles for each active choir list, then "All
 * songs", then "+ New set list", then the member's own lists ("My set lists",
 * private to them), then "Archived set lists" collapsed. Admins in edit mode
 * create choir lists; everyone else's new lists are personal.
 */
export function SetListsScreen({ setLists, loading, isAdmin, onOpen, onMutated }: SetListsScreenProps) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  // Admins in edit mode create choir lists unless they tick "just for me".
  const [personal, setPersonal] = useState(false);

  const choir = setLists.filter((s) => !s.personal);
  const mine = setLists.filter((s) => s.mine);
  const active = choir.filter((s) => s.status === 'active');
  const archived = choir.filter((s) => s.status === 'archived');
  const mineActive = mine.filter((s) => s.status === 'active');
  const mineArchived = mine.filter((s) => s.status === 'archived');

  async function handleCreate(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const sl = await createSetList({ name: name.trim(), personal: isAdmin ? personal : true });
      setName('');
      setCreating(false);
      setPersonal(false);
      onMutated();
      onOpen(sl.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="h-full overflow-auto">
      <div className="max-w-(--max) mx-auto px-4 sm:px-6 py-5 space-y-6">
        <h1 className="text-2xl md:text-4xl font-semibold text-on-field">Set lists</h1>

        {creating && (
          <form onSubmit={handleCreate} className="card p-4 sm:p-6 flex flex-wrap items-center gap-3">
            <input
              type="text"
              required
              autoFocus
              placeholder="Name, e.g. Rehearsal or Spring concert"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="text-base h-11 px-3 rounded-md border border-border bg-background flex-1 min-w-48"
            />
            <Button type="submit" disabled={!name.trim() || busy}>{busy ? 'Creating…' : 'Create'}</Button>
            <Button variant="ghost" type="button" onClick={() => { setCreating(false); setName(''); setError(null); setPersonal(false); }} disabled={busy}>
              Cancel
            </Button>
            {error && <span className="text-sm text-destructive ml-auto">{error}</span>}
            <p className="basis-full text-sm text-muted-foreground">
              {isAdmin ? (
                <label className="inline-flex items-center gap-2 cursor-pointer select-none">
                  <input type="checkbox" checked={personal} onChange={(e) => setPersonal(e.target.checked)} />
                  <span>Just for me — a personal list nobody else sees</span>
                </label>
              ) : (
                'A personal list: only you can see it.'
              )}
            </p>
          </form>
        )}

        {loading && setLists.length === 0 && (
          <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
            {[0, 1, 2].map((i) => <li key={i} className="card h-56 animate-pulse" aria-hidden />)}
          </ul>
        )}

        <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
          {active.map((s) => (
            <Tile key={s.id} list={s} onClick={() => onOpen(s.id)} />
          ))}
          <Tile list={{ name: 'All songs', subtitle: 'Whole repertoire' }} onClick={() => onOpen(0)} />
          {!creating && (
            <li>
              <button
                type="button"
                onClick={() => setCreating(true)}
                className="w-full h-full min-h-56 card flex flex-col items-center justify-center gap-3 hover:shadow-float transition-shadow"
              >
                <span className="w-24 h-24 rounded-full bg-primary text-primary-foreground inline-flex items-center justify-center shadow-card">
                  <Icon name="add" className="text-5xl" />
                </span>
                <span className="text-base font-medium">New set list</span>
              </button>
            </li>
          )}
        </ul>

        {!loading && active.length === 0 && !isAdmin && (
          <p className="text-base text-on-field-muted">No choir set lists yet.</p>
        )}

        {mineActive.length > 0 && (
          <section className="space-y-3">
            <h2 className="text-lg md:text-2xl font-semibold text-on-field">
              My set lists
              <span className="ml-3 text-sm font-normal text-on-field-muted">only you can see these</span>
            </h2>
            <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
              {mineActive.map((s) => (
                <Tile key={s.id} list={s} onClick={() => onOpen(s.id)} />
              ))}
            </ul>
          </section>
        )}

        {archived.length + mineArchived.length > 0 && (
          <section className="space-y-3">
            <button
              type="button"
              onClick={() => setShowArchived((v) => !v)}
              className="inline-flex items-center gap-1 text-base font-medium text-on-field-muted hover:text-on-field"
              aria-expanded={showArchived}
            >
              <Icon name={showArchived ? 'expand_more' : 'chevron_right'} />
              Archived set lists ({archived.length + mineArchived.length})
            </button>
            {showArchived && (
              <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
                {[...archived, ...mineArchived].map((s) => (
                  <Tile key={s.id} list={s} onClick={() => onOpen(s.id)} muted />
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

function Tile({
  list,
  onClick,
  muted,
}: {
  list: { name: string; songCount?: number; pinned?: boolean; personal?: boolean; subtitle?: string; imageUrl?: string | null };
  onClick: () => void;
  muted?: boolean;
}) {
  const subtitle = list.subtitle ?? `${list.songCount} song${list.songCount === 1 ? '' : 's'}`;
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className={cn('w-full text-left card overflow-hidden hover:shadow-float hover:-translate-y-px transition-all duration-150', muted && 'opacity-75')}
      >
        {/* Cover: the list's picture, or a gradient with a faint note when it has none. */}
        <div className="relative aspect-video bg-linear-to-br from-primary-hover to-primary-active">
          {list.imageUrl ? (
            <img src={list.imageUrl} alt="" loading="lazy" className="absolute inset-0 w-full h-full object-cover" />
          ) : (
            <Icon name="music_note" className="absolute right-4 top-3 text-8xl text-white/15" />
          )}
          <div className="absolute inset-x-0 bottom-0 p-4 pt-10 bg-linear-to-t from-black/60 to-transparent">
            <div className="text-xl font-semibold text-white leading-tight line-clamp-2">{list.name}</div>
          </div>
        </div>
        <div className="px-4 py-3 text-sm text-muted-foreground flex items-center gap-2">
          <span>{subtitle}</span>
          {list.pinned && <span className="ml-auto text-xs font-semibold uppercase tracking-wide text-accent-foreground">This week</span>}
          {list.personal && (
            <span className="ml-auto inline-flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <Icon name="lock" className="text-sm" /> Mine
            </span>
          )}
        </div>
      </button>
    </li>
  );
}
