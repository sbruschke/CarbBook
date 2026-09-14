import { afterEach, describe, expect, it } from 'vitest';
import type { CarbBookDb } from '../src/db/db';
import { createStore } from '../src/db/store';
import { NetworkError } from '../src/lib/api';
import type { PushResponse } from '../src/lib/wire';
import { pushOutbox } from '../src/sync/push';
import { doseSettingsData, FakeApi, foodData, mealData, openTestDb } from './helpers';

type PushBody = { changes: { table: string; record: { id: string } }[] };

let db: CarbBookDb;
afterEach(async () => {
  await db.delete();
});

const acceptAll =
  (firstSeq: number) =>
  (body: unknown): PushResponse => ({
    results: (body as PushBody).changes.map((c, i) => ({ table: c.table, id: c.record.id, status: 'accepted', server_seq: firstSeq + i })),
    server_seq: firstSeq + (body as PushBody).changes.length - 1,
  });

describe('pushOutbox', () => {
  it('pushes queued records, stores server_seq and clears the outbox', async () => {
    db = openTestDb();
    const store = createStore(db, 'device-a', { now: () => 1000 });
    await store.save('food', foodData({ id: 'f1' }));
    await store.save('meal', mealData({ id: 'm1' }));
    const api = new FakeApi().on('POST', '/api/sync/push', acceptAll(10));

    expect(await pushOutbox(db, api)).toEqual({ sent: 2, accepted: 2, ignored: 0, rejected: 0 });
    expect(api.calls[0]!.body).toEqual({
      changes: [
        { table: 'food', record: { ...foodData({ id: 'f1' }), updated_at: 1000, updated_by: 'device-a', deleted: 0 } },
        { table: 'meal', record: { ...mealData({ id: 'm1' }), updated_at: 1000, updated_by: 'device-a', deleted: 0 } },
      ],
    });
    expect((await db.food.get('f1'))?.server_seq).toBe(10);
    expect((await db.meal.get('m1'))?.server_seq).toBe(11);
    expect(await db.outbox.count()).toBe(0);
  });

  it('keeps the outbox entry when the record is edited during the push', async () => {
    db = openTestDb();
    let clock = 1000;
    const store = createStore(db, 'device-a', { now: () => clock });
    await store.save('food', foodData({ id: 'f1' }));
    const api = new FakeApi().on('POST', '/api/sync/push', async (body) => {
      clock = 2000;
      await store.save('food', foodData({ id: 'f1', name: 'Edited' }));
      return acceptAll(4)(body);
    });

    await pushOutbox(db, api);
    expect(await db.outbox.toArray()).toEqual([
      { key: 'food:f1', table: 'food', id: 'f1', updated_at: 2000, snapshot: null, ownerId: null, ownerUsername: null },
    ]);
    expect(await db.food.get('f1')).toMatchObject({ name: 'Edited', updated_at: 2000 });
    expect((await db.food.get('f1'))?.server_seq).toBeUndefined();
  });

  it('records rejections as sync errors without retrying, and clears them once accepted', async () => {
    db = openTestDb();
    let clock = 1000;
    const store = createStore(db, 'device-a', { now: () => clock });
    await store.save('food', foodData({ id: 'f1', carbs_per_100g: 48 }));
    const api = new FakeApi().on('POST', '/api/sync/push', () => ({
      results: [{ table: 'food', id: 'f1', status: 'rejected', reason: 'invalid', message: 'carbs_per_100g must be >= 0' }],
      server_seq: 3,
    }));

    expect(await pushOutbox(db, api, () => 7000)).toEqual({ sent: 1, accepted: 0, ignored: 0, rejected: 1 });
    expect(await db.sync_error.toArray()).toEqual([
      {
        key: 'food:f1',
        table: 'food',
        id: 'f1',
        reason: 'invalid',
        message: 'carbs_per_100g must be >= 0',
        at: 7000,
        rejectedUpdatedAt: 1000,
        resolved: false,
      },
    ]);
    expect(await db.outbox.count()).toBe(0);

    clock = 8000;
    await store.save('food', foodData({ id: 'f1', carbs_per_100g: 50 }));
    api.on('POST', '/api/sync/push', acceptAll(4));
    await pushOutbox(db, api);
    expect(await db.sync_error.count()).toBe(0);
  });

  it('drops ignored records from the outbox (the pull brings the winner)', async () => {
    db = openTestDb();
    const store = createStore(db, 'device-a', { now: () => 1000 });
    await store.save('food', foodData({ id: 'f1' }));
    const api = new FakeApi().on('POST', '/api/sync/push', () => ({
      results: [{ table: 'food', id: 'f1', status: 'ignored', server_seq: 9 }],
      server_seq: 9,
    }));
    expect(await pushOutbox(db, api)).toEqual({ sent: 1, accepted: 0, ignored: 1, rejected: 0 });
    expect(await db.outbox.count()).toBe(0);
    expect((await db.food.get('f1'))?.server_seq).toBeUndefined();
  });

  it('sends nothing when the outbox is empty', async () => {
    db = openTestDb();
    const api = new FakeApi();
    expect(await pushOutbox(db, api)).toEqual({ sent: 0, accepted: 0, ignored: 0, rejected: 0 });
    expect(api.calls).toEqual([]);
  });

  it('keeps pending changes when the network fails', async () => {
    db = openTestDb();
    const store = createStore(db, 'device-a');
    await store.save('food', foodData({ id: 'f1' }));
    const api = new FakeApi().on('POST', '/api/sync/push', () => {
      throw new NetworkError('Failed to fetch');
    });
    await expect(pushOutbox(db, api)).rejects.toThrow(NetworkError);
    expect(await db.outbox.count()).toBe(1);
  });

  it('restores the last server-acknowledged copy when a synced edit is rejected', async () => {
    db = openTestDb();
    let clock = 1000;
    const store = createStore(db, 'device-a', { now: () => clock });
    // Synced once (accepted), so the local table holds a server-acknowledged copy.
    await store.save('food', foodData({ id: 'f1', name: 'Original' }));
    await pushOutbox(db, new FakeApi().on('POST', '/api/sync/push', acceptAll(1)));

    clock = 2000;
    await store.save('food', foodData({ id: 'f1', name: 'Bad edit' }));
    const api = new FakeApi().on('POST', '/api/sync/push', () => ({
      results: [{ table: 'food', id: 'f1', status: 'rejected', reason: 'invalid', message: 'nope' }],
      server_seq: 1,
    }));
    await pushOutbox(db, api);

    expect(await db.food.get('f1')).toMatchObject({ name: 'Original', updated_at: 1000 });
    expect(await db.outbox.count()).toBe(0);
    expect(await db.sync_error.count()).toBe(1);
  });

  it('deletes a never-synced record when its rejection is applied', async () => {
    db = openTestDb();
    const store = createStore(db, 'device-a', { now: () => 1000 });
    await store.save('food', foodData({ id: 'f1', name: 'New food' }));
    const api = new FakeApi().on('POST', '/api/sync/push', () => ({
      results: [{ table: 'food', id: 'f1', status: 'rejected', reason: 'invalid', message: 'nope' }],
      server_seq: 0,
    }));
    await pushOutbox(db, api);

    expect(await db.food.get('f1')).toBeUndefined();
    expect(await db.outbox.count()).toBe(0);
  });

  it('keeps a newer in-flight edit queued instead of restoring over it', async () => {
    db = openTestDb();
    let clock = 1000;
    const store = createStore(db, 'device-a', { now: () => clock });
    await store.save('food', foodData({ id: 'f1', name: 'Original' }));
    const api = new FakeApi().on('POST', '/api/sync/push', async (body) => {
      clock = 2000;
      await store.save('food', foodData({ id: 'f1', name: 'Newer edit' }));
      return {
        results: (body as { changes: { table: string; record: { id: string } }[] }).changes.map((c) => ({
          table: c.table,
          id: c.record.id,
          status: 'rejected',
          reason: 'invalid',
          message: 'nope',
        })),
        server_seq: 0,
      };
    });
    await pushOutbox(db, api);

    expect((await db.food.get('f1'))?.name).toBe('Newer edit');
    expect(await db.outbox.toArray()).toEqual([
      { key: 'food:f1', table: 'food', id: 'f1', updated_at: 2000, snapshot: null, ownerId: null, ownerUsername: null },
    ]);
    // The stale rejection is neither recorded nor user-visible: the newer edit is judged on its own.
    expect(await db.sync_error.count()).toBe(0);
  });

  it('leaves the previously active dose_settings active when a new version is rejected', async () => {
    db = openTestDb();
    const store = createStore(db, 'device-a', { now: () => 1000 });
    await store.save('dose_settings', doseSettingsData({ id: 'ds-active', effective_from: 0 }));
    await pushOutbox(db, new FakeApi().on('POST', '/api/sync/push', acceptAll(1)));

    await store.save('dose_settings', doseSettingsData({ id: 'ds-new', effective_from: 500 }));
    const api = new FakeApi().on('POST', '/api/sync/push', () => ({
      results: [{ table: 'dose_settings', id: 'ds-new', status: 'rejected', reason: 'append_only', message: 'overlaps' }],
      server_seq: 1,
    }));
    await pushOutbox(db, api);

    expect(await db.dose_settings.get('ds-new')).toBeUndefined();
    expect(await db.dose_settings.get('ds-active')).toMatchObject({ id: 'ds-active' });
  });
});
