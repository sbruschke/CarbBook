import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from './config';
import type { AppDeps } from './context';
import type { Db } from './db';
import { errorHandler } from './errors';

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
  const app = Fastify({
    logger: options.logger ?? false,
    trustProxy: options.config.trustProxy,
    bodyLimit: 5 * 1024 * 1024,
  });
  app.setErrorHandler(errorHandler);

  app.get('/api/health', async () => ({ ok: true }));

  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split('?')[0]!;
    return reply.code(404).send({ error: 'not_found', message: `No route for ${request.method} ${path}` });
  });
  return app;
}
