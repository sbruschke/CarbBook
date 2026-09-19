import { IMAGE_HASH_PATTERN } from '@carbbook/core';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { ApiError } from '../errors';
import { searchImages } from '../images/search';

export async function imageRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get<{ Params: { hash: string } }>('/api/images/:hash', async (request, reply) => {
    const { hash } = request.params;
    // Validated before the store is asked anything: this is what keeps a crafted path from
    // ever reaching the filesystem.
    if (!IMAGE_HASH_PATTERN.test(hash)) throw new ApiError(400, 'invalid_hash', 'Not an image hash');
    if (!(await ctx.deps.images.has(hash))) throw new ApiError(404, 'not_found', 'No image with that hash');

    // The URL is the content hash, so the bytes can never change: cache forever.
    reply.header('cache-control', 'private, max-age=31536000, immutable');
    reply.type('image/jpeg');
    return reply.send(ctx.deps.images.read(hash));
  });

  app.get<{ Querystring: { q?: string; limit?: string } }>(
    '/api/images/search',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['q'],
          additionalProperties: false,
          properties: {
            q: { type: 'string', minLength: 1, maxLength: 200 },
            limit: { type: 'integer', minimum: 1, maximum: 48 },
          },
        },
      },
    },
    async (request) => {
      const { q, limit } = request.query as { q: string; limit?: number };
      return searchImages(ctx.deps.imageProviders, q, limit ?? 24);
    },
  );
}
