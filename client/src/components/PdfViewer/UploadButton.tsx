import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button.tsx';
import { inferKind, UPLOAD_ACCEPT, useUploadFile, type UploadStatus } from '@/hooks/useUploadFile.ts';
import { FILE_KIND_LABEL, isPdfFile, type FileKind } from '@/hooks/usePiece.ts';
import { KindBadge } from './KindBadge.tsx';

interface UploadButtonProps {
  pieceId: number;
  onUploaded: () => void;
  /** Fix the kind (e.g. an "Add audio" button under a section block). Files
   *  of another kind are refused instead of re-filed. */
  kind?: FileKind;
  /** Pre-assign a voice part — the ChoirMate gesture: press Add audio under
   *  Bass, pick a file, done. Only meaningful with kind='audio'. */
  sectionId?: number | null;
  /** Button text. Defaults to "+ Add file". */
  label?: string;
  /** Picker accept string; defaults to everything we take, or the kind's formats. */
  accept?: string;
  size?: 'sm' | 'md';
  variant?: 'outline' | 'default' | 'ghost';
}

const ACCEPT_FOR_KIND: Record<FileKind, string> = {
  pdf: 'application/pdf,.pdf',
  audio: 'audio/*,.mp3,.m4a,.aac,.ogg,.wav,.flac',
  lyrics: 'application/pdf,.pdf,.docx,.doc,.rtf,.txt,.md,.odt',
  score: '.mscz,.mscx,.musicxml,.mxl',
};

function describeStatus(s: UploadStatus): string | null {
  switch (s.phase) {
    case 'idle':
      return null;
    case 'signing':
      return `Preparing ${s.filename}…`;
    case 'uploading':
      return `Uploading ${s.filename}…`;
    case 'completing':
      return `Finalising ${s.filename}…`;
    case 'done':
      return `Uploaded ${s.filename} ✓`;
    case 'error':
      return `Upload failed: ${s.message}`;
  }
}

/** A picked file waiting in the panel before it's uploaded. */
interface Staged {
  file: File;
  kind: FileKind;
  label: string;
}

/**
 * Compact upload control. Hidden `<input type=file>` triggered by a button.
 *
 * Every picked file lands in a modal dialog first so the admin can
 * check what it's being filed as and name it: audio gets a voice-part label,
 * a PDF can be flipped between sheet music and lyrics, MuseScore files are
 * flagged as scores (MD / committee only). Nothing uploads until "Upload".
 */
