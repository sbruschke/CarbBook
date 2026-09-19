import { IMAGE_ATTRIBUTION_MAX, IMAGE_HASH_PATTERN, type ImageData, type ImageSource } from '@carbbook/core';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { ApiError } from '../errors';
import { searchImages } from '../images/search';
import { ImageRejectedError, type StoredImage } from '../images/store';
import { type AdoptProvider, assertAdoptableUrl, UrlRejectedError } from '../images/urlguard';
import { applyPush } from '../sync/push';

type ImageRow = ImageData & { updated_at: number; updated_by: string; deleted: number; server_seq: number };

/**
 * Insert the `image` metadata row for stored bytes, or return the existing one.
 *
 * This writes only the `image` table. The client sets food.image_id / meal.image_id through its
 * ordinary sync push, so that edit participates in last-write-wins and offline queueing like every
 * other change — a route never writes a food or meal.
 *
 * Re-adopting an existing hash returns the stored row untouched: the bytes are identical by
 * definition, and overwriting the metadata would discard the attribution captured the first time.
 */
function upsertImageRow(
  ctx: AppContext,
  stored: StoredImage,
  meta: { source: ImageSource; source_url: string | null; license: string | null; attribution: string | null },
): ImageRow {
  const existing = ctx.db.prepare('SELECT * FROM image WHERE id = ?').get(stored.id) as ImageRow | undefined;
  if (existing && existing.deleted === 0) return existing;

  const record = {
    id: stored.id,
    mime: stored.mime,
    width: stored.width,
    height: stored.height,
    source: meta.source,
    source_url: meta.source_url,
    license: meta.license,
    attribution: meta.attribution,
    // Reviving a soft-deleted row has to win last-write-wins against the delete that is already
    // stored, and that delete may carry a newer timestamp than our clock — so step past it.
    updated_at: existing ? Math.max(ctx.deps.now(), existing.updated_at + 1) : ctx.deps.now(),
    updated_by: 'server-images',
    deleted: 0,
  };
  // Through the sync path so validation, server_seq assignment and last-write-wins are identical
  // to a device push, and the row reaches every client on its next pull.
  const [result] = applyPush(ctx.db, 'owner', [{ table: 'image', record }]);
  if (result?.status !== 'accepted') {
    const reason = result && 'message' in result ? result.message : (result?.status ?? 'unknown reason');
    throw new ApiError(500, 'image_row_rejected', `Image metadata rejected: ${reason}`);
  }
  return ctx.db.prepare('SELECT * FROM image WHERE id = ?').get(stored.id) as ImageRow;
}

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

  const ADOPT_SOURCES = ['off', 'openverse', 'wikimedia', 'themealdb'] as const;

  app.post<{ Body: { url: string; source: AdoptProvider; source_url?: string; license?: string; attribution?: string } }>(
    '/api/images/adopt',
    {
      schema: {
        body: {
          type: 'object',
          required: ['url', 'source'],
          additionalProperties: false,
          properties: {
            url: { type: 'string', minLength: 1, maxLength: 2048 },
            // `upload` is deliberately absent: that is the other route.
            source: { type: 'string', enum: ADOPT_SOURCES },
            source_url: { type: 'string', maxLength: 2048 },
            license: { type: 'string', maxLength: 120 },
            attribution: { type: 'string', maxLength: IMAGE_ATTRIBUTION_MAX },
          },
        },
      },
    },
    async (request) => {
      const { url, source, source_url, license, attribution } = request.body;

      // Gate one: https, no credentials, default port, a host this provider serves bytes from,
      // and every resolved address public.
      try {
        await assertAdoptableUrl(url, source, { lookup: ctx.deps.dnsLookup });
      } catch (error) {
        if (error instanceof UrlRejectedError) throw new ApiError(400, 'url_rejected', error.message);
        throw error;
      }

      let bytes: Buffer;
      try {
        bytes = await ctx.deps.fetchImage(url);
      } catch (error) {
        // Bad content is the client's problem; an unreachable host is the upstream's.
        if (error instanceof ImageRejectedError) throw new ApiError(400, 'image_rejected', error.message);
        throw new ApiError(502, 'image_unavailable', `Could not fetch the image: ${(error as Error).message}`);
      }

      // Gate two: the bytes must really be an image, whatever the host's content-type said.
      let stored;
      try {
        stored = await ctx.deps.images.put(bytes);
      } catch (error) {
        if (error instanceof ImageRejectedError) throw new ApiError(400, 'image_rejected', error.message);
        throw error;
      }

      return upsertImageRow(ctx, stored, {
        source,
        source_url: source_url ?? url,
        license: license ?? null,
        attribution: attribution ?? null,
      });
    },
  );
}
