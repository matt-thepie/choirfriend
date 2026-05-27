import type { FastifyPluginAsync } from 'fastify';
import { getProvider, listProviders } from './index.ts';
import { requireAuth, resolveUser } from './middleware.ts';
import { getConfig } from '../config.ts';

export const authRoutes: FastifyPluginAsync = async (app) => {
  const config = getConfig();

  /** What providers are enabled? The client renders the sign-in page from this. */
  app.get('/providers', async () => {
    return listProviders().map((p) => ({ name: p.name, label: p.label }));
  });

  /**
   * Kick off a login. Single-provider deployments can use /auth/login;
   * multi-provider ones pick a specific provider via /auth/<name>/start.
   */
  app.get<{ Querystring: { returnTo?: string } }>('/login', async (req, reply) => {
    const providers = listProviders();
    if (providers.length === 0) {
      return reply.code(503).send({ error: 'no auth providers configured' });
    }
    if (providers.length > 1) {
      // Multiple providers — let the client pick.
      return reply.redirect(`${config.clientOrigin}/login`);
    }
    const returnTo = req.query.returnTo ?? config.clientOrigin;
    const url = await providers[0]!.buildLoginUrl({ returnTo });
    return reply.redirect(url);
  });

  app.get<{ Params: { name: string }; Querystring: { returnTo?: string } }>(
    '/:name/start',
    async (req, reply) => {
      const provider = getProvider(req.params.name);
      if (!provider) return reply.code(404).send({ error: 'unknown provider' });
      const returnTo = req.query.returnTo ?? config.clientOrigin;
      const url = await provider.buildLoginUrl({ returnTo });
      return reply.redirect(url);
    },
  );

  /**
   * OIDC-style callback. Only providers that implement handleCallback need
   * this path — sgmc-identity does not, since the cookie is set by the
   * identity service directly and there's no code to exchange.
   */
  app.get<{ Params: { name: string } }>('/:name/callback', async (req, reply) => {
    const provider = getProvider(req.params.name);
    if (!provider) return reply.code(404).send({ error: 'unknown provider' });
    if (!provider.handleCallback) {
      return reply.code(400).send({ error: 'provider has no callback step' });
    }
    await provider.handleCallback(req, reply);
  });

  /**
   * Who am I? Returns the verified user if signed in, otherwise null.
   * The client polls this on boot to decide whether to show a sign-in
   * button or the app shell.
   */
  app.get('/me', async (req) => {
    const user = await resolveUser(req);
    if (!user) return { signedIn: false };
    return {
      signedIn: true,
      email: user.email,
      displayName: user.displayName,
      groups: user.groups,
    };
  });

  /**
   * Trivial protected route — proves the requireAuth middleware works
   * end-to-end. Will be removed once real protected routes exist.
   */
  app.get('/whoami', { preHandler: requireAuth }, async (req) => {
    return req.user;
  });
};
