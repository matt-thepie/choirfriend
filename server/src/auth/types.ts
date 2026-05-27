/**
 * Pluggable auth provider interface.
 *
 * choirfriend is open source and meant to be deployed against any identity
 * provider — Google, Microsoft, Keycloak, sgmc-identity, etc. Each provider
 * implementation lives in ./providers/ and is registered in ./index.ts based
 * on environment variables.
 *
 * The contract is deliberately small: kick off a login, handle the callback,
 * return a normalised user record. Anything more elaborate (refresh, MFA,
 * org sync) goes in the provider implementation.
 */

export interface AuthUser {
  /** Stable provider-scoped id. We persist (provider, providerUserId). */
  providerUserId: string;
  email: string;
  displayName: string;
  /** Provider-supplied groups/roles, normalised to lowercase strings. */
  groups: string[];
  /** Anything else the provider returned, for debugging/observability. */
  raw: unknown;
}

export interface AuthProvider {
  /** Unique key — used in URLs (/auth/<name>/start) and the providers table. */
  readonly name: string;
  /** Human label shown on the sign-in page. */
  readonly label: string;
  /** Redirect the user to the provider's authorize endpoint. */
  startLogin(opts: { redirectAfter?: string }): Promise<{ redirectUrl: string; state: string }>;
  /** Exchange the callback params for a normalised user record. */
  handleCallback(query: Record<string, string | undefined>): Promise<AuthUser>;
}
