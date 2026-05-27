/**
 * Auth provider registry. Reads env vars and instantiates each enabled
 * provider. Add new providers by dropping a file in ./providers/ and wiring
 * them up here.
 *
 * Resolution order matters: the requireAuth middleware tries providers in
 * the order they're inserted, returning the first one that recognises the
 * request. For typical single-provider deployments, order is irrelevant.
 */

import type { AuthProvider } from './types.ts';
import { createSgmcIdentityProvider } from './providers/sgmc-identity.ts';
import { createOidcProvider } from './providers/oidc.ts';

const providers = new Map<string, AuthProvider>();

if (process.env.AUTH_SGMC_IDENTITY_ENABLED === 'true') {
  providers.set('sgmc-identity', createSgmcIdentityProvider());
}

if (process.env.AUTH_OIDC_ENABLED === 'true') {
  providers.set('oidc', createOidcProvider());
}

// Future: createGoogleProvider, createMicrosoftProvider,
// createMagicLinkProvider, ...

export function listProviders(): AuthProvider[] {
  return [...providers.values()];
}

export function getProvider(name: string): AuthProvider | undefined {
  return providers.get(name);
}
