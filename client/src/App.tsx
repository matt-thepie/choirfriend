import { useEffect, useState } from 'react';
import { PdfViewer } from '@/components/PdfViewer/index.ts';
import { AudioPlayer } from '@/components/AudioPlayer/index.ts';
import { Piano } from '@/components/Piano/index.ts';
import { PiecePicker } from '@/components/PiecePicker.tsx';
import { HomeScreen } from '@/components/HomeScreen.tsx';
import { usePieces } from '@/hooks/usePieces.ts';
import { cn } from '@/lib/utils.ts';

interface HealthResponse {
  status: string;
  database: 'ok' | 'unreachable';
}

interface MeResponse {
  signedIn: boolean;
  email?: string;
  displayName?: string;
  groups?: string[];
  isAdmin?: boolean;
}

/**
 * App shell.
 *
 * Views:
 *   - home — the landing page; searchable repertoire list with current/archive
 *     filter, "new piece", and (for admins) inline current↔archive toggle.
 *   - piece — the open piece: PdfViewer + AudioPlayer + (toggleable) Piano.
 *
 * Display modes (only meaningful in piece view):
 *   - edit (default): header visible, full toolbar, scroll all pages.
 *   - read ("perform"): header hidden, minimal toolbar, page-turn nav by
 *     default (scroll on narrow viewports).
 */
export function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [me, setMe] = useState<MeResponse | null>(null);

  const { pieces, loading: piecesLoading, refresh: refreshPieces } = usePieces();
  const [pieceId, setPieceId] = useState<number | null>(null);
  const [pianoOpen, setPianoOpen] = useState(false);
  const [readMode, setReadMode] = useState(false);

  const [pieceRefreshTick, setPieceRefreshTick] = useState(0);
  function bumpPieceRefresh(): void {
    setPieceRefreshTick((t) => t + 1);
    refreshPieces();
  }

  function goHome(): void {
    setPieceId(null);
    setReadMode(false);
  }

  useEffect(() => {
    fetch('/api/health').then((r) => r.json()).then(setHealth).catch(() => setHealth(null));
    fetch('/auth/me', { credentials: 'include' }).then((r) => r.json()).then(setMe).catch(() => setMe(null));
  }, []);

  const view: 'home' | 'piece' = pieceId === null ? 'home' : 'piece';

  return (
    <div className="h-screen flex flex-col">
      {!readMode && (
        <header className="px-4 py-2 border-b border-border flex items-center gap-3 text-sm flex-wrap">
          <button
            type="button"
            onClick={goHome}
            className="font-semibold hover:opacity-80"
            aria-label="Go to home"
          >
            choirfriend
          </button>

          {view === 'piece' && (
            <>
              <span className="text-muted-foreground" aria-hidden>·</span>
              <button
                type="button"
                onClick={goHome}
                className="text-xs underline text-muted-foreground hover:text-foreground"
              >
                Home
              </button>
              <PiecePicker
                pieces={pieces}
                loading={piecesLoading}
                selectedId={pieceId}
                onSelect={setPieceId}
                onCreated={refreshPieces}
              />
            </>
          )}

          <div className="h-6 w-px bg-border mx-1" />

          <ToolToggle
            label="Piano"
            icon={<PianoIcon />}
            active={pianoOpen}
            onToggle={() => setPianoOpen((o) => !o)}
          />
          <ToolToggle
            label="Read mode"
            icon={<ReadIcon />}
            active={readMode}
            onToggle={() => setReadMode((r) => !r)}
            disabled={pieceId === null}
          />

          <div className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
            {me?.signedIn ? (
              <span>
                Signed in as {me.displayName}
                {me.isAdmin && <span className="ml-1 text-[10px] uppercase tracking-wide font-semibold text-amber-700">admin</span>}
              </span>
            ) : (
              <a href="/auth/login" className="underline hover:text-foreground">Sign in</a>
            )}
            <span title={`server: ${health?.status ?? '?'} · db: ${health?.database ?? '?'}`}>
              <span className={`inline-block w-2 h-2 rounded-full mr-1 ${health?.database === 'ok' ? 'bg-emerald-500' : 'bg-amber-500'}`} />
              {health ? `server ${health.database}` : 'server …'}
            </span>
          </div>
        </header>
      )}

      <main className="flex-1 min-h-0 flex flex-col">
        {view === 'home' ? (
          <HomeScreen
            pieces={pieces}
            loading={piecesLoading}
            isAdmin={me?.isAdmin === true}
            onOpenPiece={setPieceId}
            onPieceMutated={refreshPieces}
          />
        ) : (
          <>
            <div className="flex-1 min-h-0">
              <PdfViewer
                pieceId={pieceId!}
                refreshTick={pieceRefreshTick}
                onPieceMutated={bumpPieceRefresh}
                readMode={readMode}
                onExitReadMode={() => setReadMode(false)}
              />
            </div>
            {pianoOpen && <Piano onClose={() => setPianoOpen(false)} />}
            <AudioPlayer pieceId={pieceId} refreshTick={pieceRefreshTick} />
          </>
        )}
      </main>
    </div>
  );
}

interface ToolToggleProps {
  label: string;
  icon: React.ReactNode;
  active: boolean;
  onToggle: () => void;
  disabled?: boolean;
}

function ToolToggle({ label, icon, active, onToggle, disabled }: ToolToggleProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={active}
      disabled={disabled}
      className={cn(
        'inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md border text-xs font-medium transition-colors',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        active
          ? 'bg-primary text-primary-foreground border-primary'
          : 'border-border bg-background hover:bg-accent',
      )}
    >
      <span className="inline-flex">{icon}</span>
      <span>{label}</span>
    </button>
  );
}

function PianoIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <rect x="3" y="6" width="18" height="12" rx="1" />
      <line x1="9" y1="6" x2="9" y2="18" />
      <line x1="15" y1="6" x2="15" y2="18" />
      <rect x="7" y="6" width="4" height="6" fill="currentColor" stroke="none" />
      <rect x="13" y="6" width="4" height="6" fill="currentColor" stroke="none" />
    </svg>
  );
}

function ReadIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path d="M3 5h6a3 3 0 0 1 3 3v13" />
      <path d="M21 5h-6a3 3 0 0 0-3 3v13" />
      <path d="M3 5v13" />
      <path d="M21 5v13" />
    </svg>
  );
}
