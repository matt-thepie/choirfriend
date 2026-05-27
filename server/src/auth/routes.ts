import type { FastifyPluginAsync } from 'fastify';
import { getProvider, listProviders } from './index.ts';

export const authRoutes: FastifyPluginAsync = async (app) => {
  /** What providers are enabled? Used by the client to render the sign-in page. */
  app.get('/providers', async () => {
    return listProviders().map((p) => ({ name: p.name, label: p.label }));
  });

  /** Kick off a login with provider <name>. */
  app.get<{ Params: { name: string } }>('/:name/start', async (req, reply) => {
    const provider = getProvider(req.params.name);
    if (!provider) return reply.code(404).send({ error: 'unknown provider' });
    const { redirectUrl, state } = await provider.startLogin({});
    // TODO: persist `state` in a signed cookie to check on callback.
    void state;
    return reply.redirect(redirectUrl);
  });

  /** Handle the provider redirect. */
  app.get<{ Params: { name: string }; Querystring: Record<string, string> }>(
    '/:name/callback',
    async (req, reply) => {
      const provider = getProvider(req.params.name);
      if (!provider) return reply.code(404).send({ error: 'unknown provider' });
      // TODO: verify state cookie matches req.query.state.
      const user = await provider.handleCallback(req.query);
      // TODO: upsert user row, set session cookie, redirect to client.
      return reply.send({ ok: true, user });
    },
  );
};
