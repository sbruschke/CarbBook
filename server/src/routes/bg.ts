import type { FastifyInstance } from 'fastify';
import { BgUnavailableError } from '../bg/client';
import type { AppContext } from '../context';
import { ApiError } from '../errors';

/** Clients prefill BG only when the reading is at most this old (spec §4.4). */
export const BG_FRESH_MS = 15 * 60 * 1000;

/** Clock skew tolerance: readings timestamped further ahead than this are never "fresh". */
export const BG_FUTURE_TOLERANCE_MS = 2 * 60 * 1000;

/** Longest range one request may ask for (dexcom-api caps at 120 days). */
export const BG_RANGE_MAX_MS = 92 * 24 * 60 * 60 * 1000;

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

  /** Stored CGM history for charts and trends. Display only: nothing here feeds a dose. */
  app.get<{ Querystring: { from?: string; to?: string } }>('/api/bg/readings', async (request) => {
    const from = Number(request.query.from);
    const to = Number(request.query.to);
    if (!Number.isInteger(from) || !Number.isInteger(to) || to <= from || to - from > BG_RANGE_MAX_MS) {
      throw new ApiError(400, 'invalid_range', 'from and to must be ms since epoch, from < to, at most 92 days apart');
    }
    try {
      return await ctx.deps.bg.range(from, to);
    } catch (error) {
      if (error instanceof BgUnavailableError) throw new ApiError(503, 'bg_unavailable', error.message);
      throw error;
    }
  });
}
