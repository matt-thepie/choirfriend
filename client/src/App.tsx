import { useEffect, useState } from 'react';
import { PdfViewer } from '@/components/PdfViewer/index.ts';
import { PiecePicker } from '@/components/PiecePicker.tsx';
import { usePieces } from '@/hooks/usePieces.ts';

interface HealthResponse {
  status: string;
  database: 'ok' | 'unreachable';
}

interface MeResponse {
  signedIn: boolean;
  email?: string;
  displayName?: string;
}

export function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [me, setMe] = useState<MeResponse | null>(null);

  const { pieces, loading: piecesLoading, refresh: refreshPieces } = usePieces();
  // Auto-select the most recently updated piece on first load so the user
  // doesn't stare at an empty page.
  const [pieceId, setPieceId] = useState<number | null>(null);
  useEffect(() => {
    if (pieceId === null && pieces.length > 0) setPieceId(pieces[0]!.id);
  }, [pieces, pieceId]);

  useEffect(() => {
    fetch('/api/health').then((r) => r.json()).then(setHealth).catch(() => setHealth(null));
    fetch('/auth/me', { credentials: 'include' }).then((r) => r.json()).then(setMe).catch(() => setMe(null));
  }, []);

  return (
    <div className="h-screen flex flex-col">
      <header className="px-4 py-2 border-b border-border flex items-center gap-4 text-sm">
        <h1 className="font-semibold">choirfriend</h1>
        <PiecePicker
          pieces={pieces}
          loading={piecesLoading}
          selectedId={pieceId}
          onSelect={setPieceId}
          onCreated={refreshPieces}
        />
        <div className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
          {me?.signedIn ? (
            <span>Signed in as {me.displayName}</span>
          ) : (
            <a href="/auth/login" className="underline hover:text-foreground">Sign in</a>
          )}
          <span title={`server: ${health?.status ?? '?'} · db: ${health?.database ?? '?'}`}>
            <span className={`inline-block w-2 h-2 rounded-full mr-1 ${health?.database === 'ok' ? 'bg-emerald-500' : 'bg-amber-500'}`} />
            {health ? `server ${health.database}` : 'server …'}
          </span>
        </div>
      </header>

      <main className="flex-1 min-h-0">
        {pieceId === null ? (
          <div className="h-full flex items-center justify-center">
            <p className="text-sm text-muted-foreground">
              {piecesLoading ? 'Loading pieces…' : 'Pick a piece, or create a new one to get started.'}
            </p>
          </div>
        ) : (
          <PdfViewer pieceId={pieceId} onPieceMutated={refreshPieces} />
        )}
      </main>
    </div>
  );
}
