import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button.tsx';

interface ProviderEntry {
  name: string;
  label: string;
}

/**
 * Shown when /auth/me reports signedIn:false. Pulls the configured providers
 * from /auth/providers so the sign-in CTA matches whichever auth the host
 * choir has wired up (sgmc-identity for SGMC, generic OIDC for everyone
 * else once that provider is implemented).
 *
 * For now nothing on the page makes an authenticated request, so a
 * not-signed-in user sees no 401s in their console.
 */
export function SignInScreen() {
  const [providers, setProviders] = useState<ProviderEntry[] | null>(null);

  useEffect(() => {
    fetch('/auth/providers', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : []))
      .then(setProviders)
      .catch(() => setProviders([]));
  }, []);

  return (
    <div className="h-screen flex items-center justify-center bg-muted/20 p-6">
      <div className="w-full max-w-sm rounded-lg border border-border bg-background p-6 space-y-4 shadow-sm">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">choirfriend</h1>
          <p className="text-sm text-muted-foreground">
            Sign in to view your choir's repertoire, learning tracks, and the piano.
          </p>
        </header>

        {providers === null && <p className="text-xs text-muted-foreground">Loading…</p>}

        {providers && providers.length === 0 && (
          <div className="rounded-md border border-amber-400 bg-amber-50 text-amber-900 p-3 text-xs">
            No auth providers are configured on this server. Set <code>AUTH_SGMC_IDENTITY_ENABLED=true</code>
            {' '}(or one of the other provider env vars) and restart the server.
          </div>
        )}

        {providers && providers.length === 1 && (
          <a
            href={`/auth/${providers[0]!.name}/start?returnTo=${encodeURIComponent(window.location.href)}`}
            className="block"
          >
            <Button size="lg" className="w-full">{providers[0]!.label}</Button>
          </a>
        )}

        {providers && providers.length > 1 && (
          <div className="space-y-2">
            {providers.map((p) => (
              <a
                key={p.name}
                href={`/auth/${p.name}/start?returnTo=${encodeURIComponent(window.location.href)}`}
                className="block"
              >
                <Button size="lg" variant="outline" className="w-full">{p.label}</Button>
              </a>
            ))}
          </div>
        )}

        <p className="text-xs text-muted-foreground pt-2 border-t border-border">
          If you don't have an account, ask your choir's admin to add you.
        </p>
      </div>
    </div>
  );
}
