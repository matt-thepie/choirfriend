/**
 * Generic OIDC provider — stub.
 *
 * Works against any spec-compliant OIDC issuer (Google, Microsoft Entra,
 * Keycloak, etc.). Configured via AUTH_OIDC_* env vars. Implementation
 * will use the `openid-client` library for discovery, PKCE, and token
 * verification, plus its own session cookie that identifyUser reads.
 *
 * Not implemented yet — sgmc-identity is the first concrete provider
 * (see ./sgmc-identity.ts). Bringing the OIDC variant up is the path
 * for other choirs deploying choirfriend against their own identity.
 */

import type { AuthProvider, AuthUser } from '../types.ts';

export function createOidcProvider(): AuthProvider {
  const issuer = process.env.AUTH_OIDC_ISSUER ?? '';
  const clientId = process.env.AUTH_OIDC_CLIENT_ID ?? '';
  const clientSecret = process.env.AUTH_OIDC_CLIENT_SECRET ?? '';
  const redirectUri = process.env.AUTH_OIDC_REDIRECT_URI ?? '';
  const label = process.env.AUTH_OIDC_LABEL ?? 'Sign in';

  if (!issuer || !clientId || !clientSecret || !redirectUri) {
    throw new Error(
      'AUTH_OIDC_ENABLED=true but AUTH_OIDC_{ISSUER,CLIENT_ID,CLIENT_SECRET,REDIRECT_URI} are required',
    );
  }

  return {
    name: 'oidc',
    label,

    buildLoginUrl() {
      // TODO: real PKCE flow via openid-client.
      void issuer;
      void clientId;
      void redirectUri;
      throw new Error('OIDC buildLoginUrl not yet implemented — see README');
    },

    async identifyUser(): Promise<AuthUser | null> {
      // TODO: read our own session cookie (set in handleCallback), look up the user.
      void clientSecret;
      return null;
    },

    async handleCallback() {
      // TODO: exchange code, verify id_token, set session cookie, redirect.
      throw new Error('OIDC handleCallback not yet implemented — see README');
    },
  };
}
