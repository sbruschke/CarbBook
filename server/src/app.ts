import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { makeAuthenticate } from './auth/plugin';
import { createDexcomApiClient } from './bg/client';
import type { Config } from './config';
import type { AppContext, AppDeps } from './context';
import { csrfContentTypeGuard } from './csrf';
import type { Db } from './db';
import { errorHandler } from './errors';
import { loginRoutes, sessionRoutes } from './routes/auth';
import { bgRoutes } from './routes/bg';
import { syncRoutes } from './routes/sync';
import { registerWebApp } from './static';

export interface BuildAppOptions {
  db: Db;
  config: Config;
  deps?: Partial<AppDeps>;
  logger?: boolean;
}

export function defaultDeps(config: Config): AppDeps {
  return {
    now: () => Date.now(),
    bg: createDexcomApiClient({
      baseUrl: config.dexcomApiUrl,
      token: config.dexcomApiToken,
      timeoutMs: config.httpTimeoutMs,
      fetch: globalThis.fetch,
    }),
  };
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const ctx: AppContext = {
    db: options.db,
    config: options.config,
    deps: { ...defaultDeps(options.config), ...options.deps },
  };
  const app = Fastify({
    logger: options.logger ?? false,
    // Never let Fastify itself trust proxy headers: the leftmost X-Forwarded-For
    // entry is client-controlled. `config.trustProxy` instead gates a validated
    // read of Cloudflare's CF-Connecting-IP via `clientIp()` (see src/ip.ts).
    trustProxy: false,
    bodyLimit: 5 * 1024 * 1024,
  });
  app.setErrorHandler(errorHandler);
  app.decorateRequest('auth', null);
  app.addHook('onRequest', csrfContentTypeGuard);
  await app.register(cookie);
  await app.register(rateLimit, { global: false });

  app.get('/api/health', async () => ({ ok: true }));
  await app.register(loginRoutes, ctx);

  await app.register(async (api) => {
    api.addHook('onRequest', makeAuthenticate(ctx));
    await api.register(sessionRoutes, ctx);
    await api.register(bgRoutes, ctx);
    await api.register(syncRoutes, ctx);
  });

  await registerWebApp(app, options.config.webDir);
  return app;
}
