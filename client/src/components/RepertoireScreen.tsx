import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button.tsx';
import { cn } from '@/lib/utils.ts';
import { createPiece, type PieceSummary } from '@/hooks/usePieces.ts';

interface RepertoireScreenProps {
  pieces: PieceSummary[];
  loading: boolean;
  /** Edit mode (admins only) — shows "Add new song" and the importer. */
  editing: boolean;
  onOpenPiece: (id: number) => void;
  onPieceMutated: () => void;
  onImport?: () => void;
}

type SortKey = 'title' | 'artist' | 'added';

/** Sort/group key for a title: case-folded, leading article dropped, so
 *  "The Rose" files under R. */
function titleKey(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/^(the|a|an)\s+/, '')
    .replace(/^[^a-z0-9]+/, '');
}

function letterOf(title: string): string {
  const c = titleKey(title).charAt(0);
  return /[a-z]/.test(c) ? c.toUpperCase() : '#';
}

/** "Artist/Arranger" — composer and arranger together, " / " between. */
export function artistArranger(p: Pick<PieceSummary, 'composer' | 'arranger'>): string {
  return [p.composer, p.arranger].filter((s) => s && s.trim()).join(' / ');
}

/**
 * The repertoire: one flat table of every song (Title, Artist/Arranger,
 * Sheet music), searchable and sortable. Sorted by title it is grouped under
 * letter headings with an A–Z strip to jump by.
 */
