import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/plugin';
import type { AppContext } from '../context';
import { currentServerSeq } from '../db';
import { pullChanges } from '../sync/pull';
import { applyPush, type PushChange } from '../sync/push';

export const MAX_PUSH_CHANGES = 500;
export const DEFAULT_PULL_LIMIT = 500;
export const MAX_PULL_LIMIT = 1000;

export async function syncRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.post<{ Body: { changes: PushChange[] } }>(
    '/api/sync/push',
    {
      schema: {
        body: {
          type: 'object',
          required: ['changes'],
          properties: {
            changes: {
              type: 'array',
              maxItems: MAX_PUSH_CHANGES,
              items: { type: 'object', required: ['table', 'record'], properties: { table: { type: 'string' } } },
            },
          },
        },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      const results = applyPush(ctx.db, auth.user.role, request.body.changes);
      return { results, server_seq: currentServerSeq(ctx.db) };
    },
  );

  app.get<{ Querystring: { since: number; limit: number } }>(
    '/api/sync/pull',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            since: { type: 'integer', minimum: 0, default: 0 },
            limit: { type: 'integer', minimum: 1, maximum: MAX_PULL_LIMIT, default: DEFAULT_PULL_LIMIT },
          },
        },
      },
    },
    async (request) => pullChanges(ctx.db, request.query.since, request.query.limit),
  );
}
