import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button.tsx';
import { Popover } from '@/components/ui/popover.tsx';
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
 * Every picked file lands in a small staging panel first so the admin can
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
  const anchorRef = useRef<HTMLDivElement>(null);
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
    const items = staged;
    for (const item of items) {
      const result = await upload(item.file, item.kind, item.label.trim() || undefined, {
        sectionId: item.kind === 'audio' ? sectionId : undefined,
      });
      if (result) onUploaded();
    }
    setStaged([]);
  }

  function patch(index: number, p: Partial<Staged>): void {
    setStaged((prev) => prev.map((s, i) => (i === index ? { ...s, ...p } : s)));
  }

  const hasScore = staged.some((s) => s.kind === 'score');

  return (
    <div ref={anchorRef} className="relative inline-flex items-center gap-2">
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

      {(staged.length > 0 || skipped.length > 0) && (
        <Popover anchorRef={anchorRef} className="w-[22rem] p-2 space-y-2">
          {skipped.length > 0 && (
            <div className="text-xs text-destructive">
              Not supported: {skipped.join(', ')}. Use PDF, audio, a lyrics document (docx, rtf, txt) or a MuseScore / MusicXML file.
            </div>
          )}
          {staged.length > 0 && (
            <>
              <div className="text-xs font-medium">
                Check {staged.length === 1 ? 'this file' : 'these files'}
              </div>
              <div className="space-y-1.5 max-h-72 overflow-auto">
                {staged.map((item, i) => {
                  const pdf = isPdfFile({ mimeType: item.file.type, filename: item.file.name });
                  return (
                    <div key={`${item.file.name}-${i}`} className="flex items-start gap-2">
                      {/* A PDF can be sheet music or lyrics; other kinds are fixed by their format. */}
                      {pdf && !fixedKind ? (
                        <select
                          value={item.kind}
                          onChange={(e) => patch(i, { kind: e.target.value as FileKind })}
                          aria-label="File this as"
                          className="text-xs h-7 px-1 rounded border border-border bg-background shrink-0"
                          disabled={busy}
                        >
                          <option value="pdf">Sheet music</option>
                          <option value="lyrics">Lyrics</option>
                        </select>
                      ) : (
                        <span className="mt-1.5"><KindBadge kind={item.kind} /></span>
                      )}
                      <div className="flex-1 min-w-0">
                        <input
                          type="text"
                          autoFocus={i === 0}
                          value={item.label}
                          onChange={(e) => patch(i, { label: e.target.value })}
                          placeholder={
                            item.kind === 'audio'
                              ? (sectionId !== null ? 'Track name (optional)' : 'Voice part (e.g. Tenor 1)')
                              : item.kind === 'lyrics'
                              ? 'Label (e.g. T2 lyrics)'
                              : 'Label (optional)'
                          }
                          disabled={busy}
                          className="w-full text-xs h-7 px-1.5 rounded border border-border bg-background focus:outline-none focus:ring-1 focus:ring-primary"
                        />
                        <div className="text-xs text-muted-foreground truncate px-1.5" title={item.file.name}>
                          {item.file.name}
                        </div>
                      </div>
                      <button
                        type="button"
                        aria-label={`Remove ${item.file.name}`}
                        onClick={() => setStaged((prev) => prev.filter((_, j) => j !== i))}
                        className="text-muted-foreground hover:text-destructive mt-1.5"
                        disabled={busy}
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M6 6 18 18M18 6 6 18" /></svg>
                      </button>
                    </div>
                  );
                })}
              </div>
              {hasScore && (
                <p className="text-xs text-muted-foreground">
                  The {FILE_KIND_LABEL.score.toLowerCase()} file is only shown to the MD, committee and section admins. Everyone gets the flowing score made from it.
                </p>
              )}
              <div className="flex items-center justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={() => { setStaged([]); setSkipped([]); }} disabled={busy}>
                  Cancel
                </Button>
                <Button size="sm" onClick={() => void uploadStaged()} disabled={busy}>
                  {busy ? 'Uploading…' : `Upload ${staged.length} file${staged.length === 1 ? '' : 's'}`}
                </Button>
              </div>
            </>
          )}
          {staged.length === 0 && (
            <div className="flex justify-end">
              <Button size="sm" variant="ghost" onClick={() => setSkipped([])}>OK</Button>
            </div>
          )}
        </Popover>
      )}
    </div>
  );
}
