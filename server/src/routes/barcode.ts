import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { OffUnavailableError } from '../off/client';
import { barcodeCandidates, normalizeOffProduct } from '../off/normalize';
import { TABLE_SPECS } from '../sync/tables';
import { decodeRow } from '../sync/validate';

export async function barcodeRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get<{ Params: { code: string } }>(
    '/api/barcode/:code',
    {
      schema: {
        params: {
          type: 'object',
          required: ['code'],
          properties: { code: { type: 'string', pattern: '^[0-9]{6,14}$' } },
        },
      },
    },
    async (request) => {
      const { code } = request.params;
      const candidates = barcodeCandidates(code);
      const food = ctx.db
        .prepare(
          `SELECT food.* FROM barcode JOIN food ON food.id = barcode.food_id
            WHERE barcode.deleted = 0 AND food.deleted = 0
              AND barcode.code IN (${candidates.map(() => '?').join(', ')})
            ORDER BY barcode.updated_at DESC LIMIT 1`,
        )
        .get(...candidates) as Record<string, unknown> | undefined;
      if (food) {
        const portions = ctx.db
          .prepare('SELECT * FROM portion WHERE food_id = ? AND deleted = 0 ORDER BY grams')
          .all(food.id) as Record<string, unknown>[];
        return {
          status: 'known' as const,
          food: decodeRow(TABLE_SPECS.food, food),
          portions: portions.map((p) => decodeRow(TABLE_SPECS.portion, p)),
        };
      }
      try {
        const product = await ctx.deps.off.lookup(code);
        if (!product) return { status: 'not_found' as const, code };
        return { status: 'draft' as const, draft: normalizeOffProduct(product, code) };
      } catch (error) {
        if (error instanceof OffUnavailableError) {
          request.log.warn({ err: error, code }, 'Open Food Facts lookup failed');
          return { status: 'unavailable' as const, code, message: error.message };
        }
        throw error;
      }
    },
  );
}
