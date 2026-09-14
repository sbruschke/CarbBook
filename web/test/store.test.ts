import { afterEach, describe, expect, it } from 'vitest';
import type { CarbBookDb } from '../src/db/db';
import { getDeviceId } from '../src/db/meta';
import { createStore } from '../src/db/store';
import { foodData, mealData, mealItemData, openTestDb, synced } from './helpers';

let db: CarbBookDb;
afterEach(async () => {
  await db.delete();
});

describe('createStore', () => {
  it('stamps sync metadata, queues the record and reports the write', async () => {
    db = openTestDb();
    let writes = 0;
    const store = createStore(db, 'device-a', { now: () => 5000, onWrite: () => writes++ });
    const saved = await store.save('food', foodData({ id: 'f1' }));
    expect(saved).toEqual({ ...foodData({ id: 'f1' }), updated_at: 5000, updated_by: 'device-a', deleted: 0 });
    expect(await db.food.get('f1')).toEqual(saved);
    expect(await db.outbox.toArray()).toEqual([{ key: 'food:f1', table: 'food', id: 'f1', updated_at: 5000, snapshot: null }]);
    expect(writes).toBe(1);
  });

  it('bumps updated_at past the stored version when the clock is behind, keeping server_seq', async () => {
    db = openTestDb();
    await db.food.put(synced(foodData({ id: 'f1' }), { updated_at: 9000, server_seq: 7 }));
    const store = createStore(db, 'device-a', { now: () => 5000 });
    const saved = await store.save('food', foodData({ id: 'f1', name: 'Wrap' }));
    expect(saved).toMatchObject({ name: 'Wrap', updated_at: 9001, updated_by: 'device-a', server_seq: 7 });
  });

  it('saves several records in one transaction and reports one write', async () => {
    db = openTestDb();
    let writes = 0;
    const store = createStore(db, 'device-a', { now: () => 10, onWrite: () => writes++ });
    await store.saveMany([
      { table: 'meal', data: mealData({ id: 'm1' }) },
      { table: 'meal_item', data: mealItemData({ id: 'i1', meal_id: 'm1' }) },
    ]);
    expect(await db.meal.get('m1')).toMatchObject({ name: 'Tacos', updated_at: 10 });
    expect(await db.meal_item.get('i1')).toMatchObject({ meal_id: 'm1', updated_at: 10 });
    expect((await db.outbox.toArray()).map((row) => row.key)).toEqual(['meal:m1', 'meal_item:i1']);
    expect(writes).toBe(1);
  });

  it('soft-deletes and ignores unknown ids', async () => {
    db = openTestDb();
    let clock = 100;
    const store = createStore(db, 'device-a', { now: () => clock });
    await store.save('food', foodData({ id: 'f1' }));
    clock = 200;
    await store.remove('food', 'f1');
    await store.remove('food', 'missing');
    expect(await db.food.get('f1')).toMatchObject({ name: 'Tortilla', deleted: 1, updated_at: 200 });
    expect(await db.food.get('missing')).toBeUndefined();
    expect(await db.outbox.toArray()).toEqual([{ key: 'food:f1', table: 'food', id: 'f1', updated_at: 200, snapshot: null }]);
  });
});

describe('getDeviceId', () => {
  it('creates the id once and reuses it', async () => {
    db = openTestDb();
    expect(await getDeviceId(db, () => 'dev-1')).toBe('dev-1');
    expect(await getDeviceId(db, () => 'dev-2')).toBe('dev-1');
  });
});
