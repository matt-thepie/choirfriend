import { useRef } from 'react';
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

/**
 * Compact upload control. Hidden `<input type=file>` triggered by a button
 * label. Infers `kind` from the file's MIME type. Multi-file picking uploads
 * each in sequence (one B2 PUT at a time keeps total bandwidth predictable).
 */
export function UploadButton({ pieceId, onUploaded }: UploadButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const { status, upload } = useUploadFile(pieceId);
  const description = describeStatus(status);
  const busy = status.phase === 'signing' || status.phase === 'uploading' || status.phase === 'completing';

  async function handleFiles(files: FileList | null): Promise<void> {
    if (!files) return;
    for (const file of Array.from(files)) {
      const kind = inferKind(file);
      if (!kind) {
        console.warn('[upload] unsupported file kind, skipping:', file.name, file.type);
        continue;
      }
      const result = await upload(file, kind);
      if (result) onUploaded();
    }
    if (inputRef.current) inputRef.current.value = '';
  }

  return (
    <>
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
    </>
  );
}
