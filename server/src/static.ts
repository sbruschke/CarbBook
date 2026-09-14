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
    await app.register(fastifyStatic, {
      root: resolve(webDir),
      wildcard: false,
      // Refuse dotfile paths (e.g. `/.env`) outright rather than relying solely on
      // the glob happening not to have picked them up.
      dotfiles: 'deny',
      setHeaders(reply, filePath) {
        // The HTML shell must be revalidated on every load so deploys aren't stuck
        // behind a cached page referencing stale hashed asset URLs; hashed assets
        // under /assets/* keep the default long-lived caching.
        if (filePath.endsWith('/index.html') || filePath.endsWith('\\index.html')) {
          reply.header('cache-control', 'no-cache');
        }
      },
    });
  }
  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split('?')[0]!;
    const method = request.method === 'GET' || request.method === 'HEAD';
    if (webDir && method && !path.startsWith('/api/') && !HAS_EXTENSION.test(path)) {
      reply.header('cache-control', 'no-cache');
      return reply.type('text/html; charset=utf-8').sendFile('index.html');
    }
    return reply.code(404).send({ error: 'not_found', message: `No route for ${request.method} ${path}` });
  });
}
