import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button.tsx';

interface HealthResponse {
  status: string;
  service: string;
  time: string;
  database: 'ok' | 'unreachable';
}

export function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setError(null);
    try {
      const res = await fetch('/api/health');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setHealth(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setHealth(null);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-md space-y-6">
        <header className="space-y-1">
          <h1 className="text-3xl font-semibold tracking-tight">choirfriend</h1>
          <p className="text-sm text-muted-foreground">Sheet music, learning tracks, and a piano for your choir.</p>
        </header>

        <section className="rounded-lg border border-border p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium">Server health</h2>
            <Button size="sm" variant="outline" onClick={refresh}>
              Refresh
            </Button>
          </div>
          {error && <p className="text-sm text-destructive">Error: {error}</p>}
          {health && (
            <dl className="text-sm grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              <dt className="text-muted-foreground">Status</dt>
              <dd>{health.status}</dd>
              <dt className="text-muted-foreground">Database</dt>
              <dd>{health.database}</dd>
              <dt className="text-muted-foreground">Time</dt>
              <dd className="font-mono text-xs">{health.time}</dd>
            </dl>
          )}
        </section>

        <p className="text-xs text-muted-foreground">
          Skeleton scaffold. Real features coming next: PDF viewer, annotations, learning tracks, piano.
        </p>
      </div>
    </main>
  );
}
