import type { PlanEntryData, PlanItemData, Synced } from '@carbbook/core';
import { describe, expect, it } from 'vitest';
import { conflictDates, copyChanges } from '../src/plan/copy';
import { synced } from './helpers';

const entry = (id: string, date: string, windowName: string, fields: Partial<PlanEntryData> = {}): Synced<PlanEntryData> =>
  synced({ id, date, window_name: windowName, status: 'planned', note: null, log_entry_id: null, ...fields });

const item = (id: string, entryId: string, position: number): Synced<PlanItemData> =>
  synced({ id, plan_entry_id: entryId, ref_type: 'food', ref_id: 'tortilla', amount: 100, unit: 'g', position });

let counter = 0;
const newId = () => `new-${++counter}`;

describe('conflictDates', () => {
  it('lists target dates that already have a live entry', () => {
    const entries = [entry('a', '2026-09-17', 'Lunch')];
    expect(conflictDates(entries, ['2026-09-16', '2026-09-17'])).toEqual(['2026-09-17']);
  });
});

describe('copyChanges', () => {
  const source = [entry('src', '2026-09-16', 'Lunch', { status: 'logged', log_entry_id: 'log-1', note: 'big one' })];
  const sourceItems = [item('si1', 'src', 0), item('si2', 'src', 1)];

  it('copies into an empty target as planned, with fresh ids and no log link', () => {
    counter = 0;
    const result = copyChanges({
      pairs: [{ from: '2026-09-16', to: '2026-09-17' }],
      entries: source,
      items: sourceItems,
      mode: 'skip',
      newId,
    });
    expect(result.removed).toEqual([]);
    const entries = result.changes.filter((c) => c.table === 'plan_entry').map((c) => c.data);
    expect(entries).toEqual([
      { id: 'new-1', date: '2026-09-17', window_name: 'Lunch', status: 'planned', note: 'big one', log_entry_id: null },
    ]);
    const items = result.changes.filter((c) => c.table === 'plan_item').map((c) => c.data);
    expect(items.map((i) => [i.id, i.plan_entry_id, i.position])).toEqual([
      ['new-2', 'new-1', 0],
      ['new-3', 'new-1', 1],
    ]);
  });

  it('skips a day that already has entries', () => {
    counter = 0;
    const result = copyChanges({
      pairs: [{ from: '2026-09-16', to: '2026-09-17' }],
      entries: [...source, entry('tgt', '2026-09-17', 'Dinner')],
      items: sourceItems,
      mode: 'skip',
      newId,
    });
    expect(result.changes).toEqual([]);
    expect(result.removed).toEqual([]);
  });

  it('replace deletes every live entry and item of the target day first', () => {
    counter = 0;
    const result = copyChanges({
      pairs: [{ from: '2026-09-16', to: '2026-09-17' }],
      entries: [...source, entry('tgt', '2026-09-17', 'Dinner')],
      items: [...sourceItems, item('ti1', 'tgt', 0)],
      mode: 'replace',
      newId,
    });
    expect(result.removed).toEqual([
      { table: 'plan_item', id: 'ti1' },
      { table: 'plan_entry', id: 'tgt' },
    ]);
    expect(result.changes.filter((c) => c.table === 'plan_entry')).toHaveLength(1);
  });

  it('merge appends into a matching window and leaves other windows alone', () => {
    counter = 0;
    const result = copyChanges({
      pairs: [{ from: '2026-09-16', to: '2026-09-17' }],
      entries: [...source, entry('tgt', '2026-09-17', 'Lunch'), entry('other', '2026-09-17', 'Dinner')],
      items: [...sourceItems, item('ti1', 'tgt', 0)],
      mode: 'merge',
      newId,
    });
    expect(result.removed).toEqual([]);
    // No new plan_entry: the existing Lunch slot absorbed the items.
    expect(result.changes.filter((c) => c.table === 'plan_entry')).toEqual([]);
    const items = result.changes.filter((c) => c.table === 'plan_item').map((c) => c.data);
    expect(items.map((i) => [i.plan_entry_id, i.position])).toEqual([
      ['tgt', 1],
      ['tgt', 2],
    ]);
  });

  it('merge creates the slot when the target day has no entry for that window', () => {
    counter = 0;
    const result = copyChanges({
      pairs: [{ from: '2026-09-16', to: '2026-09-17' }],
      entries: [...source, entry('other', '2026-09-17', 'Dinner')],
      items: sourceItems,
      mode: 'merge',
      newId,
    });
    expect(result.changes.filter((c) => c.table === 'plan_entry').map((c) => c.data.window_name)).toEqual(['Lunch']);
  });

  it('copies a whole week, one pair per day', () => {
    counter = 0;
    const result = copyChanges({
      pairs: [
        { from: '2026-09-14', to: '2026-09-21' },
        { from: '2026-09-16', to: '2026-09-23' },
      ],
      entries: [entry('a', '2026-09-14', 'Lunch'), entry('b', '2026-09-16', 'Dinner')],
      items: [],
      mode: 'skip',
      newId,
    });
    // `Change` is a discriminated union keyed by `table`; every change here is a plan_entry (no
    // items were given), but TS can't narrow that from the runtime data alone.
    expect(result.changes.map((c) => (c.data as { date: string }).date)).toEqual(['2026-09-21', '2026-09-23']);
  });

  it('skips a same-date pair instead of duplicating that day\'s items into itself', () => {
    counter = 0;
    const result = copyChanges({
      pairs: [{ from: '2026-09-16', to: '2026-09-16' }],
      entries: source,
      items: sourceItems,
      mode: 'merge',
      newId,
    });
    expect(result.changes).toEqual([]);
    expect(result.removed).toEqual([]);
  });

  it('ignores deleted source entries and items', () => {
    counter = 0;
    const result = copyChanges({
      pairs: [{ from: '2026-09-16', to: '2026-09-17' }],
      entries: [synced(entry('src', '2026-09-16', 'Lunch'), { deleted: 1 })],
      items: [synced(item('si1', 'src', 0), { deleted: 1 })],
      mode: 'skip',
      newId,
    });
    expect(result.changes).toEqual([]);
  });

  it('copies a quick carbs row with its label and re-points ref_id at the new row', () => {
    counter = 0;
    const quick = synced<PlanItemData>({ id: 'q1', plan_entry_id: 'src', ref_type: 'quick', ref_id: 'q1', amount: 7, unit: 'carbs', position: 2, label: 'Ranch & salad' });
    const result = copyChanges({
      pairs: [{ from: '2026-09-16', to: '2026-09-17' }],
      entries: source,
      items: [...sourceItems, quick],
      mode: 'skip',
      newId,
    });
    const items = result.changes.filter((c) => c.table === 'plan_item').map((c) => c.data as PlanItemData);
    expect(items.find((i) => i.ref_type === 'quick')).toEqual({
      id: 'new-4', plan_entry_id: 'new-1', ref_type: 'quick', ref_id: 'new-4', amount: 7, unit: 'carbs', position: 2, label: 'Ranch & salad',
    });
    expect(items.filter((i) => i.ref_type === 'food').map((i) => [i.ref_id, i.label])).toEqual([
      ['tortilla', null],
      ['tortilla', null],
    ]);
  });
});
