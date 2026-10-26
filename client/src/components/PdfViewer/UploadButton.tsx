import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button.tsx';
import { inferKind, useUploadFile, type UploadStatus } from '@/hooks/useUploadFile.ts';

interface UploadButtonProps {
  pieceId: number;
  onUploaded: () => void;
}

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

/** An audio file waiting to be labelled before it's uploaded. */
interface StagedAudio {
  file: File;
  label: string;
}

/**
 * Compact upload control. Hidden `<input type=file>` triggered by a button.
 *
 * PDFs upload immediately on pick (no label needed). Audio files are staged in
 * a small panel first so the MD can name the voice part ("Tenor 1") as they
 * add it, rather than only renaming afterwards in the Files panel. The label
 * is optional — leaving it blank uploads an unlabelled track as before.
 */
export function UploadButton({ pieceId, onUploaded }: UploadButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const { status, upload } = useUploadFile(pieceId);
  const [staged, setStaged] = useState<StagedAudio[]>([]);
  const description = describeStatus(status);
  const busy = status.phase === 'signing' || status.phase === 'uploading' || status.phase === 'completing';

  async function handleFiles(files: FileList | null): Promise<void> {
    if (inputRef.current) inputRef.current.value = '';
    if (!files) return;

    const audios: StagedAudio[] = [];
    for (const file of Array.from(files)) {
      const kind = inferKind(file);
      if (!kind) {
        console.warn('[upload] unsupported file kind, skipping:', file.name, file.type);
        continue;
      }
      if (kind === 'audio') {
        // Hold audio back for labelling.
        audios.push({ file, label: '' });
        continue;
      }
      // PDFs go straight up — no label to collect.
      const result = await upload(file, 'pdf');
      if (result) onUploaded();
    }

    if (audios.length > 0) setStaged((prev) => [...prev, ...audios]);
  }

  async function uploadStaged(): Promise<void> {
    const items = staged;
    for (const item of items) {
      const result = await upload(item.file, 'audio', item.label.trim() || undefined);
      if (result) onUploaded();
    }
    setStaged([]);
  }

  function updateLabel(index: number, label: string): void {
    setStaged((prev) => prev.map((s, i) => (i === index ? { ...s, label } : s)));
  }

  return (
    <div className="relative inline-flex items-center gap-2">
      <input
        ref={inputRef}
        type="file"
        multiple
        accept="application/pdf,audio/*,.pdf,.mp3,.m4a,.aac,.ogg,.wav,.flac"
        className="hidden"
        onChange={(e) => void handleFiles(e.target.files)}
      />
      <Button size="sm" variant="outline" onClick={() => inputRef.current?.click()} disabled={busy}>
        {busy ? 'Uploading…' : '+ Add file'}
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

      {staged.length > 0 && (
        <div className="absolute left-0 top-full mt-1 z-30 w-80 bg-background border border-border rounded-md shadow-lg p-2 space-y-2">
          <div className="text-xs font-medium">
            Name {staged.length === 1 ? 'this track' : 'these tracks'} <span className="text-muted-foreground font-normal">(optional)</span>
          </div>
          <div className="space-y-1.5 max-h-64 overflow-auto">
            {staged.map((item, i) => (
              <div key={`${item.file.name}-${i}`} className="flex items-center gap-2">
                <span className="text-[9px] uppercase font-semibold px-1 py-0.5 rounded shrink-0 bg-violet-100 text-violet-800">
                  Audio
                </span>
                <div className="flex-1 min-w-0">
                  <input
                    type="text"
                    autoFocus={i === 0}
                    value={item.label}
                    onChange={(e) => updateLabel(i, e.target.value)}
                    placeholder="Voice part (e.g. Tenor 1)"
                    disabled={busy}
                    className="w-full text-xs h-7 px-1.5 rounded border border-border bg-background focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                  <div className="text-[10px] text-muted-foreground truncate px-1.5" title={item.file.name}>
                    {item.file.name}
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="flex items-center justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setStaged([])} disabled={busy}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => void uploadStaged()} disabled={busy}>
              {busy ? 'Uploading…' : `Upload ${staged.length} track${staged.length === 1 ? '' : 's'}`}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
