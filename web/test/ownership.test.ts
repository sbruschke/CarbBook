import { afterEach, describe, expect, it } from 'vitest';
import type { CarbBookDb } from '../src/db/db';
import { createStore } from '../src/db/store';
import { discardForeignPending, foreignPendingSummary } from '../src/sync/ownership';
import { pushOutbox } from '../src/sync/push';
import { foodData, mealData, openTestDb } from './helpers';

const brett = { id: 1, username: 'brett' };
const dana = { id: 2, username: 'dana' };

let db: CarbBookDb;
afterEach(async () => {
  await db.delete();
});

const acceptAll = (firstSeq: number) => (body: unknown) => ({
  results: (body as { changes: { table: string; record: { id: string } }[] }).changes.map((c, i) => ({
    table: c.table,
    id: c.record.id,
    status: 'accepted',
    server_seq: firstSeq + i,
  })),
  server_seq: firstSeq,
});

describe('pushOutbox ownership filtering', () => {
  it('only pushes entries owned by the current user, leaving another user’s queued changes untouched', async () => {
    db = openTestDb();
    const brettStore = createStore(db, 'device-a', { now: () => 1000, owner: brett });
    await brettStore.save('food', foodData({ id: 'f1' }));
    const danaStore = createStore(db, 'device-a', { now: () => 1000, owner: dana });
    await danaStore.save('meal', mealData({ id: 'm1' }));

    const { FakeApi } = await import('./helpers');
    const api = new FakeApi().on('POST', '/api/sync/push', acceptAll(10));

    const summary = await pushOutbox(db, api, () => 2000, dana.id);
    expect(summary).toEqual({ sent: 1, accepted: 1, ignored: 0, rejected: 0 });
    expect(api.calls[0]!.body).toMatchObject({ changes: [{ table: 'meal', record: { id: 'm1' } }] });

    // Brett's entry is still queued, untouched, and was never sent.
    const remaining = await db.outbox.toArray();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({ table: 'food', id: 'f1', ownerId: brett.id });
    expect(await db.food.get('f1')).toMatchObject({ name: 'Tortilla' });
  });

  it('reports a foreign-pending summary for the other user’s held entries', async () => {
    db = openTestDb();
    const brettStore = createStore(db, 'device-a', { now: () => 1000, owner: brett });
    await brettStore.save('food', foodData({ id: 'f1' }));
    await brettStore.save('meal', mealData({ id: 'm1' }));

    expect(await foreignPendingSummary(db, dana.id)).toEqual({ count: 2, ownerId: brett.id, ownerUsername: brett.username });
    expect(await foreignPendingSummary(db, brett.id)).toBeNull();
  });

  it('pushes the original owner’s held entries normally once they sign back in', async () => {
    db = openTestDb();
    const brettStore = createStore(db, 'device-a', { now: () => 1000, owner: brett });
    await brettStore.save('food', foodData({ id: 'f1' }));

    const { FakeApi } = await import('./helpers');
    const api = new FakeApi().on('POST', '/api/sync/push', acceptAll(5));
    // While dana is signed in, brett's entry is held.
    expect(await pushOutbox(db, api, () => 2000, dana.id)).toEqual({ sent: 0, accepted: 0, ignored: 0, rejected: 0 });
    expect(await db.outbox.count()).toBe(1);

    // Brett signs back in: their held entry now pushes.
    expect(await pushOutbox(db, api, () => 2000, brett.id)).toEqual({ sent: 1, accepted: 1, ignored: 0, rejected: 0 });
    expect(await db.outbox.count()).toBe(0);
  });

  it('discards another user’s held changes: restores snapshots and deletes never-synced rows, without recording rejections', async () => {
    db = openTestDb();
    const brettStore = createStore(db, 'device-a', { now: () => 1000, owner: brett });
    await brettStore.save('food', foodData({ id: 'f1', name: 'Original' }));
    const { FakeApi } = await import('./helpers');
    await pushOutbox(db, new FakeApi().on('POST', '/api/sync/push', acceptAll(1)), () => 1000, brett.id);
    await brettStore.save('food', foodData({ id: 'f1', name: 'Edited by brett' }));
    await brettStore.save('meal', mealData({ id: 'm1' })); // never synced

    const discarded = await discardForeignPending(db, dana.id);
    expect(discarded).toBe(2);
    expect(await db.food.get('f1')).toMatchObject({ name: 'Original' });
    expect(await db.meal.get('m1')).toBeUndefined();
    expect(await db.outbox.count()).toBe(0);
    expect(await db.sync_error.count()).toBe(0);
  });
});
