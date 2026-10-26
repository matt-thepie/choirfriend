import { useEffect, useState } from 'react';
import { PdfViewer } from '@/components/PdfViewer/index.ts';
import { Piano } from '@/components/Piano/index.ts';
import { RepertoireScreen } from '@/components/RepertoireScreen.tsx';
import { ImportScreen } from '@/components/ImportScreen.tsx';
import { SignInScreen } from '@/components/SignInScreen.tsx';
import { SetListsScreen } from '@/components/SetListsScreen.tsx';
import { SetListScreen } from '@/components/SetListScreen.tsx';
import { SongScreen } from '@/components/SongScreen.tsx';
import { PlayerBar } from '@/components/Player/PlayerBar.tsx';
import { PlayerProvider } from '@/player/PlayerContext.tsx';
import { usePieces } from '@/hooks/usePieces.ts';
import { useSections, saveMySection } from '@/hooks/useSections.ts';
import { useSetLists } from '@/hooks/useSetLists.ts';
import { Icon } from '@/components/ui/button.tsx';

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
  canSeeScores?: boolean;
  sectionId?: number | null;
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
 *   - home — the repertoire table (Set lists is the default tab).
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

  return (
    <PlayerProvider>
      <SignedInApp me={me} health={health} />
    </PlayerProvider>
  );
}

