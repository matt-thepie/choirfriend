/**
 * Auth middleware. Walks every registered provider until one recognises
 * the request, attaches the user to req, otherwise responds 401.
 *
 * Most deployments will only configure one provider, but iterating keeps
 * the code provider-agnostic and means a future "log in with Google OR
 * sgmc-identity" choice doesn't need a refactor.
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

export async function resolveUser(req: FastifyRequest): Promise<AuthUser | null> {
  for (const provider of listProviders()) {
    const user = await provider.identifyUser(req);
    if (user) return user;
  }
  return null;
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
  // Mirror the upstream identity into our local users table so we have a
  // stable internal id to foreign-key against (annotations, etc.).
  const internalId = upsertUserByEmail({
    email: user.email,
    displayName: user.displayName,
    roles: user.groups,
  });
  req.user = { ...user, internalId };
}
