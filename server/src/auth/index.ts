/**
 * Auth provider registry. Reads env vars and instantiates each enabled
 * provider. Add new providers by dropping a file in ./providers/ and wiring
 * it up here.
 */

import type { AuthProvider } from './types.ts';
import { createOidcProvider } from './providers/oidc.ts';

const providers = new Map<string, AuthProvider>();

if (process.env.AUTH_OIDC_ENABLED === 'true') {
  providers.set('oidc', createOidcProvider());
}

// Future: createGoogleProvider, createMicrosoftProvider,
// createSgmcIdentityProvider, createMagicLinkProvider, ...

export function listProviders(): AuthProvider[] {
  return [...providers.values()];
}

export function getProvider(name: string): AuthProvider | undefined {
  return providers.get(name);
}
