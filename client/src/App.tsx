import { useEffect, useState } from 'react';
import { PdfViewer } from '@/components/PdfViewer/index.ts';

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

  useEffect(() => {
    fetch('/api/health').then((r) => r.json()).then(setHealth).catch(() => setHealth(null));
    fetch('/auth/me', { credentials: 'include' }).then((r) => r.json()).then(setMe).catch(() => setMe(null));
  }, []);

  // For now we always show the seeded demo piece (id 1). A real piece list
  // / picker lands when there's something other than the dev placeholder.
  const pieceId = 1;

  return (
    <div className="h-screen flex flex-col">
      <header className="px-4 py-2 border-b border-border flex items-center gap-4 text-sm">
        <h1 className="font-semibold">choirfriend</h1>
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
        <PdfViewer pieceId={pieceId} />
      </main>
    </div>
  );
}
