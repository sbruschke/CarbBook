import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { search } from '../search/search';

export async function searchRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get<{ Querystring: { q: string; limit: number } }>(
    '/api/search',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['q'],
          properties: {
            q: { type: 'string', maxLength: 200 },
            limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
          },
        },
      },
    },
    async (request) => ({ results: search(ctx.db, request.query.q, request.query.limit) }),
  );
}
