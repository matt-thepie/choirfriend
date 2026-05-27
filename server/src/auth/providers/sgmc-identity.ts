/**
 * sgmc-identity auth provider.
 *
 * sgmc-identity is the bespoke passwordless identity service used by the
 * Solent Gay Men's Chorus. It sets a JWT cookie (`sgmc_token`) on the
 * parent domain `.sgmc.org.uk`, so any choir service on a subdomain
 * receives it for free.
 *
 * Per the SGMC platform SPEC, we MUST validate tokens by POSTing to
 * identity's `/verify` endpoint — not by verifying the JWT locally with
 * JWKS. The /verify endpoint adds session-validity checks (logout,
 * account lockdown) that local JWKS verification would miss.
 *
 * Login flow:
 *   1. choirfriend redirects unauthenticated users to
 *      `<identityBaseUrl>/?redirect=<music.sgmc.org.uk return URL>`
 *   2. identity authenticates (magic link or passkey)
 *   3. identity sets `sgmc_token` cookie on `.sgmc.org.uk` and redirects back
 *   4. choirfriend reads the cookie and POSTs to /verify on every request
 *
 * In production both services live on the same VPS — /verify is a localhost
 * call (no network). In dev, /verify is reached over HTTPS at the live
 * identity URL (slower but functional; or run identity locally with
 * /etc/hosts aliases for cookie sharing).
 */

import type { FastifyRequest } from 'fastify';
import type { AuthProvider, AuthUser } from '../types.ts';

const COOKIE_NAME = 'sgmc_token';

interface VerifyResponse {
  valid: true;
  email: string;
  roles: string[];
  amr?: string[];
  sub: string;
  exp: number;
  name?: string | null;
}

export function createSgmcIdentityProvider(): AuthProvider {
  // The user-facing identity URL — where we send browsers to sign in.
  // e.g. https://identity.sgmc.org.uk
  const publicBaseUrl = process.env.AUTH_SGMC_IDENTITY_PUBLIC_URL;
  // The /verify URL we hit server-side. In prod this is localhost:3050;
  // in dev it falls back to publicBaseUrl over HTTPS.
  const verifyUrl =
    process.env.AUTH_SGMC_IDENTITY_VERIFY_URL ?? (publicBaseUrl ? `${publicBaseUrl}/verify` : undefined);
  const label = process.env.AUTH_SGMC_IDENTITY_LABEL ?? 'Sign in with SGMC';

  if (!publicBaseUrl || !verifyUrl) {
    throw new Error(
      'AUTH_SGMC_IDENTITY_ENABLED=true but AUTH_SGMC_IDENTITY_{PUBLIC_URL,VERIFY_URL} are required ' +
        '(VERIFY_URL defaults to PUBLIC_URL + "/verify" but at least one must be set)',
    );
  }

  async function verifyToken(token: string): Promise<VerifyResponse | null> {
    try {
      const res = await fetch(verifyUrl!, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { valid?: boolean } & Partial<VerifyResponse>;
      if (!body.valid) return null;
      return body as VerifyResponse;
    } catch {
      return null;
    }
  }

  return {
    name: 'sgmc-identity',
    label,

    buildLoginUrl({ returnTo }) {
      const u = new URL(publicBaseUrl!);
      u.searchParams.set('redirect', returnTo);
      return u.toString();
    },

    async identifyUser(req: FastifyRequest): Promise<AuthUser | null> {
      // @fastify/cookie populates req.cookies after registration.
      const token = (req as FastifyRequest & { cookies?: Record<string, string> }).cookies?.[COOKIE_NAME];
      if (!token) return null;
      const verified = await verifyToken(token);
      if (!verified) return null;

      return {
        providerUserId: verified.sub,
        email: verified.email,
        displayName: verified.name ?? verified.email,
        groups: (verified.roles ?? []).map((r) => r.toLowerCase()),
        raw: verified,
      };
    },
  };
}
