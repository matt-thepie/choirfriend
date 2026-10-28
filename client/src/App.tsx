import { useEffect, useRef, useState } from 'react';
import { formatRoute, parseRoute, type Route } from '@/router.ts';
import { PdfViewer } from '@/components/PdfViewer/index.ts';
import { Piano } from '@/components/Piano/index.ts';
import { RepertoireScreen } from '@/components/RepertoireScreen.tsx';
import { ImportScreen } from '@/components/ImportScreen.tsx';
import { SignInScreen } from '@/components/SignInScreen.tsx';
import { SetListsScreen } from '@/components/SetListsScreen.tsx';
import { SetListScreen } from '@/components/SetListScreen.tsx';
import { SongScreen } from '@/components/SongScreen.tsx';
import { PlayerBar } from '@/components/Player/PlayerBar.tsx';
import { PlayerProvider, usePlayer } from '@/player/PlayerContext.tsx';
import { usePieces } from '@/hooks/usePieces.ts';
import { useSections, saveMySection, saveMyPartLine } from '@/hooks/useSections.ts';
import { useSetLists } from '@/hooks/useSetLists.ts';
import { fetchDefaultView, setPreferFlowing, useSetListFlow } from '@/hooks/useSetListFlow.ts';
import { ScoreViewer } from '@/components/ScoreViewer/index.ts';
import type { ViewTarget } from '@/components/ViewSwitcher.tsx';
import { Icon } from '@/components/ui/button.tsx';
import { useOfflineScores } from '@/hooks/useOfflineScores.ts';
import { useInstallPrompt } from '@/hooks/useInstallPrompt.ts';
import { formatMB, type OfflineScope } from '@/lib/offline.ts';

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
  features?: { confidence?: boolean };
  sectionId?: number | null;
  /** Part comes from the SGMC identity profile; not editable here. */
  sectionFromIdentity?: boolean;
  /** "My line" highlighting is switched on. */
  partLine?: boolean;
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
  // Where we are is URL state (see router.ts) so back/forward, reload and
  // shared links work. ChoirMate lands members on Set lists.
  const [route, setRouteState] = useState<Route>(() => parseRoute(window.location));
  const routeRef = useRef(route);
  routeRef.current = route;
  const { pieceId, viewerFileId, setListId, tab, readMode, flow } = route;
  function navigate(patch: Partial<Route>, replace = false): void {
    const next: Route = { ...routeRef.current, ...patch };
    if (next.viewerFileId === null) next.flow = false;
    const url = formatRoute(next);
    if (url !== formatRoute(routeRef.current)) window.history[replace ? 'replaceState' : 'pushState']({}, '', url);
    routeRef.current = next;
    setRouteState(next);
  }
  useEffect(() => {
    // Normalise whatever URL we loaded on, then follow back/forward.
    window.history.replaceState({}, '', formatRoute(routeRef.current));
    const onPop = () => setRouteState(parseRoute(window.location));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const setSetListId = (id: number | null) => navigate({ setListId: id });
  // Opening a score goes straight into read mode: reading is the common case.
  const setViewerFileId = (id: number | null) => navigate({ viewerFileId: id, flow: false, readMode: id !== null });
  const openFlowing = (id: number) => navigate({ viewerFileId: id, flow: true, readMode: true });
  // Switching between a song's PDFs and flowing scores from inside the viewer.
  function openView(target: ViewTarget): void {
    setPreferFlowing(target.kind === 'flow');
    navigate({ viewerFileId: target.id, flow: target.kind === 'flow' });
  }
  const setReadMode = (on: boolean) => navigate({ readMode: on });
  // Read mode keeps the player bar if something is loaded; the viewer's
  // headphones button tucks it away or brings it back.
  const [readPlayerHidden, setReadPlayerHidden] = useState(false);
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
  const [importing, setImporting] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [partMenuOpen, setPartMenuOpen] = useState(false);
  const offline = useOfflineScores(true);
  const installer = useInstallPrompt();
  const [offlineOpen, setOfflineOpen] = useState(false);
  const [installHelp, setInstallHelp] = useState(false);
  const [installBannerHidden, setInstallBannerHidden] = useState(() => {
    try {
      return localStorage.getItem('choirfriend.installBanner') === 'dismissed';
    } catch {
      return false;
    }
  });
  function dismissInstallBanner(): void {
    setInstallBannerHidden(true);
    try {
      localStorage.setItem('choirfriend.installBanner', 'dismissed');
    } catch {
      /* storage blocked */
    }
  }
  const offerInstall = installer.canPrompt || installer.iosInstructions;
  const [mySectionId, setMySectionId] = useState<number | null>(me.sectionId ?? null);
  const [selectedSectionId, setSelectedSectionId] = useState<number | null>(me.sectionId ?? null);
  const [partLine, setPartLineState] = useState(me.partLine === true);
  const setPartLine = (on: boolean): void => {
    setPartLineState(on);
    void saveMyPartLine(on).catch(() => setPartLineState(!on));
  };
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
    setImporting(false);
    navigate({ pieceId: null, viewerFileId: null, readMode: false, setListId: tab === 'songs' ? null : setListId });
  }

  function openPiece(id: number): void {
    navigate({ pieceId: id, viewerFileId: null, readMode: false });
  }

  // Opened from a set list, the viewer can turn straight into the next song.
  const setListFlow = useSetListFlow(viewerFileId !== null ? setListId : null, pieceId);
  async function openSongInViewer(id: number): Promise<void> {
    const view = await fetchDefaultView(id).catch(() => null);
    // A song with no sheet music opens on its song page instead.
    navigate({ pieceId: id, viewerFileId: view?.fileId ?? null, flow: view?.flow ?? false, readMode: view ? readMode : false });
  }

  // When the player is playing the set list this score came from, the two move
  // together: the player reaching the next song opens its score, and turning
  // the score into the next song cues that song's track, paused, ready to play.
  const player = usePlayer();
  const linkedQueue = viewerFileId !== null && setListId !== null && player.queue?.setListId === setListId ? player.queue : null;
  const playerPieceId = linkedQueue ? player.current?.pieceId ?? null : null;
  const lastPlayerPieceRef = useRef(playerPieceId);
  useEffect(() => {
    const was = lastPlayerPieceRef.current;
    lastPlayerPieceRef.current = playerPieceId;
    if (playerPieceId === null || was === null || playerPieceId === was || playerPieceId === pieceId) return;
    void openSongInViewer(playerPieceId);
    // Only the player moving should open a score.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playerPieceId]);
  // Opening a score isn't a turn, so only a song change while the linked score
  // was already open counts.
  const viewerPieceId = linkedQueue ? pieceId : null;
  const lastViewerPieceRef = useRef(viewerPieceId);
  useEffect(() => {
    const was = lastViewerPieceRef.current;
    lastViewerPieceRef.current = viewerPieceId;
    if (!linkedQueue || viewerPieceId === null || was === null || viewerPieceId === was || player.current?.pieceId === viewerPieceId) return;
    const i = linkedQueue.tracks.findIndex((t) => t.pieceId === viewerPieceId);
    if (i >= 0) player.cue(i);
    // Only the score moving should cue a track.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewerPieceId]);

  function closeViewer(): void {
    navigate({ viewerFileId: null, readMode: false });
  }

  async function chooseSection(id: number | null): Promise<void> {
    setMySectionId(id);
    setSelectedSectionId(id);
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
    <div className="h-dvh flex flex-col pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]">
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
              <span className="inline-flex items-center shrink-0"><img src="/brand/choirfriend-icon.svg" alt="choirfriend" width="28" height="28" className="rounded-md sm:hidden" /><img src="/brand/choirfriend-logo.svg" alt="choirfriend — Solent Gay Men’s Chorus" className="h-9 md:h-10 hidden sm:block dark:sm:hidden" /><img src="/brand/choirfriend-logo-white.svg" alt="choirfriend — Solent Gay Men’s Chorus" className="h-9 md:h-10 hidden dark:sm:block" /></span>
            </>
          )}

          {(view === 'piece' || view === 'viewer') && currentPiece && (
            <span className="font-semibold truncate min-w-0">{currentPiece.title}</span>
          )}

          {isAdmin && (
            <button
              type="button"
              onClick={toggleEditMode}
              className={`ml-auto shrink-0 inline-flex items-center gap-1.5 h-10 px-3 rounded-md border text-sm font-medium transition-colors ${editing ? 'border-primary bg-primary text-primary-foreground hover:opacity-90' : 'border-border bg-background text-foreground hover:bg-accent hover:text-accent-foreground'}`}
              aria-pressed={editing}
            >
              {/* A toggle: the label never changes, the fill shows it's on. */}
              <Icon name={editing ? 'check' : 'edit'} className="text-lg" />
              Edit mode
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
                      <div className="h-px bg-border my-1" />
                    </>
                  )}

                  <MenuItem
                    icon={<Icon name="person" className="text-xl" />}
                    label={mySection ? `My part: ${mySection.label}` : 'My part: not set'}
                    onClick={() => setPartMenuOpen((o) => !o)}
                  />
                  {partMenuOpen && me.sectionFromIdentity && (
                    <div className="ml-6 mb-1 px-3 py-1.5 text-sm text-muted-foreground">
                      Set in your SGMC profile. Ask the membership secretary to change it.
                    </div>
                  )}
                  {partMenuOpen && !me.sectionFromIdentity && (
                    <div className="ml-6 mb-1 border-l border-border pl-1">
                      {sections.map((s) => (
                        <MenuItem key={s.id} icon={<span className="text-xs font-bold w-4 text-center">{s.badge}</span>} label={s.label} active={s.id === mySectionId} onClick={() => void chooseSection(s.id)} />
                      ))}
                      <MenuItem icon={<span className="w-4" />} label="Not set" active={mySectionId === null} onClick={() => void chooseSection(null)} />
                    </div>
                  )}
                  <div className="h-px bg-border my-1" />

                  {offline.status?.supported && (
                    <>
                      <MenuItem
                        icon={<Icon name={offline.progress ? 'sync' : 'download_for_offline'} className="text-xl" />}
                        label={
                          offline.progress
                            ? `Saving scores ${offline.progress.done} of ${offline.progress.total}`
                            : offline.status.scope === 'off'
                              ? 'Offline scores: off'
                              : `Offline scores: ${offline.status.saved} of ${offline.status.wanted}`
                        }
                        onClick={() => {
                          setOfflineOpen((o) => !o);
                          void offline.refresh();
                        }}
                      />
                      {offlineOpen && (
                        <div className="ml-6 mb-1 border-l border-border pl-1">
                          {([
                            ['setlists', offline.status.scope === 'setlists' ? `Songs on set lists (${formatMB(offline.status.wantedBytes)})` : 'Songs on set lists'],
                            ['all', `All repertoire (${formatMB(offline.status.allBytes)})`],
                            ['off', 'Off'],
                          ] as [OfflineScope, string][]).map(([scope, label]) => (
                            <MenuItem
                              key={scope}
                              icon={<span className="w-4" />}
                              label={label}
                              active={offline.status?.scope === scope}
                              onClick={() => void offline.chooseScope(scope)}
                            />
                          ))}
                          <div className="px-3 py-1.5 text-xs text-muted-foreground">
                            Sheet music is kept on this device so it opens without signal. Learning tracks still need a connection.
                          </div>
                          {offline.status.scope !== 'off' && (
                            <MenuItem
                              icon={<Icon name="sync" className="text-xl" />}
                              label={offline.progress ? 'Syncing…' : 'Sync now'}
                              onClick={() => void offline.sync()}
                            />
                          )}
                        </div>
                      )}
                    </>
                  )}
                  {offerInstall && (
                    <>
                      <MenuItem
                        icon={<Icon name="install_mobile" className="text-xl" />}
                        label="Install app"
                        onClick={() => {
                          if (installer.canPrompt) {
                            setMenuOpen(false);
                            void installer.install();
                          } else setInstallHelp((o) => !o);
                        }}
                      />
                      {installHelp && (
                        <div className="ml-6 mb-1 px-3 py-1.5 text-sm text-muted-foreground">
                          In Safari, tap Share, then Add to Home Screen.
                        </div>
                      )}
                    </>
                  )}
                  {(offline.status?.supported || offerInstall) && <div className="h-px bg-border my-1" />}

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

      {!offline.online && !readMode && (
        <div className="shrink-0 bg-muted text-foreground text-sm text-center px-4 py-1.5" role="status">
          Offline. Saved set lists and scores still open; learning tracks need a connection.
        </div>
      )}
      <main className="flex-1 min-h-0 flex flex-col">
        {view === 'setlists' && !importing && offerInstall && !installBannerHidden && (
          <div className="max-w-(--max) w-full mx-auto px-4 sm:px-6 pt-5">
            <div className="card p-4 flex flex-wrap items-center gap-3">
              <Icon name="install_mobile" className="text-2xl text-primary" />
              <div className="flex-1 min-w-48">
                <div className="font-semibold">Install choirfriend</div>
                <div className="text-sm text-muted-foreground">
                  {installer.canPrompt
                    ? 'Open it from your home screen, with your scores saved for when there is no signal.'
                    : 'In Safari, tap Share, then Add to Home Screen. Your scores are saved for when there is no signal.'}
                </div>
              </div>
              <div className="flex gap-2">
                <button type="button" onClick={dismissInstallBanner} className="h-10 px-3 rounded-md border border-border text-sm font-medium hover:bg-accent">
                  Not now
                </button>
                {installer.canPrompt && (
                  <button type="button" onClick={() => void installer.install()} className="h-10 px-4 rounded-md bg-primary text-primary-foreground text-sm font-semibold">
                    Install
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
        {!readMode && (view === 'home' || view === 'setlists') && !importing && (
          <div className="max-w-(--max) w-full mx-auto px-4 sm:px-6 pt-5">
            <nav className="inline-flex items-center rounded-full bg-black/20 p-1" aria-label="Set lists and repertoire">
              <TabButton active={tab === 'setlists'} onClick={() => navigate({ tab: 'setlists', setListId: null })}>Set lists</TabButton>
              <TabButton active={tab === 'songs'} onClick={() => navigate({ tab: 'songs', setListId: null })}>Repertoire</TabButton>
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
            selectedSectionId={selectedSectionId}
            onSectionChange={setSelectedSectionId}
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
                selectedSectionId={selectedSectionId}
                onSectionChange={setSelectedSectionId}
                editing={editing}
                showConfidence={me.features?.confidence !== false}
                fromSetList={currentSetList ? { id: currentSetList.id, name: currentSetList.name } : setListId === 0 ? { id: 0, name: 'All songs' } : null}
                onGoSetLists={() => navigate({ pieceId: null, viewerFileId: null, readMode: false, tab: 'setlists', setListId: null })}
                onGoRepertoire={() => navigate({ pieceId: null, viewerFileId: null, readMode: false, tab: 'songs', setListId: null })}
                onGoSetList={(id) => navigate({ pieceId: null, viewerFileId: null, readMode: false, tab: 'setlists', setListId: id })}
                onOpenViewer={setViewerFileId}
                onOpenFlowing={openFlowing}
                onPieceMutated={bumpPieceRefresh}
              />
            </div>
            {pianoOpen && <Piano onClose={() => setPianoOpen(false)} />}
          </>
        ) : (
          <>
            <div className="flex-1 min-h-0">
              {flow ? (
              <ScoreViewer
                key={`flow-${viewerFileId!}`}
                pieceId={pieceId!}
                fileId={viewerFileId!}
                refreshTick={pieceRefreshTick}
                readMode={readMode}
                onExitReadMode={() => setReadMode(false)}
                onEnterReadMode={() => setReadMode(true)}
                mySectionId={mySectionId}
                selectedSectionId={selectedSectionId}
                partLineOn={partLine}
                onPartLineChange={setPartLine}
                playerHidden={readPlayerHidden}
                onPlayerHiddenChange={setReadPlayerHidden}
                setListFlow={setListFlow}
                onOpenSong={(id) => void openSongInViewer(id)}
                onOpenView={openView}
                canManage={me.canSeeScores === true}
              />
              ) : (
              <PdfViewer
                key={viewerFileId!}
                pieceId={pieceId!}
                initialFileId={viewerFileId}
                refreshTick={pieceRefreshTick}
                onPieceMutated={bumpPieceRefresh}
                readMode={readMode}
                onExitReadMode={() => setReadMode(false)}
                onEnterReadMode={() => setReadMode(true)}
                isAdmin={editing}
                mySectionId={mySectionId}
                selectedSectionId={selectedSectionId}
                partLineOn={partLine}
                onPartLineChange={setPartLine}
                playerHidden={readPlayerHidden}
                onPlayerHiddenChange={setReadPlayerHidden}
                setListFlow={setListFlow}
                onOpenSong={(id) => void openSongInViewer(id)}
                onOpenView={openView}
              />
              )}
            </div>
            {pianoOpen && <Piano onClose={() => setPianoOpen(false)} />}
          </>
        )}
      </main>

      {/* A flowing score docks its own player here; the recording one swaps in via Listen. */}
      {!((readMode || (flow && viewerFileId !== null)) && readPlayerHidden) && <PlayerBar onOpenPiece={openPiece} />}
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




