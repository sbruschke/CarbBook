import type { FastifyInstance } from 'fastify';
import { BgUnavailableError } from '../bg/client';
import type { AppContext } from '../context';
import { ApiError } from '../errors';

/** Clients prefill BG only when the reading is at most this old (spec §4.4). */
export const BG_FRESH_MS = 15 * 60 * 1000;

/** Clock skew tolerance: readings timestamped further ahead than this are never "fresh". */
export const BG_FUTURE_TOLERANCE_MS = 2 * 60 * 1000;

export async function bgRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/bg', async () => {
    try {
      const reading = await ctx.deps.bg.latest();
      const rawAgeMs = ctx.deps.now() - reading.read_at;
      const ageMs = Math.max(0, rawAgeMs);
      const fresh = rawAgeMs >= -BG_FUTURE_TOLERANCE_MS && ageMs <= BG_FRESH_MS;
      return { ...reading, age_ms: ageMs, fresh };
    } catch (error) {
      if (error instanceof BgUnavailableError) throw new ApiError(503, 'bg_unavailable', error.message);
      throw error;
    }
  });
}
