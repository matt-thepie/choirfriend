import { useEffect, useMemo, useState } from 'react';
import { Button, Icon } from '@/components/ui/button.tsx';
import { cn } from '@/lib/utils.ts';
import {
  addPieceLink,
  deletePieceLink,
  isPdfFile,
  LINK_TYPE_LABEL,
  saveMemberPieceState,
  saveRemark,
  usePiece,
  type LinkType,
  type Piece,
  type PieceFile,
} from '@/hooks/usePiece.ts';
import { patchPiece } from '@/hooks/usePieces.ts';
import type { Section } from '@/hooks/useSections.ts';
import { replaceFile } from '@/hooks/useUploadFile.ts';
import { formatTime, usePlayer, type Queue } from '@/player/PlayerContext.tsx';
import { toQueueTrack } from '@/components/AudioPlayer/AudioPlayer.tsx';
import { UploadButton } from '@/components/PdfViewer/UploadButton.tsx';
import { KindBadge } from '@/components/PdfViewer/KindBadge.tsx';
import { artistArranger } from '@/components/RepertoireScreen.tsx';

interface SongScreenProps {
  /** The "How confident are you performing this song?" faces. Off via FEATURE_CONFIDENCE=false. */
  showConfidence?: boolean;
  pieceId: number;
  refreshTick: number;
  sections: Section[];
  mySectionId: number | null;
  /** Admin edit mode — the ChoirMate admin layout. Members never see it. */
  editing: boolean;
  /** Breadcrumb: where the member came from. */
  fromSetList: { id: number; name: string } | null;
  onGoSetLists: () => void;
  onGoRepertoire: () => void;
  onGoSetList: (id: number) => void;
  /** Open a PDF in the annotating viewer. */
  onOpenViewer: (fileId: number) => void;
  onPieceMutated: () => void;
}

function formatDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** "Tenor 2" → "tenor 2", for "Audio files for tenor 2" / "Remarks for tenors 2". */
function lower(label: string): string {
  return label.toLowerCase();
}

/**
 * The song page, audio-first, as members know it from ChoirMate:
 * breadcrumb → Remarks / Lyrics / section → Sheet music → Audio files for
 * <section> → confidence → Private notes. In edit mode the audio is one
 * block per section, each with its own "Add audio" that pre-assigns the part.
 */
