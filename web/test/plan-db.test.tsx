import type { PlanEntryData, PlanItemData } from '@carbbook/core';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { usePlanData } from '../src/app/hooks';
import { ServicesProvider } from '../src/app/services';
import { SYNC_TABLES } from '../src/db/db';
import { createStore } from '../src/db/store';
import { applyCopy } from '../src/plan/copy';
import { removeSlot, saveSlot } from '../src/plan/saveSlot';
import { pushOutbox } from '../src/sync/push';
import { FakeApi, openTestDb } from './helpers';
import { makeServices } from './render';

let db = openTestDb();
afterEach(async () => {
  await db.delete();
});

const entry: PlanEntryData = {
  id: 'plan-1',
  date: '2026-09-16',
  window_name: 'Lunch',
  status: 'planned',
  note: null,
  log_entry_id: null,
};

const item: PlanItemData = {
  id: 'plan-item-1',
  plan_entry_id: 'plan-1',
  ref_type: 'food',
  ref_id: 'tortilla',
  amount: 1.5,
  unit: 'g',
  position: 0,
};

describe('plan tables', () => {
  it('lists both plan tables as synced tables', () => {
    expect(SYNC_TABLES).toContain('plan_entry');
    expect(SYNC_TABLES).toContain('plan_item');
  });

  it('stores, indexes and pushes plan records like any other synced record', async () => {
    db = openTestDb();
    const store = createStore(db, 'device-test', { now: () => 1000 });
    await store.saveMany([
      { table: 'plan_entry', data: entry },
      { table: 'plan_item', data: item },
    ]);

    expect(await db.plan_entry.where('date').equals('2026-09-16').count()).toBe(1);
    expect(await db.plan_item.where('plan_entry_id').equals('plan-1').count()).toBe(1);
    expect(await db.outbox.count()).toBe(2);

    const api = new FakeApi().on('POST', '/api/sync/push', (body) => ({
      results: (body as { changes: unknown[] }).changes.map((_, i) => ({ status: 'accepted', server_seq: i + 1 })),
    }));
    const summary = await pushOutbox(db, api, () => 2000);
    expect(summary.accepted).toBe(2);
    expect(await db.outbox.count()).toBe(0);
    const pushed = api.calls.at(-1)!.body as { changes: { table: string }[] };
    expect(pushed.changes.map((c) => c.table).sort()).toEqual(['plan_entry', 'plan_item']);
  });

  it('indexes log_entry_id so a deleted log entry can find its slot', async () => {
    db = openTestDb();
    const store = createStore(db, 'device-test', { now: () => 1000 });
    await store.save('plan_entry', { ...entry, status: 'logged', log_entry_id: 'log-9' });
    expect(await db.plan_entry.where('log_entry_id').equals('log-9').count()).toBe(1);
  });
});

describe('usePlanData', () => {
  it('returns only live plan entries and items', async () => {
    const services = makeServices();
    db = services.db;
    await db.plan_entry.bulkPut([
      { ...entry, updated_at: 1, updated_by: 'x', deleted: 0 },
      { ...entry, id: 'plan-2', updated_at: 1, updated_by: 'x', deleted: 1 },
    ]);
    await db.plan_item.put({ ...item, updated_at: 1, updated_by: 'x', deleted: 0 });

    const { result } = renderHook(() => usePlanData(), {
      wrapper: ({ children }) => <ServicesProvider services={services}>{children}</ServicesProvider>,
    });
    await waitFor(() => expect(result.current).toBeDefined());
    expect(result.current!.entries.map((e) => e.id)).toEqual(['plan-1']);
    expect(result.current!.items.map((i) => i.id)).toEqual(['plan-item-1']);
  });
});

describe('saveSlot', () => {
  it('writes the entry and its items with positions, and removes dropped items', async () => {
    const services = makeServices();
    db = services.db;
    await saveSlot(services.store, entry, [
      { key: 'a', ref_type: 'food', ref_id: 'tortilla', amount: '1 1/2', unit: 'g' },
      { key: 'b', ref_type: 'food', ref_id: 'tortilla', amount: '2', unit: 'g' },
    ]);
    const saved = (await db.plan_item.toArray()).sort((x, y) => x.position - y.position);
    expect(saved.map((i) => [i.id, i.amount, i.position])).toEqual([
      ['a', 1.5, 0],
      ['b', 2, 1],
    ]);

    await saveSlot(services.store, entry, [{ key: 'b', ref_type: 'food', ref_id: 'tortilla', amount: '2', unit: 'g' }], ['a']);
    expect((await db.plan_item.get('a'))!.deleted).toBe(1);
    expect((await db.plan_item.get('b'))!.position).toBe(0);
  });
});

describe('removeSlot', () => {
  it('soft-deletes the entry and every one of its items', async () => {
    const services = makeServices();
    db = services.db;
    await saveSlot(services.store, entry, [{ key: 'a', ref_type: 'food', ref_id: 'tortilla', amount: '1', unit: 'g' }]);
    await removeSlot(services.store, 'plan-1', ['a']);
    expect((await db.plan_entry.get('plan-1'))!.deleted).toBe(1);
    expect((await db.plan_item.get('a'))!.deleted).toBe(1);
  });
});

describe('applyCopy atomicity', () => {
  it('leaves the week unchanged when a soft-delete fails mid-operation, instead of leaving both old and new slots live', async () => {
    const services = makeServices();
    db = services.db;
    await saveSlot(services.store, entry, [{ key: 'a', ref_type: 'food', ref_id: 'tortilla', amount: '1', unit: 'g' }]);

    // Simulate a `replace` copy: create a new entry/item for the target day and remove the old
    // ones, but make the removal of the old entry fail partway through.
    const planEntryTable = db.table('plan_entry');
    const origPut = planEntryTable.put.bind(planEntryTable);
    const putSpy = vi.spyOn(planEntryTable, 'put').mockImplementation((async (record: PlanEntryData) => {
      if (record.id === 'plan-1') throw new Error('forced failure');
      return origPut(record);
    }) as typeof planEntryTable.put);

    await expect(
      applyCopy(services.store, {
        changes: [
          { table: 'plan_entry', data: { ...entry, id: 'plan-new' } },
          { table: 'plan_item', data: { ...item, id: 'item-new', plan_entry_id: 'plan-new' } },
        ],
        removed: [
          { table: 'plan_item', id: 'a' },
          { table: 'plan_entry', id: 'plan-1' },
        ],
      }),
    ).rejects.toThrow();
    putSpy.mockRestore();

    // Nothing committed: no new live slot, and the old one is still live (not doubled, not lost).
    expect(await db.plan_entry.get('plan-new')).toBeUndefined();
    expect(await db.plan_item.get('item-new')).toBeUndefined();
    expect((await db.plan_entry.get('plan-1'))!.deleted).toBe(0);
    expect((await db.plan_item.get('a'))!.deleted).toBe(0);
  });
});