function SignedInApp({ me, health }: { me: MeResponse; health: HealthResponse | null }) {
  const { pieces, loading: piecesLoading, refresh: refreshPieces } = usePieces();
  const { sections } = useSections();
  const { setLists, loading: setListsLoading, refresh: refreshSetLists } = useSetLists();
  const [pieceId, setPieceId] = useState<number | null>(null);
  /** A PDF open in the annotating viewer (null = the song page). */
  const [viewerFileId, setViewerFileId] = useState<number | null>(null);
  /** null = not in set list area; 0 = virtual "All songs"; >0 = a stored list. */
  const [setListId, setSetListId] = useState<number | null>(null);
  // ChoirMate lands members on Set lists; Repertoire is the other view.
  const [tab, setTab] = useState<'songs' | 'setlists'>('setlists');
  // Admins flip between the member layout (view mode) and the admin layout
  // (edit mode). Members never see the toggle. Remembered for the session.
  const [editMode, setEditMode] = useState<boolean>(() => {
    try { return sessionStorage.getItem('choirfriend.editMode') === '1'; } catch { return false; }
  });
  function toggleEditMode(): void {
    setEditMode((v) => {
      try { sessionStorage.setItem('choirfriend.editMode', v ? '0' : '1'); } catch { /* ignore */ }
      return !v;
    });
  }
  const [pianoOpen, setPianoOpen] = useState(false);
  const [readMode, setReadMode] = useState(false);
  const [importing, setImporting] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [partMenuOpen, setPartMenuOpen] = useState(false);
  const [mySectionId, setMySectionId] = useState<number | null>(me.sectionId ?? null);
  const isAdmin = me.isAdmin === true;
  // Admin controls only render in edit mode — view mode is exactly what members get.
  const editing = isAdmin && editMode;
  const currentPiece = pieces.find((p) => p.id === pieceId) ?? null;

  const [pieceRefreshTick, setPieceRefreshTick] = useState(0);
  function bumpPieceRefresh(): void {
    setPieceRefreshTick((t) => t + 1);
    refreshPieces();
  }

  function goHome(): void {
    setPieceId(null);
    setViewerFileId(null);
    setReadMode(false);
    setImporting(false);
    if (tab === 'songs') setSetListId(null);
  }

  function openPiece(id: number): void {
    setPieceId(id);
    setViewerFileId(null);
    setReadMode(false);
  }

  function closeViewer(): void {
    setViewerFileId(null);
    setReadMode(false);
  }

  async function chooseSection(id: number | null): Promise<void> {
    setMySectionId(id);
    setPartMenuOpen(false);
    setMenuOpen(false);
    try {
      await saveMySection(id);
    } catch {
      /* best effort — the local choice still applies for this session */
    }
  }

  const view: 'home' | 'setlists' | 'setlist' | 'piece' | 'viewer' =
    pieceId !== null ? (viewerFileId !== null ? 'viewer' : 'piece') : tab === 'setlists' ? (setListId === null ? 'setlists' : 'setlist') : 'home';
  const currentSetList = setListId !== null && setListId > 0 ? setLists.find((s) => s.id === setListId) ?? null : null;
  const mySection = sections.find((s) => s.id === mySectionId) ?? null;

  return (
    <div className="h-dvh flex flex-col">
      {!readMode && (
        <header className="bg-background border-b border-border shadow-sm shrink-0 h-14 md:h-16 px-4 flex items-center gap-3 text-base">
          {view === 'viewer' ? (
            <button
              type="button"
              onClick={closeViewer}
              className="inline-flex items-center gap-1 font-medium hover:text-accent-foreground shrink-0 h-11 -ml-2 px-2 rounded-md"
              aria-label="Back to song"
            >
              <Icon name="arrow_back" /> Song
            </button>
          ) : view === 'piece' ? (
            <button
              type="button"
              onClick={goHome}
              className="inline-flex items-center gap-1 font-medium hover:text-accent-foreground shrink-0 h-11 -ml-2 px-2 rounded-md"
              aria-label="Back"
            >
              <Icon name="arrow_back" /> {setListId !== null ? 'Set list' : 'Repertoire'}
            </button>
          ) : (
            <>
              <span className="inline-flex items-center shrink-0"><img src="/brand/choirfriend-icon.svg" alt="choirfriend" width="26" height="26" className="rounded-md sm:hidden dark:sm:block" /><img src="/brand/choirfriend-wordmark.svg" alt="choirfriend" className="h-7 hidden sm:block dark:sm:hidden" /></span>
            </>
          )}

          {(view === 'piece' || view === 'viewer') && currentPiece && (
            <span className="font-semibold truncate min-w-0">{currentPiece.title}</span>
          )}

          {isAdmin && (
            <button
              type="button"
              onClick={toggleEditMode}
              className={`ml-auto shrink-0 h-10 px-3 rounded-md border text-sm font-medium transition-colors ${editing ? 'border-primary bg-accent text-accent-foreground' : 'border-border hover:bg-accent'}`}
              aria-pressed={editing}
            >
              {editing ? 'Switch to view mode' : 'Switch to edit mode'}
            </button>
          )}
          <div className={`${isAdmin ? 'ml-2' : 'ml-auto'} relative shrink-0`}>
            <button
              type="button"
              onClick={() => { setMenuOpen((o) => !o); setPartMenuOpen(false); }}
              aria-label="Menu"
              aria-expanded={menuOpen}
              className="inline-flex items-center justify-center w-11 h-11 rounded-md hover:bg-accent text-muted-foreground"
            >
              <Icon name="menu" />
            </button>
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-20" onClick={() => setMenuOpen(false)} aria-hidden />
                <div className="absolute right-0 top-full mt-2 w-64 card shadow-float z-30 p-1">
                  {(view === 'piece' || view === 'viewer') && (
                    <>
                      <MenuItem
                        icon={<Icon name="piano" className="text-xl" />}
                        label="Piano"
                        active={pianoOpen}
                        onClick={() => {
                          setPianoOpen((o) => !o);
                          setMenuOpen(false);
                        }}
                      />
                      {view === 'viewer' && (
                        <MenuItem
                          icon={<Icon name="auto_stories" className="text-xl" />}
                          label="Read mode"
                          active={readMode}
                          onClick={() => {
                            setReadMode((r) => !r);
                            setMenuOpen(false);
                          }}
                        />
                      )}
                      <div className="h-px bg-border my-1" />
                    </>
                  )}

                  <MenuItem
                    icon={<Icon name="person" className="text-xl" />}
                    label={mySection ? `My part: ${mySection.label}` : 'My part: not set'}
                    onClick={() => setPartMenuOpen((o) => !o)}
                  />
                  {partMenuOpen && (
                    <div className="ml-6 mb-1 border-l border-border pl-1">
                      {sections.map((s) => (
                        <MenuItem key={s.id} icon={<span className="text-xs font-bold w-4 text-center">{s.badge}</span>} label={s.label} active={s.id === mySectionId} onClick={() => void chooseSection(s.id)} />
                      ))}
                      <MenuItem icon={<span className="w-4" />} label="Not set" active={mySectionId === null} onClick={() => void chooseSection(null)} />
                    </div>
                  )}
                  <div className="h-px bg-border my-1" />

                  <div className="px-3 py-1.5 text-xs text-muted-foreground">
                    Signed in as {me.displayName ?? me.email}
                    {isAdmin && <span className="ml-1 uppercase tracking-wide font-semibold text-accent-foreground">admin</span>}
                  </div>
                  <div className="px-3 py-1 text-xs text-muted-foreground flex items-center gap-1.5">
                    <span className={`inline-block w-2 h-2 rounded-full ${health?.database === 'ok' ? 'bg-primary' : 'bg-destructive'}`} />
                    server {health?.database ?? '…'}
                  </div>
                </div>
              </>
            )}
          </div>
        </header>
      )}

      <main className="flex-1 min-h-0 flex flex-col">
        {!readMode && (view === 'home' || view === 'setlists') && !importing && (
          <div className="max-w-(--max) w-full mx-auto px-4 sm:px-6 pt-5">
            <nav className="inline-flex items-center rounded-full bg-black/20 p-1" aria-label="Set lists and repertoire">
              <TabButton active={tab === 'setlists'} onClick={() => { setTab('setlists'); setSetListId(null); }}>Set lists</TabButton>
              <TabButton active={tab === 'songs'} onClick={() => { setTab('songs'); setSetListId(null); }}>Repertoire</TabButton>
            </nav>
          </div>
        )}
        {importing ? (
          <ImportScreen
            onClose={() => {
              setImporting(false);
              refreshPieces();
            }}
          />
        ) : view === 'home' ? (
          <RepertoireScreen
            pieces={pieces}
            loading={piecesLoading}
            editing={editing}
            onOpenPiece={openPiece}
            onPieceMutated={refreshPieces}
            onImport={editing ? () => setImporting(true) : undefined}
          />
        ) : view === 'setlists' ? (
          <SetListsScreen
            setLists={setLists}
            loading={setListsLoading}
            isAdmin={editing}
            onOpen={setSetListId}
            onMutated={refreshSetLists}
          />
        ) : view === 'setlist' ? (
          <SetListScreen
            key={setListId!}
            setListId={setListId!}
            pieces={pieces}
            sections={sections}
            mySectionId={mySectionId}
            isAdmin={editing}
            onBack={() => setSetListId(null)}
            onOpenPiece={openPiece}
            onMutated={refreshSetLists}
            onOpenSetList={setSetListId}
          />
        ) : view === 'piece' ? (
          <>
            <div className="flex-1 min-h-0">
              <SongScreen
                pieceId={pieceId!}
                refreshTick={pieceRefreshTick}
                sections={sections}
                mySectionId={mySectionId}
                editing={editing}
                fromSetList={currentSetList ? { id: currentSetList.id, name: currentSetList.name } : setListId === 0 ? { id: 0, name: 'All songs' } : null}
                onGoSetLists={() => { setPieceId(null); setTab('setlists'); setSetListId(null); }}
                onGoRepertoire={() => { setPieceId(null); setTab('songs'); setSetListId(null); }}
                onGoSetList={(id) => { setPieceId(null); setTab('setlists'); setSetListId(id); }}
                onOpenViewer={setViewerFileId}
                onPieceMutated={bumpPieceRefresh}
              />
            </div>
            {pianoOpen && <Piano onClose={() => setPianoOpen(false)} />}
          </>
        ) : (
          <>
            <div className="flex-1 min-h-0">
              <PdfViewer
                key={viewerFileId!}
                pieceId={pieceId!}
                initialFileId={viewerFileId}
                refreshTick={pieceRefreshTick}
                onPieceMutated={bumpPieceRefresh}
                readMode={readMode}
                onExitReadMode={() => setReadMode(false)}
                isAdmin={editing}
              />
            </div>
            {pianoOpen && <Piano onClose={() => setPianoOpen(false)} />}
          </>
        )}
      </main>

      {!readMode && <PlayerBar onOpenPiece={openPiece} />}
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={`h-10 px-5 rounded-full text-base font-medium transition-colors ${active ? 'bg-card text-foreground shadow-sm' : 'text-on-field hover:bg-white/10'}`}
    >
      {children}
    </button>
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