export function RepertoireScreen({ pieces, loading, editing, onOpenPiece, onPieceMutated, onImport }: RepertoireScreenProps) {
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('title');
  const [desc, setDesc] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newArtist, setNewArtist] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [createSubmitting, setCreateSubmitting] = useState(false);

  const q = query.trim().toLowerCase();

  const sorted = useMemo(() => {
    const matches = (p: PieceSummary): boolean => !q || `${p.title} ${artistArranger(p)}`.toLowerCase().includes(q);
    const cmp = (a: PieceSummary, b: PieceSummary): number => {
      switch (sortKey) {
        case 'title':
          return titleKey(a.title).localeCompare(titleKey(b.title)) || a.id - b.id;
        case 'artist':
          return artistArranger(a).toLowerCase().localeCompare(artistArranger(b).toLowerCase()) || titleKey(a.title).localeCompare(titleKey(b.title));
        case 'added':
          return a.createdAt - b.createdAt || a.id - b.id;
      }
    };
    const out = pieces.filter(matches).sort(cmp);
    return desc ? out.reverse() : out;
  }, [pieces, q, sortKey, desc]);

  // Letter groups only make sense in title order.
  const grouped = sortKey === 'title';
  const letters = useMemo(() => {
    if (!grouped) return [];
    const seen = new Set<string>();
    for (const p of sorted) seen.add(letterOf(p.title));
    return [...seen];
  }, [sorted, grouped]);

  async function handleCreate(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (createSubmitting || !newTitle.trim()) return;
    setCreateSubmitting(true);
    setCreateError(null);
    try {
      const piece = await createPiece({ title: newTitle.trim(), composer: newArtist.trim() || undefined });
      setNewTitle('');
      setNewArtist('');
      setCreating(false);
      onPieceMutated();
      onOpenPiece(piece.id);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreateSubmitting(false);
    }
  }

  function jumpTo(letter: string): void {
    document.getElementById(`letter-${letter}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  return (
    <div className="h-full overflow-auto bg-muted/20">
      <div className="max-w-4xl mx-auto px-4 py-6 space-y-4">
        <section className="flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-48">
            <label htmlFor="repertoire-search" className="block text-xs text-muted-foreground mb-1">Search for song</label>
            <input
              id="repertoire-search"
              type="search"
              placeholder="Title or artist…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-full h-10 px-3 rounded-md border border-border bg-background text-sm"
            />
          </div>
          <label className="text-xs text-muted-foreground">
            <span className="block mb-1">Sort songs</span>
            <span className="flex items-center gap-1">
              <select
                value={sortKey}
                onChange={(e) => setSortKey(e.target.value as SortKey)}
                className="h-10 px-2 rounded-md border border-border bg-background text-sm text-foreground"
              >
                <option value="title">Title</option>
                <option value="artist">Artist/Arranger</option>
                <option value="added">Date added</option>
              </select>
              <button
                type="button"
                onClick={() => setDesc((d) => !d)}
                aria-label={desc ? 'Sorted descending' : 'Sorted ascending'}
                title={desc ? 'Descending' : 'Ascending'}
                className="h-10 w-10 rounded-md border border-border bg-background text-foreground hover:bg-accent"
              >
                {desc ? '↓' : '↑'}
              </button>
            </span>
          </label>
          {editing && !creating && (
            <Button size="md" variant="outline" onClick={() => setCreating(true)}>+ Add new song</Button>
          )}
          {editing && !creating && onImport && (
            <Button size="md" variant="outline" onClick={onImport}>Import files</Button>
          )}
        </section>

        {creating && editing && (
          <form onSubmit={handleCreate} className="rounded-md border border-border bg-background p-3 flex flex-wrap items-center gap-2">
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
              placeholder="Artist/Arranger"
              value={newArtist}
              onChange={(e) => setNewArtist(e.target.value)}
              className="text-sm h-9 px-2 rounded-md border border-border bg-background flex-1 min-w-40"
            />
            <Button size="sm" type="submit" disabled={!newTitle.trim() || createSubmitting}>
              {createSubmitting ? 'Adding…' : 'Add new song'}
            </Button>
            <Button size="sm" variant="ghost" type="button" disabled={createSubmitting} onClick={() => { setCreating(false); setNewTitle(''); setNewArtist(''); setCreateError(null); }}>
              Cancel
            </Button>
            {createError && <span className="text-xs text-destructive ml-auto">{createError}</span>}
          </form>
        )}

        {loading && pieces.length === 0 && <p className="text-sm text-muted-foreground">Loading songs…</p>}
        {!loading && pieces.length === 0 && (
          <p className="text-sm text-muted-foreground">
            {editing ? <>No songs yet. Use <strong>Add new song</strong> to add one.</> : 'No songs yet.'}
          </p>
        )}
        {q && sorted.length === 0 && pieces.length > 0 && (
          <p className="text-sm text-muted-foreground">No songs match “{query.trim()}”.</p>
        )}

        {sorted.length > 0 && (
          <div className="flex gap-3">
            <div className="flex-1 min-w-0 rounded-md border border-border bg-background overflow-hidden">
              <table className="w-full text-sm">
                <thead className="text-xs text-muted-foreground">
                  <tr className="border-b border-border">
                    <th scope="col" className="text-left font-medium px-4 py-2">Title</th>
                    <th scope="col" className="text-left font-medium px-4 py-2 hidden sm:table-cell">Artist/Arranger</th>
                    <th scope="col" className="text-right font-medium px-4 py-2 whitespace-nowrap">Sheet music</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((p, i) => {
                    const letter = letterOf(p.title);
                    const newLetter = grouped && (i === 0 || letterOf(sorted[i - 1]!.title) !== letter);
                    return (
                      <RowGroup key={p.id} letter={newLetter ? letter : null}>
                        <tr
                          onClick={() => onOpenPiece(p.id)}
                          className="border-t border-border hover:bg-accent/40 cursor-pointer h-12"
                        >
                          <td className="px-4 py-2">
                            <div className="font-medium">{p.title}</div>
                            <div className="text-xs text-muted-foreground sm:hidden">{artistArranger(p)}</div>
                          </td>
                          <td className="px-4 py-2 text-muted-foreground hidden sm:table-cell">{artistArranger(p) || '–'}</td>
                          <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap">
                            {p.pdfCount > 0 ? (
                              <span className="inline-flex items-center gap-1 text-emerald-700">
                                <CheckIcon /> ({p.pdfCount})
                              </span>
                            ) : (
                              <span className="text-muted-foreground">–</span>
                            )}
                          </td>
                        </tr>
                      </RowGroup>
                    );
                  })}
                </tbody>
              </table>
              <div className="px-4 py-2 text-xs text-muted-foreground border-t border-border">
                {sorted.length} {sorted.length === 1 ? 'Song' : 'Songs'}
                {q && sorted.length !== pieces.length ? ` of ${pieces.length}` : ''}
              </div>
            </div>

            {grouped && letters.length > 3 && (
              <nav aria-label="Jump to letter" className="hidden sm:flex flex-col items-center gap-0.5 sticky top-0 self-start text-[11px] leading-none">
                {letters.map((l) => (
                  <button
                    key={l}
                    type="button"
                    onClick={() => jumpTo(l)}
                    className="w-6 h-5 rounded text-muted-foreground hover:text-foreground hover:bg-accent"
                  >
                    {l}
                  </button>
                ))}
              </nav>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** A table row, optionally preceded by a letter heading row. Fragment-free so
 *  the heading can carry the scroll-target id. */
function RowGroup({ letter, children }: { letter: string | null; children: React.ReactNode }) {
  return (
    <>
      {letter && (
        <tr id={`letter-${letter}`} className="bg-muted/40 scroll-mt-2">
          <th scope="rowgroup" colSpan={3} className={cn('text-left text-xs font-semibold px-4 py-1 text-muted-foreground')}>{letter}</th>
        </tr>
      )}
      {children}
    </>
  );
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden>
      <path d="M4 12.5 9.5 18 20 6.5" />
    </svg>
  );
}
