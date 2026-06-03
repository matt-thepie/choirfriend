import { useEffect, useState } from 'react';
import { PdfViewer } from '@/components/PdfViewer/index.ts';
import { AudioPlayer } from '@/components/AudioPlayer/index.ts';
import { Piano } from '@/components/Piano/index.ts';
import { HomeScreen } from '@/components/HomeScreen.tsx';
import { ImportScreen } from '@/components/ImportScreen.tsx';
import { SignInScreen } from '@/components/SignInScreen.tsx';
import { usePieces } from '@/hooks/usePieces.ts';

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
 * Auth gate:
 *   - While /auth/me is still loading, render nothing (avoid flicker).
 *   - If not signed in, render <SignInScreen /> only. Don't even fetch the
 *     repertoire — saves a 401 in the console and forces a real session
 *     before showing any choir data.
 *
 * Views (when signed in):
 *   - home — search across two lists: active repertoire + all other songs.
 *   - piece — open piece: PdfViewer + AudioPlayer + (toggleable) Piano.
 *
 * Display modes (only meaningful in piece view):
 *   - edit (default): full toolbar, scroll all pages.
 *   - read ("perform"): minimal toolbar, page-turn nav by default. App
 *     header hides; Exit button on the viewer's minimal toolbar is the
 *     canonical way out (Esc also works for desktop users).
 *
 * Write operations (create piece, upload files, move in/out of repertoire,
 * delete files) are gated server-side behind `requireAdmin` (members of any
 * ADMIN_ROLES group). The client mirrors that by hiding write UI when
 * me.isAdmin is false — keeps the UI honest and avoids buttons that 403.
 */
export function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [me, setMe] = useState<MeResponse | null>(null);
  const [meLoaded, setMeLoaded] = useState(false);

  useEffect(() => {
    fetch('/api/health').then((r) => r.json()).then(setHealth).catch(() => setHealth(null));
    fetch('/auth/me', { credentials: 'include' })
      .then((r) => r.json())
      .then(setMe)
      .catch(() => setMe({ signedIn: false }))
      .finally(() => setMeLoaded(true));
  }, []);

  // Until /auth/me resolves, render nothing — avoids a flash of the sign-in
  // screen before the cookie check completes.
  if (!meLoaded) {
    return <div className="h-screen" />;
  }

  // Not signed in → sign-in only. Don't touch repertoire endpoints.
  if (!me?.signedIn) {
    return <SignInScreen />;
  }

  return <SignedInApp me={me} health={health} />;
}

function SignedInApp({ me, health }: { me: MeResponse; health: HealthResponse | null }) {
  const { pieces, loading: piecesLoading, refresh: refreshPieces } = usePieces();
  const [pieceId, setPieceId] = useState<number | null>(null);
  const [pianoOpen, setPianoOpen] = useState(false);
  const [readMode, setReadMode] = useState(false);
  const [importing, setImporting] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const isAdmin = me.isAdmin === true;
  const currentPiece = pieces.find((p) => p.id === pieceId) ?? null;

  const [pieceRefreshTick, setPieceRefreshTick] = useState(0);
  function bumpPieceRefresh(): void {
    setPieceRefreshTick((t) => t + 1);
    refreshPieces();
  }

  function goHome(): void {
    setPieceId(null);
    setReadMode(false);
    setImporting(false);
  }

  const view: 'home' | 'piece' = pieceId === null ? 'home' : 'piece';

  return (
    <div className="h-dvh flex flex-col">
      {!readMode && (
        <header className="px-3 py-2 border-b border-border flex items-center gap-2 text-sm shrink-0">
          {view === 'piece' ? (
            <button
              type="button"
              onClick={goHome}
              className="inline-flex items-center gap-1.5 font-medium hover:opacity-80 shrink-0"
              aria-label="Back to song list"
            >
              <BackIcon /> Songs
            </button>
          ) : (
            <span className="font-semibold">choirfriend</span>
          )}

          {view === 'piece' && currentPiece && (
            <span className="font-semibold truncate min-w-0">{currentPiece.title}</span>
          )}

          <div className="ml-auto relative shrink-0">
            <button
              type="button"
              onClick={() => setMenuOpen((o) => !o)}
              aria-label="Menu"
              aria-expanded={menuOpen}
              className="inline-flex items-center justify-center w-9 h-9 rounded-md border border-border hover:bg-accent"
            >
              <MenuIcon />
            </button>
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-20" onClick={() => setMenuOpen(false)} aria-hidden />
                <div className="absolute right-0 top-full mt-1 w-56 bg-background border border-border rounded-md shadow-lg z-30 p-1">
                  {view === 'piece' && (
                    <>
                      <MenuItem
                        icon={<PianoIcon />}
                        label="Piano"
                        active={pianoOpen}
                        onClick={() => {
                          setPianoOpen((o) => !o);
                          setMenuOpen(false);
                        }}
                      />
                      <MenuItem
                        icon={<ReadIcon />}
                        label="Read mode"
                        active={readMode}
                        onClick={() => {
                          setReadMode((r) => !r);
                          setMenuOpen(false);
                        }}
                      />
                      <div className="h-px bg-border my-1" />
                    </>
                  )}
                  <div className="px-3 py-1.5 text-xs text-muted-foreground">
                    Signed in as {me.displayName ?? me.email}
                    {isAdmin && <span className="ml-1 uppercase tracking-wide font-semibold text-amber-700">admin</span>}
                  </div>
                  <div className="px-3 py-1 text-xs text-muted-foreground flex items-center gap-1.5">
                    <span className={`inline-block w-2 h-2 rounded-full ${health?.database === 'ok' ? 'bg-emerald-500' : 'bg-amber-500'}`} />
                    server {health?.database ?? '…'}
                  </div>
                </div>
              </>
            )}
          </div>
        </header>
      )}

      <main className="flex-1 min-h-0 flex flex-col">
        {importing ? (
          <ImportScreen
            onClose={() => {
              setImporting(false);
              refreshPieces();
            }}
          />
        ) : view === 'home' ? (
          <HomeScreen
            pieces={pieces}
            loading={piecesLoading}
            isAdmin={isAdmin}
            onOpenPiece={setPieceId}
            onPieceMutated={refreshPieces}
            onImport={isAdmin ? () => setImporting(true) : undefined}
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
                isAdmin={isAdmin}
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

function MenuItem({
  label,
  icon,
  active,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 px-3 py-2 rounded text-sm hover:bg-accent text-left"
    >
      <span className="inline-flex text-muted-foreground">{icon}</span>
      <span className="flex-1">{label}</span>
      {active && (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-primary" aria-hidden>
          <path d="M5 12l5 5L20 7" />
        </svg>
      )}
    </button>
  );
}

function MenuIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <line x1="4" y1="7" x2="20" y2="7" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="4" y1="17" x2="20" y2="17" />
    </svg>
  );
}

function BackIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden>
      <path d="M15 6l-6 6 6 6" />
    </svg>
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