export function SongScreen({
  showConfidence = true,
  pieceId,
  refreshTick,
  sections,
  mySectionId,
  editing,
  fromSetList,
  onGoSetLists,
  onGoRepertoire,
  onGoSetList,
  onOpenViewer,
  onPieceMutated,
}: SongScreenProps) {
  const { piece, loading, error, refresh } = usePiece(pieceId, refreshTick);

  // Section filter: the member's own part by default. null = all parts.
  const [sectionId, setSectionId] = useState<number | null>(mySectionId);
  useEffect(() => setSectionId(mySectionId), [mySectionId]);
  const [panel, setPanel] = useState<'remarks' | 'lyrics' | 'links' | null>(null);
  const [onlyMine, setOnlyMine] = useState(false);

  const audio = useMemo(() => piece?.files.filter((f) => f.kind === 'audio') ?? [], [piece]);
  const sheet = useMemo(() => piece?.files.filter((f) => f.kind === 'pdf' || f.kind === 'lyrics') ?? [], [piece]);
  const scores = useMemo(() => piece?.files.filter((f) => f.kind === 'score') ?? [], [piece]);

  const section = sections.find((s) => s.id === sectionId) ?? null;

  function mutated(): void {
    refresh();
    onPieceMutated();
  }

  if (error) return <div className="p-6 text-sm text-destructive">Couldn't load song: {error}</div>;
  if (!piece) return <div className="p-6 text-sm text-muted-foreground">{loading ? 'Loading…' : ''}</div>;

  const crumbs = (
    <nav aria-label="Breadcrumb" className="text-sm text-on-field-muted flex items-center gap-1 flex-wrap">
      <button type="button" onClick={onGoSetLists} className="hover:text-on-field">Set lists</button>
      <span aria-hidden>›</span>
      {fromSetList ? (
        <button type="button" onClick={() => onGoSetList(fromSetList.id)} className="hover:text-on-field">{fromSetList.name}</button>
      ) : (
        <button type="button" onClick={onGoRepertoire} className="hover:text-on-field">Repertoire</button>
      )}
      <span aria-hidden>›</span>
      <span className="text-on-field">{piece.title}</span>
    </nav>
  );

  return (
    <div className="h-full overflow-auto">
      <div className="max-w-(--max) mx-auto px-4 sm:px-6 py-5 space-y-5">
        {crumbs}

        <header className="flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <h1 className="text-2xl md:text-4xl font-semibold leading-tight text-on-field">{piece.title}</h1>
            {artistArranger(piece) && <p className="text-base text-on-field-muted">{artistArranger(piece)}</p>}
          </div>
        </header>

        <div className={cn('grid gap-6 items-start', editing && 'lg:grid-cols-[1.4fr_0.9fr]')}>
        <div className="card p-4 sm:p-6 space-y-6 min-w-0 overflow-hidden">
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant={panel === 'remarks' ? 'default' : 'outline'} onClick={() => setPanel(panel === 'remarks' ? null : 'remarks')}>
            Remarks{piece.remarks.length > 0 && <span className="ml-1 text-xs opacity-70">({piece.remarks.length})</span>}
          </Button>
          <Button size="sm" variant={panel === 'lyrics' ? 'default' : 'outline'} onClick={() => setPanel(panel === 'lyrics' ? null : 'lyrics')}>
            Lyrics
          </Button>
          {(piece.links.length > 0 || editing) && (
            <Button size="sm" variant={panel === 'links' ? 'default' : 'outline'} onClick={() => setPanel(panel === 'links' ? null : 'links')}>
              Links{piece.links.length > 0 && <span className="ml-1 text-xs opacity-70">({piece.links.length})</span>}
            </Button>
          )}
          {!editing && (
            <select
              value={sectionId ?? ''}
              onChange={(e) => setSectionId(e.target.value === '' ? null : Number(e.target.value))}
              aria-label="Section"
              className="ml-auto h-10 px-3 rounded-md border border-border bg-background text-base"
            >
              <option value="">All parts</option>
              {sections.map((s) => (
                <option key={s.id} value={s.id}>{s.label}</option>
              ))}
            </select>
          )}
        </div>

        {panel === 'remarks' && (
          <RemarksPanel piece={piece} sections={sections} editing={editing} onSaved={mutated} />
        )}
        {panel === 'lyrics' && <LyricsPanel piece={piece} editing={editing} onSaved={mutated} />}
        {panel === 'links' && <LinksPanel piece={piece} editing={editing} onMutated={mutated} />}

        <DocumentList
          title="Sheet music"
          files={sheet}
          editing={editing}
          onOpenViewer={onOpenViewer}
          onMutated={mutated}
          addButton={editing ? <UploadButton pieceId={pieceId} kind="pdf" label="+ Add sheet music" onUploaded={mutated} /> : null}
          empty="No sheet music yet."
        />

        {scores.length > 0 || editing ? (
          <DocumentList
            title="Scores"
            subtitle="MuseScore / MusicXML — only shown to the MD, committee and section admins"
            files={scores}
            editing={editing}
            onOpenViewer={onOpenViewer}
            onMutated={mutated}
            addButton={editing ? <UploadButton pieceId={pieceId} kind="score" label="+ Add score" onUploaded={mutated} /> : null}
            empty={editing ? 'No editable score yet.' : null}
          />
        ) : null}

        {editing ? (
          // Admin layout: one block per section, each with its own Add audio.
          <section className="space-y-4">
            {sections.map((s) => (
              <AudioBlock
                key={s.id}
                heading={s.label}
                files={audio.filter((f) => f.sectionId === s.id)}
                piece={piece}
                sections={sections}
                editing
                onMutated={mutated}
                addButton={<UploadButton pieceId={pieceId} kind="audio" sectionId={s.id} label="Add audio" onUploaded={mutated} />}
              />
            ))}
            {audio.some((f) => f.sectionId === null) && (
              <AudioBlock
                heading="Needs a section"
                files={audio.filter((f) => f.sectionId === null)}
                piece={piece}
                sections={sections}
                editing
                onMutated={mutated}
              />
            )}
          </section>
        ) : (
          <>
            <AudioBlock
              heading={section ? `Audio files for ${lower(section.label)}` : 'Audio files'}
              files={(section ? audio.filter((f) => f.sectionId === section.id || f.sectionId === null) : audio).filter(
                (f) => !onlyMine || f.mine === true,
              )}
              piece={piece}
              sections={sections}
              mySection={mySectionId}
              editing={false}
              onMutated={mutated}
              menu={
                <label className="text-sm text-muted-foreground flex items-center gap-1.5 cursor-pointer select-none">
                  <input type="checkbox" checked={onlyMine} onChange={(e) => setOnlyMine(e.target.checked)} />
                  Show only audio files added by me
                </label>
              }
              empty={section ? `No audio for ${lower(section.label)} yet.` : 'No audio yet.'}
              addButton={<UploadButton pieceId={pieceId} kind="audio" sectionId={section?.id ?? null} label="Add audio" onUploaded={mutated} />}
            />
          </>
        )}

        </div>

        <div className="space-y-6">
          {editing && <SongSettings piece={piece} onSaved={mutated} />}
          {showConfidence && <ConfidencePanel piece={piece} />}
          <PrivateNotes piece={piece} />
        </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sheet music / lyrics / scores
// ---------------------------------------------------------------------------

function DocumentList({
  title,
  subtitle,
  files,
  editing,
  onOpenViewer,
  onMutated,
  addButton,
  empty,
}: {
  title: string;
  subtitle?: string;
  files: PieceFile[];
  editing: boolean;
  onOpenViewer: (fileId: number) => void;
  onMutated: () => void;
  addButton: React.ReactNode;
  empty: string | null;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-end gap-2">
        <h2 className="text-lg font-semibold">{title}</h2>
        {subtitle && <span className="text-sm text-muted-foreground">{subtitle}</span>}
      </div>
      {files.length === 0 ? (
        empty && <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="inset-list">
          {files.map((f) => (
            <DocumentRow key={f.id} file={f} editing={editing} onOpenViewer={onOpenViewer} onMutated={onMutated} />
          ))}
        </ul>
      )}
      {addButton && <div>{addButton}</div>}
    </section>
  );
}

function DocumentRow({
  file,
  editing,
  onOpenViewer,
  onMutated,
}: {
  file: PieceFile;
  editing: boolean;
  onOpenViewer: (fileId: number) => void;
  onMutated: () => void;
}) {
  const viewable = isPdfFile(file);
  const name = file.label?.trim() || file.filename;
  return (
    <li className="inset-row flex items-center gap-3 px-4 py-2 hover:shadow-card hover:-translate-y-px">
      <Icon name={file.kind === 'score' ? 'piano' : file.kind === 'lyrics' ? 'description' : 'music_note'} className="text-muted-foreground shrink-0" />
      {viewable ? (
        <button type="button" onClick={() => onOpenViewer(file.id)} className="flex-1 min-w-0 text-left hover:underline">
          <div className="text-base font-medium truncate">{name}</div>
        </button>
      ) : (
        <a href={file.url} target="_blank" rel="noreferrer" className="flex-1 min-w-0 text-left hover:underline">
          <div className="text-base font-medium truncate">{name}</div>
        </a>
      )}
      {viewable && (
        <a
          href={file.url}
          target="_blank"
          rel="noreferrer"
          aria-label="Print"
          title="Print (opens in a new tab)"
          className="inline-flex items-center justify-center w-11 h-11 rounded-md hover:bg-accent hover:text-accent-foreground text-muted-foreground shrink-0"
        >
          <Icon name="print" />
        </a>
      )}
      <RowMenu file={file} editing={editing} onMutated={onMutated} />
    </li>
  );
}

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

function AudioBlock({
  heading,
  files,
  piece,
  sections,
  mySection = null,
  editing,
  onMutated,
  addButton,
  menu,
  empty,
}: {
  heading: string;
  files: PieceFile[];
  piece: Piece;
  sections: Section[];
  mySection?: number | null;
  editing: boolean;
  onMutated: () => void;
  addButton?: React.ReactNode;
  menu?: React.ReactNode;
  empty?: string;
}) {
  const player = usePlayer();
  const byId = useMemo(() => new Map(sections.map((s) => [s.id, s])), [sections]);
  const queue: Queue = { name: piece.title, tracks: files.map((f) => toQueueTrack(piece, f)) };
  const playingId = player.queue?.name === piece.title ? player.current?.fileId ?? null : null;

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="text-lg font-semibold flex-1 min-w-0">{heading}</h2>
        {menu}
      </div>
      {files.length === 0 ? (
        (empty || editing) && <p className="text-sm text-muted-foreground">{empty ?? 'No audio in this section.'}</p>
      ) : (
        <ul className="inset-list">
          {files.map((f, i) => {
            const sec = f.sectionId !== null ? byId.get(f.sectionId) : null;
            const active = playingId === f.id;
            return (
              <li key={f.id} className={cn('inset-row flex items-center gap-3 px-3 py-2 hover:shadow-card', active && 'ring-2 ring-primary')}>
                <div className="flex flex-col items-center shrink-0 w-12">
                  <button
                    type="button"
                    aria-label={active && player.isPlaying ? `Pause ${f.label ?? f.filename}` : `Play ${f.label ?? f.filename}`}
                    onClick={() => (active ? player.toggle() : player.playQueue(queue, i))}
                    className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-primary text-primary-foreground hover:bg-primary-hover active:bg-primary-active shadow-sm"
                  >
                    <Icon name={active && player.isPlaying ? 'pause' : 'play_arrow'} filled />
                  </button>
                  <span className="text-xs tabular-nums text-muted-foreground mt-0.5">
                    {f.durationMs ? formatTime(f.durationMs / 1000) : ''}
                  </span>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-base font-medium truncate flex items-center gap-2">
                    {sec && !editing && (
                      <span className={cn('text-xs font-semibold px-1.5 py-0.5 rounded border shrink-0', f.sectionId === mySection ? 'bg-accent text-accent-foreground border-primary/30' : 'border-border text-muted-foreground')}>{sec.badge}</span>
                    )}
                    <span className="truncate">{f.label?.trim() || f.filename}</span>
                  </div>
                  <div className="text-sm text-muted-foreground truncate">
                    {f.visibility === 'private' ? 'Private · only you can see this' : f.createdByName ? `Shared by ${shortName(f.createdByName)}` : 'Shared'}
                  </div>
                </div>
                <span className="text-sm text-muted-foreground shrink-0 hidden sm:block">{formatDate(f.createdAt)}</span>
                <RowMenu file={f} editing={editing} onMutated={onMutated} sections={editing || f.canManage ? sections : undefined} />
              </li>
            );
          })}
        </ul>
      )}
      {addButton && <div>{addButton}</div>}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Kebab menu per row
// ---------------------------------------------------------------------------

function RowMenu({
  file,
  editing,
  onMutated,
  sections,
}: {
  file: PieceFile;
  editing: boolean;
  onMutated: () => void;
  sections?: Section[];
}) {
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [label, setLabel] = useState(file.label ?? '');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function patch(body: Record<string, unknown>): Promise<void> {
    setBusy('patch');
    setErr(null);
    try {
      const res = await fetch(`/api/files/${file.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      onMutated();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function remove(): Promise<void> {
    setBusy('delete');
    try {
      const res = await fetch(`/api/files/${file.id}`, { method: 'DELETE', credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setOpen(false);
      onMutated();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function replace(picked: File | undefined): Promise<void> {
    if (!picked) return;
    setBusy('replace');
    setErr(null);
    try {
      await replaceFile(file.id, picked, file.kind);
      setOpen(false);
      onMutated();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        aria-label="More"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center justify-center w-11 h-11 rounded-md hover:bg-accent hover:text-accent-foreground text-muted-foreground"
      >
        <Icon name="more_vert" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} aria-hidden />
          <div className="absolute right-0 top-full mt-1 w-60 card shadow-float z-30 p-1 text-base">
            <a href={file.url} download={file.filename} target="_blank" rel="noreferrer" className="block px-3 py-2 rounded hover:bg-accent">
              Download
            </a>
            {file.kind === 'audio' && file.canManage && (
              <button
                type="button"
                className="block w-full text-left px-3 py-2 rounded hover:bg-accent"
                disabled={busy !== null}
                onClick={() => void patch({ visibility: file.visibility === 'private' ? 'shared' : 'private' })}
              >
                {file.visibility === 'private' ? 'Share with the choir' : 'Unshare (make private)'}
              </button>
            )}
            {(editing || file.canManage) && (
              <>
                <div className="h-px bg-border my-1" />
                {renaming ? (
                  <form
                    className="px-2 py-1 space-y-1"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void patch({ label: label.trim() || null }).then(() => setRenaming(false));
                    }}
                  >
                    <input
                      type="text"
                      autoFocus
                      value={label}
                      onChange={(e) => setLabel(e.target.value)}
                      placeholder="Display name"
                      className="w-full text-xs h-7 px-1.5 rounded border border-border bg-background"
                    />
                    <div className="flex justify-end gap-1">
                      <button type="button" className="text-xs px-2 py-1" onClick={() => setRenaming(false)}>Cancel</button>
                      <button type="submit" className="text-xs px-2 py-1 rounded bg-primary text-primary-foreground" disabled={busy !== null}>Save</button>
                    </div>
                  </form>
                ) : (
                  <button type="button" className="block w-full text-left px-3 py-2 rounded hover:bg-accent" onClick={() => setRenaming(true)}>
                    Edit
                  </button>
                )}
                {sections && file.kind === 'audio' && (
                  <label className="block px-3 py-1.5 text-xs text-muted-foreground">
                    Section
                    <select
                      value={file.sectionId ?? ''}
                      onChange={(e) => void patch({ sectionId: e.target.value === '' ? null : Number(e.target.value) })}
                      className="mt-0.5 w-full h-7 px-1 rounded border border-border bg-background text-xs text-foreground"
                    >
                      {file.sectionId === null && <option value="" disabled>Choose a section</option>}
                      {sections.map((s) => (
                        <option key={s.id} value={s.id}>{s.label}</option>
                      ))}
                    </select>
                  </label>
                )}
                <label className="block px-3 py-2 rounded hover:bg-accent cursor-pointer">
                  {busy === 'replace' ? 'Replacing…' : 'Replace file'}
                  <input type="file" className="hidden" onChange={(e) => void replace(e.target.files?.[0])} />
                </label>
                {confirmDelete ? (
                  <div className="px-3 py-2 flex items-center gap-2">
                    <span className="text-xs text-muted-foreground flex-1">Delete?</span>
                    <button type="button" className="text-xs px-2 py-1 rounded bg-destructive text-white" onClick={() => void remove()} disabled={busy !== null}>Delete</button>
                    <button type="button" className="text-xs px-2 py-1" onClick={() => setConfirmDelete(false)}>Cancel</button>
                  </div>
                ) : (
                  <button type="button" className="block w-full text-left px-3 py-2 rounded hover:bg-accent text-destructive" onClick={() => setConfirmDelete(true)}>
                    Delete
                  </button>
                )}
              </>
            )}
            {err && <div className="px-3 py-1 text-xs text-destructive">{err}</div>}
            <div className="px-3 pt-1 pb-1.5 text-xs text-muted-foreground truncate flex items-center gap-1" title={file.filename}>
              <KindBadge kind={file.kind} /> {file.filename}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Remarks, links, confidence, private notes, settings
// ---------------------------------------------------------------------------

function RemarksPanel({ piece, sections, editing, onSaved }: { piece: Piece; sections: Section[]; editing: boolean; onSaved: () => void }) {
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<number | null>(null);
  useEffect(() => {
    setDrafts(Object.fromEntries(piece.remarks.map((r) => [r.sectionId, r.text])));
  }, [piece.remarks]);

  async function save(sectionId: number): Promise<void> {
    setBusy(sectionId);
    try {
      await saveRemark(piece.id, sectionId, drafts[sectionId] ?? '');
      onSaved();
    } finally {
      setBusy(null);
    }
  }

  const shown = editing ? sections : sections.filter((s) => piece.remarks.some((r) => r.sectionId === s.id));
  return (
    <section className="bg-card-2 rounded-md p-4 space-y-3">
      <h2 className="text-base font-semibold">Remarks</h2>
      {shown.length === 0 && <p className="text-sm text-muted-foreground">No remarks yet.</p>}
      {shown.map((s) => {
        const r = piece.remarks.find((x) => x.sectionId === s.id);
        return (
          <div key={s.id} className="space-y-1">
            <h3 className="text-sm font-medium text-muted-foreground">Remarks for {lower(s.label)}s</h3>
            {editing ? (
              <div className="space-y-1">
                <textarea
                  value={drafts[s.id] ?? ''}
                  onChange={(e) => setDrafts((d) => ({ ...d, [s.id]: e.target.value }))}
                  rows={2}
                  className="w-full text-sm p-2 rounded-md border border-border bg-background"
                />
                <div className="flex justify-end">
                  <Button size="sm" variant="outline" disabled={busy === s.id || (drafts[s.id] ?? '') === (r?.text ?? '')} onClick={() => void save(s.id)}>
                    {busy === s.id ? 'Saving…' : 'Save'}
                  </Button>
                </div>
              </div>
            ) : (
              <p className="text-sm whitespace-pre-wrap">
                {r?.text}
                {r?.updatedByName && <span className="text-xs text-muted-foreground"> — {r.updatedByName}</span>}
              </p>
            )}
          </div>
        );
      })}
    </section>
  );
}

function LinksPanel({ piece, editing, onMutated }: { piece: Piece; editing: boolean; onMutated: () => void }) {
  const [url, setUrl] = useState('');
  const [type, setType] = useState<LinkType | ''>('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function add(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!url.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await addPieceLink(piece.id, { url: url.trim(), ...(type && { type }) });
      setUrl('');
      setType('');
      onMutated();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="bg-card-2 rounded-md p-4 space-y-3">
      <h2 className="text-base font-semibold">Links</h2>
      {piece.links.length === 0 && <p className="text-sm text-muted-foreground">No links yet.</p>}
      <ul className="space-y-1">
        {piece.links.map((l) => (
          <li key={l.id} className="flex items-center gap-2 text-sm">
            <span className="text-xs uppercase font-semibold px-1 py-0.5 rounded bg-muted text-muted-foreground shrink-0">{LINK_TYPE_LABEL[l.type]}</span>
            <a href={l.url} target="_blank" rel="noreferrer" className="flex-1 min-w-0 truncate hover:underline">{l.label || l.url}</a>
            {editing && (
              <button type="button" aria-label="Remove link" className="text-muted-foreground hover:text-destructive" onClick={() => void deletePieceLink(piece.id, l.id).then(onMutated)}>
                ×
              </button>
            )}
          </li>
        ))}
      </ul>
      {editing && (
        <form onSubmit={add} className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 text-xs">
            {(['spotify', 'youtube', 'appleMusic', 'other'] as LinkType[]).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setType(type === t ? '' : t)}
                className={cn('px-2 h-8 rounded-md border text-xs', type === t ? 'bg-primary text-primary-foreground border-primary' : 'border-border hover:bg-accent')}
              >
                {LINK_TYPE_LABEL[t]}
              </button>
            ))}
          </div>
          <input
            type="url"
            placeholder="https://…"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            className="flex-1 min-w-48 h-8 px-2 rounded-md border border-border bg-background text-sm"
          />
          <Button size="sm" type="submit" disabled={!url.trim() || busy}>+ Add link</Button>
          {err && <span className="text-xs text-destructive">{err}</span>}
        </form>
      )}
    </section>
  );
}

const FACES: Array<{ value: 1 | 2 | 3; label: string; icon: string }> = [
  { value: 1, label: 'Not confident', icon: 'sentiment_dissatisfied' },
  { value: 2, label: 'Getting there', icon: 'sentiment_neutral' },
  { value: 3, label: 'Confident', icon: 'sentiment_satisfied' },
];

function ConfidencePanel({ piece }: { piece: Piece }) {
  const [value, setValue] = useState<1 | 2 | 3 | null>(piece.me.confidence);
  useEffect(() => setValue(piece.me.confidence), [piece.id, piece.me.confidence]);

  async function pick(v: 1 | 2 | 3): Promise<void> {
    const next = value === v ? null : v;
    setValue(next);
    try {
      await saveMemberPieceState(piece.id, { confidence: next });
    } catch {
      setValue(value);
    }
  }

  return (
    <section className="card p-4 sm:p-6 flex flex-wrap items-center gap-3">
      <h2 className="text-base font-semibold flex-1 min-w-48">How confident are you performing this song?</h2>
      <div className="flex items-center gap-2" role="radiogroup" aria-label="Confidence">
        {FACES.map((f) => (
          <button
            key={f.value}
            type="button"
            role="radio"
            aria-checked={value === f.value}
            aria-label={f.label}
            title={f.label}
            onClick={() => void pick(f.value)}
            className={cn(
              'w-12 h-12 rounded-full inline-flex items-center justify-center transition-colors',
              value === f.value ? 'bg-primary text-primary-foreground' : 'hover:bg-accent text-muted-foreground',
            )}
          >
            <Icon name={f.icon} filled={value === f.value} className="text-4xl" />
          </button>
        ))}
      </div>
    </section>
  );
}

function PrivateNotes({ piece }: { piece: Piece }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(piece.me.notes ?? '');
  const [saved, setSaved] = useState(piece.me.notes ?? '');
  useEffect(() => {
    setText(piece.me.notes ?? '');
    setSaved(piece.me.notes ?? '');
  }, [piece.id, piece.me.notes]);

  async function save(): Promise<void> {
    const res = await saveMemberPieceState(piece.id, { notes: text });
    setSaved(res.notes ?? '');
    setText(res.notes ?? '');
    setEditing(false);
  }

  return (
    <section className="card p-4 sm:p-6 space-y-2">
      <div className="flex items-center gap-2">
        <h2 className="text-base font-semibold flex-1">Private notes</h2>
        {!editing && (
          <button type="button" aria-label="Edit private notes" onClick={() => setEditing(true)} className="w-11 h-11 inline-flex items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground">
            <Icon name="edit" />
          </button>
        )}
      </div>
      {editing ? (
        <div className="space-y-2">
          <textarea
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={4}
            placeholder="Only you can see these."
            className="w-full text-sm p-2 rounded-md border border-border bg-background"
          />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => { setText(saved); setEditing(false); }}>Cancel</Button>
            <Button size="sm" onClick={() => void save()}>Save</Button>
          </div>
        </div>
      ) : saved ? (
        <p className="text-sm whitespace-pre-wrap">{saved}</p>
      ) : (
        <p className="text-sm text-muted-foreground">Nothing yet. Only you can see these.</p>
      )}
    </section>
  );
}

/** Admin: "Repertoire settings" — title, Artist/Arranger, delete. */
function SongSettings({ piece, onSaved }: { piece: Piece; onSaved: () => void }) {
  const [title, setTitle] = useState(piece.title);
  const [artist, setArtist] = useState(artistArranger(piece));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setTitle(piece.title);
    setArtist(artistArranger(piece));
  }, [piece.id, piece.title, piece.composer, piece.arranger]);
  const dirty = title.trim() !== piece.title || artist.trim() !== artistArranger(piece);

  async function save(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!dirty || busy) return;
    setBusy(true);
    setErr(null);
    try {
      // One "Artist/Arranger" field, as ChoirMate has it; stored in composer.
      await patchPiece(piece.id, { title: title.trim(), composer: artist.trim() || null, arranger: null });
      onSaved();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="card p-4 sm:p-6 grid gap-3 items-end">
      <h2 className="text-base font-semibold">Repertoire settings</h2>
      <label className="text-xs space-y-1">
        <span className="text-muted-foreground">Title</span>
        <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} className="w-full h-9 px-2 rounded-md border border-border bg-background text-sm" />
      </label>
      <label className="text-xs space-y-1">
        <span className="text-muted-foreground">Artist/Arranger</span>
        <input type="text" value={artist} onChange={(e) => setArtist(e.target.value)} className="w-full h-9 px-2 rounded-md border border-border bg-background text-sm" />
      </label>
      <Button size="sm" type="submit" disabled={!dirty || !title.trim() || busy}>{busy ? 'Saving…' : 'Save'}</Button>
      {err && <p className="text-sm text-destructive">{err}</p>}
    </form>
  );
}

/** "Steve Hunter" → "Steve H."; single names are left alone. */
function shortName(full: string): string {
  const parts = full.replace(/\([^)]*\)/g, ' ').trim().split(/\s+/).filter((w) => /^\p{L}/u.test(w));
  if (parts.length === 0) return full.trim();
  if (parts.length === 1) return parts[0]!;
  return `${parts[0]} ${parts[parts.length - 1]![0]!.toUpperCase()}.`;
}

/** Lyrics are text on the song. Admins edit; everyone reads. */
function LyricsPanel({ piece, editing, onSaved }: { piece: Piece; editing: boolean; onSaved: () => void }) {
  const [text, setText] = useState(piece.lyrics ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setText(piece.lyrics ?? ''), [piece.lyrics]);
  const dirty = text.trim() !== (piece.lyrics ?? '').trim();

  if (!editing) {
    return (
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Lyrics</h2>
        {piece.lyrics ? (
          <div className="whitespace-pre-wrap text-base leading-relaxed">{piece.lyrics}</div>
        ) : (
          <p className="text-sm text-muted-foreground">No lyrics yet. Lyric sheets are listed under Sheet music.</p>
        )}
      </section>
    );
  }
  return (
    <section className="space-y-2">
      <h2 className="text-lg font-semibold">Lyrics</h2>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={12}
        placeholder="Paste or type the lyrics"
        className="w-full p-3 rounded-md border border-border bg-background text-base leading-relaxed"
      />
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button
        size="sm"
        disabled={!dirty || busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await patchPiece(piece.id, { lyrics: text.trim() || null });
            onSaved();
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? 'Saving…' : 'Save lyrics'}
      </Button>
    </section>
  );
}