export function UploadButton({
  pieceId,
  onUploaded,
  kind: fixedKind,
  sectionId = null,
  label: buttonLabel = '+ Add file',
  accept,
  size = 'sm',
  variant = 'outline',
}: UploadButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const { status, upload } = useUploadFile(pieceId);
  const [staged, setStaged] = useState<Staged[]>([]);
  const [skipped, setSkipped] = useState<string[]>([]);
  const description = describeStatus(status);
  const busy = status.phase === 'signing' || status.phase === 'uploading' || status.phase === 'completing';

  function handleFiles(list: FileList | null): void {
    // Copy before clearing: the FileList is live, and resetting the input
    // (so the same file can be picked again) empties it in Chrome.
    const files = list ? Array.from(list) : [];
    if (inputRef.current) inputRef.current.value = '';
    const next: Staged[] = [];
    const bad: string[] = [];
    for (const file of files) {
      let kind = inferKind(file);
      if (fixedKind) {
        // A lyric-named PDF dropped on "Add sheet music" is still a PDF; honour
        // the button. Anything that isn't the button's format is refused.
        const pdfOk = (fixedKind === 'pdf' || fixedKind === 'lyrics') && (kind === 'pdf' || kind === 'lyrics');
        kind = pdfOk || kind === fixedKind ? fixedKind : null;
      }
      if (!kind) bad.push(file.name);
      else next.push({ file, kind, label: '' });
    }
    if (next.length > 0) setStaged((prev) => [...prev, ...next]);
    setSkipped(bad);
  }

  async function uploadStaged(): Promise<void> {
    const failed: Staged[] = [];
    for (const item of staged) {
      const result = await upload(item.file, item.kind, item.label.trim() || undefined, {
        sectionId: item.kind === 'audio' ? sectionId : undefined,
      });
      if (result) onUploaded();
      else failed.push(item);
    }
    // Anything that failed stays in the box, with the error showing.
    setStaged(failed);
    setSkipped([]);
  }

  function closeDialog(): void {
    setStaged([]);
    setSkipped([]);
  }

  const open = staged.length > 0 || skipped.length > 0;
  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      // showModal focuses the first control (a remove button); start on the label.
      d.querySelector<HTMLInputElement>('input[type="text"]')?.focus();
    } else if (!open && d.open) d.close();
  }, [open]);

  function patch(index: number, p: Partial<Staged>): void {
    setStaged((prev) => prev.map((s, i) => (i === index ? { ...s, ...p } : s)));
  }

  const hasScore = staged.some((s) => s.kind === 'score');

  return (
    <div className="relative inline-flex items-center gap-2">
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={accept ?? (fixedKind ? ACCEPT_FOR_KIND[fixedKind] : UPLOAD_ACCEPT)}
        className="hidden"
        onChange={(e) => handleFiles(e.target.files)}
      />
      <Button size={size} variant={variant} onClick={() => inputRef.current?.click()} disabled={busy}>
        {busy ? 'Uploading…' : buttonLabel}
      </Button>
      {description && (
        <span
          className={
            status.phase === 'error'
              ? 'text-xs text-destructive'
              : status.phase === 'done'
              ? 'text-xs text-emerald-700'
              : 'text-xs text-muted-foreground'
          }
        >
          {description}
        </span>
      )}

      <dialog
        ref={dialogRef}
        aria-labelledby={titleId}
        onCancel={(e) => {
          e.preventDefault();
          if (!busy) closeDialog();
        }}
        className="m-auto w-[min(28rem,calc(100vw-2rem))] max-h-[calc(100dvh-2rem)] rounded-lg border border-border bg-background text-foreground p-0 shadow-xl backdrop:bg-black/50"
      >
        <div className="flex flex-col max-h-[calc(100dvh-2rem)]">
          <div className="px-4 pt-4 pb-2">
            <h2 id={titleId} className="text-base font-semibold">
              {staged.length > 0 ? `Upload ${staged.length === 1 ? 'this file' : `${staged.length} files`}?` : 'Can\u2019t upload that'}
            </h2>
            {staged.length > 0 && (
              <p className="text-sm text-muted-foreground mt-0.5">Check what each file is and name it, then press Upload.</p>
            )}
          </div>

          <div className="px-4 py-2 space-y-3 overflow-auto">
            {skipped.length > 0 && (
              <p className="text-sm text-destructive">
                Not supported: {skipped.join(', ')}. Use PDF, audio, a lyrics document (docx, rtf, txt) or a MuseScore / MusicXML file.
              </p>
            )}
            {staged.map((item, i) => {
              const pdf = isPdfFile({ mimeType: item.file.type, filename: item.file.name });
              return (
                <div key={`${item.file.name}-${i}`} className="rounded-md border border-border p-2.5 space-y-2">
                  <div className="flex items-center gap-2">
                    {/* A PDF can be sheet music or lyrics; other kinds are fixed by their format. */}
                    {pdf && !fixedKind ? (
                      <select
                        value={item.kind}
                        onChange={(e) => patch(i, { kind: e.target.value as FileKind })}
                        aria-label="File this as"
                        className="text-sm h-9 px-2 rounded border border-border bg-background shrink-0"
                        disabled={busy}
                      >
                        <option value="pdf">Sheet music</option>
                        <option value="lyrics">Lyrics</option>
                      </select>
                    ) : (
                      <KindBadge kind={item.kind} />
                    )}
                    <span className="flex-1 min-w-0 text-sm truncate" title={item.file.name}>{item.file.name}</span>
                    <button
                      type="button"
                      aria-label={`Remove ${item.file.name}`}
                      onClick={() => setStaged((prev) => prev.filter((_, j) => j !== i))}
                      className="h-9 w-9 -mr-1 inline-flex items-center justify-center rounded text-muted-foreground hover:text-destructive hover:bg-muted"
                      disabled={busy}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M6 6 18 18M18 6 6 18" /></svg>
                    </button>
                  </div>
                  <input
                    type="text"
                    value={item.label}
                    onChange={(e) => patch(i, { label: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !busy) void uploadStaged();
                    }}
                    aria-label={`Label for ${item.file.name}`}
                    placeholder={
                      item.kind === 'audio'
                        ? (sectionId !== null ? 'Track name (optional)' : 'Voice part (e.g. Tenor 1)')
                        : item.kind === 'lyrics'
                        ? 'Label (e.g. T2 lyrics)'
                        : 'Label (optional)'
                    }
                    disabled={busy}
                    className="w-full text-sm h-9 px-2 rounded border border-border bg-background focus:outline-none focus:ring-2 focus:ring-primary"
                  />
                </div>
              );
            })}
            {hasScore && (
              <p className="text-sm text-muted-foreground">
                The {FILE_KIND_LABEL.score.toLowerCase()} file is only shown to the MD, committee and section admins. Everyone gets the flowing score made from it.
              </p>
            )}
            {description && status.phase !== 'done' && (
              <p role="status" className={status.phase === 'error' ? 'text-sm text-destructive' : 'text-sm text-muted-foreground'}>
                {description}
              </p>
            )}
          </div>

          <div className="px-4 pt-2 pb-4 flex items-center justify-end gap-2 border-t border-border mt-2">
            {staged.length > 0 ? (
              <>
                <Button variant="ghost" onClick={closeDialog} disabled={busy}>Cancel</Button>
                <Button onClick={() => void uploadStaged()} disabled={busy}>
                  {busy ? 'Uploading…' : `Upload ${staged.length === 1 ? 'file' : `${staged.length} files`}`}
                </Button>
              </>
            ) : (
              <Button onClick={closeDialog}>OK</Button>
            )}
          </div>
        </div>
      </dialog>
    </div>
  );
}
