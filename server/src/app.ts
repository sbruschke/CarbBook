import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { makeAuthenticate } from './auth/plugin';
import type { Config } from './config';
import type { AppContext, AppDeps } from './context';
import type { Db } from './db';
import { errorHandler } from './errors';
import { loginRoutes, sessionRoutes } from './routes/auth';

export interface BuildAppOptions {
  db: Db;
  config: Config;
  deps?: Partial<AppDeps>;
  logger?: boolean;
}

export function defaultDeps(_config: Config): AppDeps {
  return { now: () => Date.now() };
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const ctx: AppContext = {
    db: options.db,
    config: options.config,
    deps: { ...defaultDeps(options.config), ...options.deps },
  };
  const app = Fastify({
    logger: options.logger ?? false,
    trustProxy: options.config.trustProxy,
    bodyLimit: 5 * 1024 * 1024,
  });
  app.setErrorHandler(errorHandler);
  app.decorateRequest('auth', null);
  await app.register(cookie);
  await app.register(rateLimit, { global: false });

  app.get('/api/health', async () => ({ ok: true }));
  await app.register(loginRoutes, ctx);

  await app.register(async (api) => {
    api.addHook('onRequest', makeAuthenticate(ctx));
    await api.register(sessionRoutes, ctx);
  });

  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split('?')[0]!;
    return reply.code(404).send({ error: 'not_found', message: `No route for ${request.method} ${path}` });
  });
  return app;
}
