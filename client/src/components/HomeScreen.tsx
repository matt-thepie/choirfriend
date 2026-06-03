import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button.tsx';
import { createPiece, patchPiece, type PieceSummary } from '@/hooks/usePieces.ts';

interface HomeScreenProps {
  pieces: PieceSummary[];
  loading: boolean;
  isAdmin: boolean;
  onOpenPiece: (id: number) => void;
  onPieceMutated: () => void;
  /** Admin only — open the bulk importer. Undefined hides the button. */
  onImport?: () => void;
}

/**
 * The app's landing page. Choristers find a piece here, then click into the
 * viewer.
 *
 * Two always-visible lists, split by each piece's `is_current` flag:
 *   - "Active repertoire" — the songs we're currently practising.
 *   - "All other songs"   — everything else. Still fully visible and
 *                           searchable; nothing is hidden behind a toggle.
 *
 * The search box filters both lists at once. Admins (per ADMIN_ROLES) get a
 * per-row button to move a song between the two: "Add to repertoire" /
 * "Remove from repertoire".
 */
export function HomeScreen({ pieces, loading, isAdmin, onOpenPiece, onPieceMutated, onImport }: HomeScreenProps) {
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newComposer, setNewComposer] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [createSubmitting, setCreateSubmitting] = useState(false);
  const [busyPieceId, setBusyPieceId] = useState<number | null>(null);

  const q = query.trim().toLowerCase();
  const searching = q !== '';

  const { active, others, activeTotal, othersTotal } = useMemo(() => {
    const matches = (p: PieceSummary): boolean => {
      if (!searching) return true;
      return `${p.title} ${p.composer ?? ''} ${p.arranger ?? ''}`.toLowerCase().includes(q);
    };
    const activeAll = pieces.filter((p) => p.isCurrent);
    const othersAll = pieces.filter((p) => !p.isCurrent);
    return {
      active: activeAll.filter(matches),
      others: othersAll.filter(matches),
      activeTotal: activeAll.length,
      othersTotal: othersAll.length,
    };
  }, [pieces, q, searching]);

  const noMatches = searching && active.length === 0 && others.length === 0;

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

  /** Move a song into or out of the active repertoire. */
  async function handleToggleRepertoire(p: PieceSummary): Promise<void> {
    if (busyPieceId === p.id) return;
    setBusyPieceId(p.id);
    try {
      await patchPiece(p.id, { isCurrent: !p.isCurrent });
      onPieceMutated();
    } catch (e) {
      console.error('[home] repertoire toggle failed:', e);
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
                Search songs
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
            {!creating && isAdmin && (
              <Button size="md" variant="outline" onClick={() => setCreating(true)}>
                + New song
              </Button>
            )}
            {!creating && isAdmin && onImport && (
              <Button size="md" variant="outline" onClick={onImport}>
                Import files
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

        {loading && pieces.length === 0 && (
          <p className="text-sm text-muted-foreground">Loading songs…</p>
        )}

        {!loading && pieces.length === 0 && (
          <p className="text-sm text-muted-foreground">
            {isAdmin ? (
              <>No songs yet. Use <strong>New song</strong> to add one, then drop a PDF and learning tracks into it.</>
            ) : (
              'No songs yet. Ask an admin to add some.'
            )}
          </p>
        )}

        {noMatches && (
          <p className="text-sm text-muted-foreground">No songs match “{query.trim()}”.</p>
        )}

        {pieces.length > 0 && !noMatches && (
          <>
            <PieceSection
              title="Active repertoire"
              shown={active.length}
              total={activeTotal}
              searching={searching}
              pieces={active}
              isAdmin={isAdmin}
              busyPieceId={busyPieceId}
              actionLabel="Remove from repertoire"
              emptyText={searching ? null : 'Nothing being practised right now.'}
              onOpenPiece={onOpenPiece}
              onToggleRepertoire={handleToggleRepertoire}
            />
            <PieceSection
              title="All other songs"
              shown={others.length}
              total={othersTotal}
              searching={searching}
              pieces={others}
              isAdmin={isAdmin}
              busyPieceId={busyPieceId}
              actionLabel="Add to repertoire"
              emptyText={searching || othersTotal > 0 ? null : 'Every song is in the active repertoire.'}
              onOpenPiece={onOpenPiece}
              onToggleRepertoire={handleToggleRepertoire}
            />
          </>
        )}
      </div>
    </div>
  );
}

interface PieceSectionProps {
  title: string;
  shown: number;
  total: number;
  searching: boolean;
  pieces: PieceSummary[];
  isAdmin: boolean;
  busyPieceId: number | null;
  /** Label for the per-row admin button that moves a song between lists. */
  actionLabel: string;
  /** Shown in place of the list when there are no pieces; null = render nothing. */
  emptyText: string | null;
  onOpenPiece: (id: number) => void;
  onToggleRepertoire: (p: PieceSummary) => void;
}

function PieceSection({
  title,
  shown,
  total,
  searching,
  pieces,
  isAdmin,
  busyPieceId,
  actionLabel,
  emptyText,
  onOpenPiece,
  onToggleRepertoire,
}: PieceSectionProps) {
  // While searching, a section with no matches just disappears (unless it had
  // nothing to begin with and has its own empty hint). Otherwise it's noise.
  if (pieces.length === 0 && (searching || emptyText === null)) return null;

  return (
    <section className="space-y-1">
      <h2 className="text-sm font-semibold mb-2">
        {title}
        <span className="text-muted-foreground font-normal ml-2">
          ({searching && shown !== total ? `${shown} of ${total}` : total})
        </span>
      </h2>

      {pieces.length === 0 ? (
        emptyText && <p className="text-sm text-muted-foreground">{emptyText}</p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border bg-background overflow-hidden">
          {pieces.map((p) => (
            <li
              key={p.id}
              className="flex items-center gap-3 px-4 py-3 hover:bg-accent/40 cursor-pointer"
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
              {isAdmin && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busyPieceId === p.id}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleRepertoire(p);
                  }}
                >
                  {actionLabel}
                </Button>
              )}
              <span className="text-muted-foreground" aria-hidden>
                ›
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
