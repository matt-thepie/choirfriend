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
import { getConfig } from '../config.ts';
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
  // Comma-separated role override so the dev bypass can pretend to be a
  // committee member or admin when exercising role-gated endpoints. Default
  // is just plain 'member' so we don't accidentally permit too much.
  const groups = (process.env.DEV_AUTH_ROLES ?? 'member')
    .split(',')
    .map((r) => r.trim().toLowerCase())
    .filter((r) => r.length > 0);
  return {
    providerUserId: email,
    email,
    displayName,
    groups,
    raw: { devBypass: true },
  };
}

/** Does the user hold any admin role from config.adminRoles? */
export function isAdmin(user: { groups: string[] }): boolean {
  const { adminRoles } = getConfig();
  if (adminRoles.length === 0) return false;
  const userGroups = new Set(user.groups.map((g) => g.toLowerCase()));
  return adminRoles.some((r) => userGroups.has(r));
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

/**
 * 401 if not signed in, 403 if signed in but not an admin (per
 * config.adminRoles). On success req.user is set as with requireAuth.
 */
export async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  await requireAuth(req, reply);
  if (reply.sent) return; // requireAuth already responded with 401
  if (!req.user || !isAdmin(req.user)) {
    reply.code(403).send({ error: 'forbidden', message: 'admin role required' });
  }
}
