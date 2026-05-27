/**
 * Generic OIDC provider.
 *
 * Works against any spec-compliant OIDC issuer (Google, Microsoft Entra,
 * Keycloak, sgmc-identity, etc.). Configured via AUTH_OIDC_* env vars.
 *
 * NOTE: This is a stub. The full implementation will use the `openid-client`
 * library to do discovery, PKCE, and token verification. Wiring it up
 * properly comes once matt drops the sgmc-identity code in so we have a
 * concrete reference issuer to test against.
 */

import type { AuthProvider, AuthUser } from '../types.ts';

export function createOidcProvider(): AuthProvider {
  const issuer = process.env.AUTH_OIDC_ISSUER ?? '';
  const clientId = process.env.AUTH_OIDC_CLIENT_ID ?? '';
  const clientSecret = process.env.AUTH_OIDC_CLIENT_SECRET ?? '';
  const redirectUri = process.env.AUTH_OIDC_REDIRECT_URI ?? '';
  const scopes = (process.env.AUTH_OIDC_SCOPES ?? 'openid profile email').split(/\s+/);
  const label = process.env.AUTH_OIDC_LABEL ?? 'Sign in';

  if (!issuer || !clientId || !clientSecret || !redirectUri) {
    throw new Error(
      'AUTH_OIDC_ENABLED=true but AUTH_OIDC_{ISSUER,CLIENT_ID,CLIENT_SECRET,REDIRECT_URI} are required',
    );
  }

  return {
    name: 'oidc',
    label,

    async startLogin() {
      // TODO: real PKCE flow via openid-client.
      // Discovery: await Issuer.discover(issuer)
      // Build authorize URL with state + nonce, persist state in session.
      void issuer;
      void clientId;
      void redirectUri;
      void scopes;
      throw new Error('OIDC startLogin not yet implemented — see README');
    },

    async handleCallback(_query): Promise<AuthUser> {
      // TODO: exchange code for tokens, verify id_token, project to AuthUser.
      void clientSecret;
      throw new Error('OIDC handleCallback not yet implemented — see README');
    },
  };
}
