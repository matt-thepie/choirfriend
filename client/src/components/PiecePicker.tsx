import { useState } from 'react';
import { Button } from '@/components/ui/button.tsx';
import { createPiece, type PieceSummary } from '@/hooks/usePieces.ts';

interface PiecePickerProps {
  pieces: PieceSummary[];
  loading: boolean;
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  onCreated: () => void;
  /** Hide the "+ New piece" affordance for non-admins. Server gates the
   *  POST regardless; this just keeps the UI honest. */
  canCreate?: boolean;
}

/**
 * The compact piece picker that lives in the app header.
 *
 * Default state is a `<select>` listing every piece. The "New piece" button
 * flips it into an inline form (title + composer). On create, we refresh
 * the list and select the new piece.
 */
export function PiecePicker({
  pieces,
  loading,
  selectedId,
  onSelect,
  onCreated,
  canCreate = false,
}: PiecePickerProps) {
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [composer, setComposer] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCreate(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!title.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const piece = await createPiece({
        title: title.trim(),
        composer: composer.trim() || undefined,
      });
      setTitle('');
      setComposer('');
      setCreating(false);
      onCreated();
      onSelect(piece.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  if (creating && canCreate) {
    return (
      <form onSubmit={handleCreate} className="flex items-center gap-2">
        <input
          type="text"
          required
          autoFocus
          placeholder="Title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="text-sm h-8 px-2 rounded-md border border-border bg-background w-44"
        />
        <input
          type="text"
          placeholder="Composer (optional)"
          value={composer}
          onChange={(e) => setComposer(e.target.value)}
          className="text-sm h-8 px-2 rounded-md border border-border bg-background w-44"
        />
        <Button size="sm" type="submit" disabled={submitting || !title.trim()}>
          {submitting ? 'Creating…' : 'Create'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          type="button"
          onClick={() => {
            setCreating(false);
            setTitle('');
            setComposer('');
            setError(null);
          }}
          disabled={submitting}
        >
          Cancel
        </Button>
        {error && <span className="text-xs text-destructive">{error}</span>}
      </form>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <select
        value={selectedId ?? ''}
        onChange={(e) => onSelect(e.target.value === '' ? null : Number(e.target.value))}
        className="text-sm h-8 px-2 rounded-md border border-border bg-background min-w-48"
        disabled={loading}
      >
        <option value="">{loading ? 'Loading…' : '— pick a piece —'}</option>
        {pieces.map((p) => (
          <option key={p.id} value={p.id}>
            {p.title}
            {p.composer ? ` — ${p.composer}` : ''}
          </option>
        ))}
      </select>
      {canCreate && (
        <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
          + New piece
        </Button>
      )}
    </div>
  );
}
