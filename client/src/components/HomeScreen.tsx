import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button.tsx';
import { cn } from '@/lib/utils.ts';
import { createPiece, patchPiece, type PieceSummary } from '@/hooks/usePieces.ts';

interface HomeScreenProps {
  pieces: PieceSummary[];
  loading: boolean;
  isAdmin: boolean;
  onOpenPiece: (id: number) => void;
  onPieceMutated: () => void;
}

/**
 * The app's landing page. Choristers find a piece here, then click into the
 * viewer. Defaults to "current repertoire only"; the archive toggle reveals
 * older material (useful when the MD calls one back at the last minute).
 *
 * Admins (per ADMIN_ROLES) see a small inline toggle on each row to flip a
 * piece between current and archive.
 */
export function HomeScreen({ pieces, loading, isAdmin, onOpenPiece, onPieceMutated }: HomeScreenProps) {
  const [query, setQuery] = useState('');
  const [showArchive, setShowArchive] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newComposer, setNewComposer] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [createSubmitting, setCreateSubmitting] = useState(false);
  const [busyPieceId, setBusyPieceId] = useState<number | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return pieces.filter((p) => {
      if (!showArchive && !p.isCurrent) return false;
      if (q === '') return true;
      const haystack = `${p.title} ${p.composer ?? ''} ${p.arranger ?? ''}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [pieces, query, showArchive]);

  const currentCount = pieces.filter((p) => p.isCurrent).length;
  const archiveCount = pieces.length - currentCount;

  async function handleCreate(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (createSubmitting || !newTitle.trim()) return;
    setCreateSubmitting(true);
    setCreateError(null);
    try {
      const piece = await createPiece({
        title: newTitle.trim(),
        composer: newComposer.trim() || undefined,
      });
      setNewTitle('');
      setNewComposer('');
      setCreating(false);
      onPieceMutated();
      onOpenPiece(piece.id);
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreateSubmitting(false);
    }
  }

  async function handleToggleArchived(p: PieceSummary): Promise<void> {
    if (busyPieceId === p.id) return;
    setBusyPieceId(p.id);
    try {
      await patchPiece(p.id, { isCurrent: !p.isCurrent });
      onPieceMutated();
    } catch (e) {
      console.error('[home] toggle failed:', e);
    } finally {
      setBusyPieceId(null);
    }
  }

  return (
    <div className="h-full overflow-auto bg-muted/20">
      <div className="max-w-3xl mx-auto px-4 py-6 space-y-6">
        <section className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex-1 min-w-48">
              <label htmlFor="repertoire-search" className="block text-xs text-muted-foreground mb-1">
                Search repertoire
              </label>
              <input
                id="repertoire-search"
                type="search"
                autoFocus
                placeholder="Title, composer, arranger…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="w-full h-10 px-3 rounded-md border border-border bg-background text-sm"
              />
            </div>
            <label className="text-xs flex items-center gap-1.5 select-none cursor-pointer h-10 px-3 rounded-md border border-border bg-background">
              <input
                type="checkbox"
                checked={showArchive}
                onChange={(e) => setShowArchive(e.target.checked)}
              />
              Show archive
              {archiveCount > 0 && <span className="text-muted-foreground">({archiveCount})</span>}
            </label>
            {!creating && isAdmin && (
              <Button size="md" variant="outline" onClick={() => setCreating(true)}>
                + New piece
              </Button>
            )}
          </div>

          {creating && isAdmin && (
            <form
              onSubmit={handleCreate}
              className="rounded-md border border-border bg-background p-3 flex flex-wrap items-center gap-2"
            >
              <input
                type="text"
                required
                autoFocus
                placeholder="Title"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                className="text-sm h-9 px-2 rounded-md border border-border bg-background flex-1 min-w-40"
              />
              <input
                type="text"
                placeholder="Composer (optional)"
                value={newComposer}
                onChange={(e) => setNewComposer(e.target.value)}
                className="text-sm h-9 px-2 rounded-md border border-border bg-background flex-1 min-w-40"
              />
              <Button size="sm" type="submit" disabled={!newTitle.trim() || createSubmitting}>
                {createSubmitting ? 'Creating…' : 'Create'}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                type="button"
                onClick={() => {
                  setCreating(false);
                  setNewTitle('');
                  setNewComposer('');
                  setCreateError(null);
                }}
                disabled={createSubmitting}
              >
                Cancel
              </Button>
              {createError && <span className="text-xs text-destructive ml-auto">{createError}</span>}
            </form>
          )}
        </section>

        <section className="space-y-1">
          <div className="flex items-baseline justify-between mb-2">
            <h2 className="text-sm font-semibold">
              {showArchive ? 'All pieces' : 'Current repertoire'}
              <span className="text-muted-foreground font-normal ml-2">
                {loading ? '' : `(${filtered.length}${filtered.length !== pieces.length ? ` of ${pieces.length}` : ''})`}
              </span>
            </h2>
            {!showArchive && (
              <span className="text-xs text-muted-foreground">{currentCount} current</span>
            )}
          </div>

          {loading && filtered.length === 0 && (
            <p className="text-sm text-muted-foreground">Loading pieces…</p>
          )}
          {!loading && filtered.length === 0 && pieces.length === 0 && (
            <p className="text-sm text-muted-foreground">
              {isAdmin
                ? <>No pieces yet. Use <strong>New piece</strong> to create one, then drop a PDF and learning tracks into it.</>
                : 'No pieces yet. Ask an admin to add repertoire.'}
            </p>
          )}
          {!loading && filtered.length === 0 && pieces.length > 0 && (
            <p className="text-sm text-muted-foreground">
              No matches. {query ? 'Try a different search,' : ''} {!showArchive && 'tick "Show archive"'} {query && !showArchive && 'or'} {query && 'clear the search'}.
            </p>
          )}

          <ul className="divide-y divide-border rounded-md border border-border bg-background overflow-hidden">
            {filtered.map((p) => (
              <li
                key={p.id}
                className={cn(
                  'flex items-center gap-3 px-4 py-3 hover:bg-accent/40 cursor-pointer',
                  !p.isCurrent && 'opacity-60',
                )}
                onClick={() => onOpenPiece(p.id)}
              >
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{p.title}</div>
                  {(p.composer || p.arranger) && (
                    <div className="text-xs text-muted-foreground truncate">
                      {[p.composer, p.arranger ? `arr. ${p.arranger}` : null].filter(Boolean).join(' · ')}
                    </div>
                  )}
                </div>
                {!p.isCurrent && (
                  <span className="text-[10px] uppercase tracking-wide font-semibold text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                    archive
                  </span>
                )}
                {isAdmin && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busyPieceId === p.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleToggleArchived(p);
                    }}
                  >
                    {p.isCurrent ? 'Archive' : 'Restore'}
                  </Button>
                )}
                <span className="text-muted-foreground" aria-hidden>
                  ›
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
