import { afterEach, describe, expect, it } from 'vitest';
import type { CarbBookDb } from '../src/db/db';
import { getMeta } from '../src/db/meta';
import { createStore } from '../src/db/store';
import { NetworkError } from '../src/lib/api';
import type { PullPage, PushResponse } from '../src/lib/wire';
import { pullAll } from '../src/sync/pull';
import { syncOnce } from '../src/sync/sync';
import { FakeApi, foodData, mealData, openTestDb, synced } from './helpers';

let db: CarbBookDb;
afterEach(async () => {
  await db.delete();
});

const sinceOf = (path: string) => Number(new URL(path, 'http://x').searchParams.get('since'));

describe('pullAll', () => {
  it('applies pages until drained and stores the cursor', async () => {
    db = openTestDb();
    const pages: Record<number, PullPage> = {
      0: {
        changes: [
          { table: 'food', record: synced(foodData({ id: 'f1' }), { server_seq: 4 }) },
          { table: 'meal', record: synced(mealData({ id: 'm1' }), { server_seq: 5 }) },
        ],
        next_since: 5,
        has_more: true,
      },
      5: {
        changes: [{ table: 'food', record: synced(foodData({ id: 'f1' }), { updated_at: 2000, deleted: 1, server_seq: 6 }) }],
        next_since: 6,
        has_more: false,
      },
    };
    const api = new FakeApi().on('GET', '/api/sync/pull', (_body, path) => pages[sinceOf(path)]);

    expect(await pullAll(db, api, 2)).toEqual({ applied: 3, pages: 2 });
    expect(api.calls.map((c) => c.path)).toEqual(['/api/sync/pull?since=0&limit=2', '/api/sync/pull?since=5&limit=2']);
    expect(await db.food.get('f1')).toMatchObject({ deleted: 1, server_seq: 6 });
    expect(await db.meal.get('m1')).toMatchObject({ name: 'Tacos' });
    expect(await getMeta(db, 'last_pull_seq')).toBe(6);
  });

  it('keeps a pending local edit that is newer than the pulled record', async () => {
    db = openTestDb();
    await createStore(db, 'device-a', { now: () => 5000 }).save('food', foodData({ id: 'f1', name: 'Local' }));
    const api = new FakeApi().on('GET', '/api/sync/pull', () => ({
      changes: [{ table: 'food', record: synced(foodData({ id: 'f1', name: 'Server' }), { updated_at: 4000, server_seq: 4 }) }],
      next_since: 4,
      has_more: false,
    }));
    await pullAll(db, api);
    expect((await db.food.get('f1'))?.name).toBe('Local');
    expect(await db.outbox.count()).toBe(1);
  });

  it('lets a newer server record replace an older pending edit', async () => {
    db = openTestDb();
    await createStore(db, 'device-a', { now: () => 5000 }).save('food', foodData({ id: 'f1', name: 'Local' }));
    const api = new FakeApi().on('GET', '/api/sync/pull', () => ({
      changes: [{ table: 'food', record: synced(foodData({ id: 'f1', name: 'Server' }), { updated_at: 6000, server_seq: 4 }) }],
      next_since: 4,
      has_more: false,
    }));
    await pullAll(db, api);
    expect((await db.food.get('f1'))?.name).toBe('Server');
    expect(await db.outbox.count()).toBe(0);
  });

  it('skips unknown tables but still advances the cursor', async () => {
    db = openTestDb();
    const api = new FakeApi().on('GET', '/api/sync/pull', () => ({
      changes: [{ table: 'user', record: { id: 'u1', updated_at: 1, updated_by: 'x', deleted: 0, server_seq: 9 } }],
      next_since: 9,
      has_more: false,
    }));
    expect(await pullAll(db, api)).toEqual({ applied: 0, pages: 1 });
    expect(await getMeta(db, 'last_pull_seq')).toBe(9);
  });

  it('keeps applied pages when a later page fails, and resumes from there', async () => {
    db = openTestDb();
    const api = new FakeApi().on('GET', '/api/sync/pull', (_body, path) => {
      if (sinceOf(path) === 0) {
        return { changes: [{ table: 'food', record: synced(foodData({ id: 'f1' }), { server_seq: 5 }) }], next_since: 5, has_more: true };
      }
      throw new NetworkError('Failed to fetch');
    });
    await expect(pullAll(db, api)).rejects.toThrow(NetworkError);
    expect(await db.food.get('f1')).toBeDefined();
    expect(await getMeta(db, 'last_pull_seq')).toBe(5);
  });
});

describe('syncOnce', () => {
  it('pushes before pulling and records the sync time', async () => {
    db = openTestDb();
    await createStore(db, 'device-a', { now: () => 1000 }).save('food', foodData({ id: 'f1' }));
    const api = new FakeApi()
      .on('POST', '/api/sync/push', (): PushResponse => ({ results: [{ table: 'food', id: 'f1', status: 'accepted', server_seq: 4 }], server_seq: 4 }))
      .on('GET', '/api/sync/pull', (): PullPage => ({
        changes: [{ table: 'food', record: synced(foodData({ id: 'f1' }), { updated_at: 1000, updated_by: 'device-a', server_seq: 4 }) }],
        next_since: 4,
        has_more: false,
      }));

    await syncOnce(db, api, () => 9999);
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /api/sync/push', 'GET /api/sync/pull?since=0&limit=500']);
    expect(await getMeta(db, 'last_synced_at')).toBe(9999);
    expect(await db.outbox.count()).toBe(0);
  });
});
