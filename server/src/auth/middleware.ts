/**
 * Auth middleware. Walks every registered provider until one recognises
 * the request, attaches the user to req, otherwise responds 401.
 *
 * Dev-mode bypass: when NODE_ENV !== 'production' AND DEV_AUTH_BYPASS=true,
 * unauthenticated requests are treated as a synthetic dev user. Lets matt
 * test annotation persistence locally without /etc/hosts trickery to share
 * cookies with identity.sgmc.org.uk. The bypass refuses to activate in
 * production regardless of the env var — see resolveDevBypass below.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { listProviders } from './index.ts';
import { upsertUserByEmail } from '../db/index.ts';
import type { AuthUser } from './types.ts';

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser & { internalId: number };
  }
}

function resolveDevBypass(): AuthUser | null {
  if (process.env.NODE_ENV === 'production') return null;
  if (process.env.DEV_AUTH_BYPASS !== 'true') return null;
  const email = process.env.DEV_AUTH_EMAIL ?? 'dev@choirfriend.local';
  const displayName = process.env.DEV_AUTH_NAME ?? 'Dev User';
  return {
    providerUserId: email,
    email,
    displayName,
    groups: ['member'],
    raw: { devBypass: true },
  };
}

export async function resolveUser(req: FastifyRequest): Promise<AuthUser | null> {
  for (const provider of listProviders()) {
    const user = await provider.identifyUser(req);
    if (user) return user;
  }
  return resolveDevBypass();
}

/**
 * Use with `app.get('/x', { preHandler: requireAuth }, handler)`.
 * On success, req.user is set. On failure, replies 401 and the handler
 * never runs.
 */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const user = await resolveUser(req);
  if (!user) {
    reply.code(401).send({ error: 'unauthenticated' });
    return;
  }
  const internalId = upsertUserByEmail({
    email: user.email,
    displayName: user.displayName,
    roles: user.groups,
  });
  req.user = { ...user, internalId };
}
