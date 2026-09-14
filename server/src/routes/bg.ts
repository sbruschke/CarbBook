import type { FastifyInstance } from 'fastify';
import { BgUnavailableError } from '../bg/client';
import type { AppContext } from '../context';
import { ApiError } from '../errors';

/** Clients prefill BG only when the reading is at most this old (spec §4.4). */
export const BG_FRESH_MS = 15 * 60 * 1000;

export async function bgRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/bg', async () => {
    try {
      const reading = await ctx.deps.bg.latest();
      const ageMs = Math.max(0, ctx.deps.now() - reading.read_at);
      return { ...reading, age_ms: ageMs, fresh: ageMs <= BG_FRESH_MS };
    } catch (error) {
      if (error instanceof BgUnavailableError) throw new ApiError(503, 'bg_unavailable', error.message);
      throw error;
    }
  });
}
