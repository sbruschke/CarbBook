import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import { resolve } from 'node:path';

const HAS_EXTENSION = /\.[A-Za-z0-9]+$/;

/**
 * Serves the built web PWA from `webDir` and falls back to index.html for client-side routes.
 * `/api/*` and missing asset files always get a JSON 404.
 */
export async function registerWebApp(app: FastifyInstance, webDir: string | null): Promise<void> {
  if (webDir) {
    await app.register(fastifyStatic, { root: resolve(webDir), wildcard: false });
  }
  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split('?')[0]!;
    if (webDir && request.method === 'GET' && !path.startsWith('/api/') && !HAS_EXTENSION.test(path)) {
      return reply.type('text/html; charset=utf-8').sendFile('index.html');
    }
    return reply.code(404).send({ error: 'not_found', message: `No route for ${request.method} ${path}` });
  });
}
