import type { FastifyInstance } from 'fastify';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import type { AppContext } from '../context';
import { ApiError } from '../errors';
import { readManifest } from '../usda/bundle';

export const USDA_FILES_PREFIX = '/api/usda/files/';

export async function usdaRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  function manifestOr404() {
    const manifest = readManifest(ctx.config.usdaDir);
    if (!manifest) throw new ApiError(404, 'usda_not_imported', 'Run `carbbook import-usda` on the server first');
    return manifest;
  }

  app.get('/api/usda/manifest', async () => {
    const manifest = manifestOr404();
    return {
      ...manifest,
      json_url: USDA_FILES_PREFIX + manifest.json_file,
      sqlite_url: USDA_FILES_PREFIX + manifest.sqlite_file,
    };
  });

  app.get<{ Params: { name: string } }>('/api/usda/files/:name', async (request, reply) => {
    const manifest = manifestOr404();
    const { name } = request.params;
    if (name !== manifest.json_file && name !== manifest.sqlite_file) {
      throw new ApiError(404, 'not_found', `No USDA bundle named ${name}`);
    }
    reply.header('cache-control', 'private, max-age=31536000, immutable');
    reply.type(name.endsWith('.sqlite') ? 'application/vnd.sqlite3' : 'application/gzip');
    return reply.send(createReadStream(join(ctx.config.usdaDir, name)));
  });
}
