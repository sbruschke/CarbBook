import { afterEach, describe, expect, it } from 'vitest';
import type { CarbBookDb } from '../src/db/db';
import { syncOnce } from '../src/sync/sync';
import { FakeApi, openTestDb } from './helpers';

let db: CarbBookDb;
afterEach(async () => {
  await db.delete();
});

const emptyApi = () =>
  new FakeApi()
    .on('POST', '/api/sync/push', () => ({ results: [], server_seq: 0 }))
    .on('GET', '/api/sync/pull', () => ({ changes: [], next_since: 0, has_more: false }));

describe('syncOnce locking', () => {
  it('serializes concurrent calls with the in-memory fallback when navigator.locks is unavailable', async () => {
    db = openTestDb();
    const order: string[] = [];
    const api = emptyApi();
    const original = api.get.bind(api);
    let calls = 0;
    api.get = async <T>(path: string): Promise<T> => {
      calls++;
      order.push(`start-${calls}`);
      const result = await original<T>(path);
      order.push(`end-${calls}`);
      return result;
    };
    await Promise.all([syncOnce(db, api), syncOnce(db, api)]);
    expect(order).toEqual(['start-1', 'end-1', 'start-2', 'end-2']);
  });

  it('uses navigator.locks.request when available', async () => {
    db = openTestDb();
    const requested: string[] = [];
    const fakeLocks = {
      request: async (name: string, fn: () => Promise<unknown>) => {
        requested.push(name);
        return fn();
      },
    };
    const original = (globalThis as { navigator?: unknown }).navigator;
    Object.defineProperty(globalThis, 'navigator', {
      value: { ...(original as object), locks: fakeLocks },
      configurable: true,
    });
    try {
      await syncOnce(db, emptyApi());
      expect(requested).toEqual(['carbbook-sync']);
    } finally {
      Object.defineProperty(globalThis, 'navigator', { value: original, configurable: true });
    }
  });
});
