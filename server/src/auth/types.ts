/**
 * Pluggable auth provider interface.
 *
 * choirfriend is open source and meant to be deployed against any identity
 * provider — sgmc-identity, generic OIDC (Google, Microsoft, Keycloak, etc.),
 * magic links, whatever future-us writes. Each provider implementation lives
 * in ./providers/ and is registered in ./index.ts based on env vars.
 *
 * Two provider shapes are supported:
 *
 *   1. Cookie-trusting (sgmc-identity, similar shared-domain setups):
 *      the identity service has already set a cookie on a parent domain,
 *      so the provider just needs to verify that cookie and return the user.
 *      No callback step.
 *
 *   2. OIDC-style: redirect to issuer, get a code back at a callback URL,
 *      exchange for tokens, then set our own session cookie. The session
 *      cookie is what identifyUser reads on subsequent requests.
 *
 * The interface is small: send the user somewhere to authenticate, then
 * given an inbound request, tell us who the user is.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

export interface AuthUser {
  /** Stable provider-scoped id. Usually email for OIDC and sgmc-identity. */
  providerUserId: string;
  email: string;
  displayName: string;
  /** Provider-supplied groups/roles, normalised to lowercase strings. */
  groups: string[];
  /** Whatever raw payload the provider returned, kept for debugging. */
  raw: unknown;
}

export interface AuthProvider {
  /** Unique key — used in URLs (/auth/<name>/start) and the providers table. */
  readonly name: string;
  /** Human label shown on the sign-in page. */
  readonly label: string;

  /**
   * Build the URL we should redirect the browser to in order to authenticate.
   * `returnTo` is a fully-qualified choirfriend URL the user should land back
   * on once they're signed in.
   */
  buildLoginUrl(opts: { returnTo: string }): string | Promise<string>;

  /**
   * Look at the incoming request and decide whether the user is signed in
   * via this provider. Cookie-trusting providers inspect a cross-domain
   * cookie; OIDC providers inspect their own session cookie. Returns null
   * when no user is signed in.
   */
  identifyUser(req: FastifyRequest): Promise<AuthUser | null>;

  /**
   * Optional: complete a redirect flow. Present for OIDC-style providers
   * that get a code at /auth/<name>/callback and exchange it for tokens.
   * Absent for cookie-trusting providers like sgmc-identity.
   */
  handleCallback?(req: FastifyRequest, reply: FastifyReply): Promise<void>;
}
