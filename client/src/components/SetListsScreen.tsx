import { useState } from 'react';
import { Button } from '@/components/ui/button.tsx';
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
 * Set lists overview: tiles for each active list plus "All songs"; archived
 * lists in a collapsed section below. Admins can create a new list here.
 */
export function SetListsScreen({ setLists, loading, isAdmin, onOpen, onMutated }: SetListsScreenProps) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const active = setLists.filter((s) => s.status === 'active');
  const archived = setLists.filter((s) => s.status === 'archived');

  async function handleCreate(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const sl = await createSetList({ name: name.trim() });
      setName('');
      setCreating(false);
      onMutated();
      onOpen(sl.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="h-full overflow-auto bg-muted/20">
      <div className="max-w-3xl mx-auto px-4 py-6 space-y-6">
        <section className="space-y-3">
          <div className="flex items-center gap-3">
            <h1 className="text-base font-semibold flex-1">Set lists</h1>
            {isAdmin && !creating && (
              <Button size="sm" variant="outline" onClick={() => setCreating(true)}>+ New set list</Button>
            )}
          </div>

          {creating && (
            <form onSubmit={handleCreate} className="rounded-md border border-border bg-background p-3 flex flex-wrap items-center gap-2">
              <input
                type="text"
                required
                autoFocus
                placeholder="Name, e.g. Rehearsal or Spring concert"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="text-sm h-9 px-2 rounded-md border border-border bg-background flex-1 min-w-48"
              />
              <Button size="sm" type="submit" disabled={!name.trim() || busy}>{busy ? 'Creating…' : 'Create'}</Button>
              <Button size="sm" variant="ghost" type="button" onClick={() => { setCreating(false); setName(''); setError(null); }} disabled={busy}>
                Cancel
              </Button>
              {error && <span className="text-xs text-destructive ml-auto">{error}</span>}
            </form>
          )}

          {loading && setLists.length === 0 && <p className="text-sm text-muted-foreground">Loading set lists…</p>}

          <ul className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <Tile title="All songs" subtitle="Whole repertoire" onClick={() => onOpen(0)} />
            {active.map((s) => (
              <Tile
                key={s.id}
                title={s.name}
                subtitle={`${s.songCount} song${s.songCount === 1 ? '' : 's'}${s.pinned ? ' · this week' : ''}`}
                onClick={() => onOpen(s.id)}
              />
            ))}
          </ul>

          {!loading && active.length === 0 && (
            <p className="text-sm text-muted-foreground">
              {isAdmin ? 'No set lists yet. Create one for the current rehearsal block.' : 'No set lists yet.'}
            </p>
          )}
        </section>

        {archived.length > 0 && (
          <section className="space-y-2">
            <button
              type="button"
              onClick={() => setShowArchived((v) => !v)}
              className="text-sm font-semibold text-muted-foreground hover:text-foreground"
              aria-expanded={showArchived}
            >
              {showArchived ? '▾' : '▸'} Archived ({archived.length})
            </button>
            {showArchived && (
              <ul className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {archived.map((s) => (
                  <Tile key={s.id} title={s.name} subtitle={`${s.songCount} song${s.songCount === 1 ? '' : 's'}`} onClick={() => onOpen(s.id)} muted />
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

function Tile({ title, subtitle, onClick, muted }: { title: string; subtitle: string; onClick: () => void; muted?: boolean }) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className={`w-full text-left rounded-md border border-border p-4 h-24 flex flex-col justify-end hover:bg-accent/40 ${muted ? 'bg-muted/40' : 'bg-background'}`}
      >
        <div className="text-sm font-semibold truncate">{title}</div>
        <div className="text-xs text-muted-foreground truncate">{subtitle}</div>
      </button>
    </li>
  );
}
