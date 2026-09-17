import type { DoseWindow, PlanEntryData, PlanItemData, Synced } from '@carbbook/core';
import { describe, expect, it } from 'vitest';
import { buildCatalog } from '../src/db/catalog';
import { buildSlots, dayCarbs, dayTotalText, slotKey, windowsFor } from '../src/plan/slots';
import { foodData, synced } from './helpers';
import { SEED_SETTINGS } from './render';

const WINDOWS: DoseWindow[] = [
  { name: 'Breakfast', start: '05:00', ratio_g_per_unit: 8, carb_goal: { min: 30, max: 50 } },
  { name: 'Lunch', start: '11:00', ratio_g_per_unit: 8, carb_goal: { min: 50, max: 80 } },
  { name: 'HS Snack', start: '19:30', ratio_g_per_unit: 12, carb_goal: null },
];

const catalog = buildCatalog({
  foods: [synced(foodData({ id: 'tortilla', name: 'Tortilla', carbs_per_100g: 48 }))],
  portions: [],
  meals: [],
  meal_items: [],
});

const entry = (fields: Partial<PlanEntryData>): Synced<PlanEntryData> =>
  synced({ id: 'p1', date: '2026-09-16', window_name: 'Lunch', status: 'planned', note: null, log_entry_id: null, ...fields });

const item = (fields: Partial<PlanItemData>): Synced<PlanItemData> =>
  synced({ id: 'i1', plan_entry_id: 'p1', ref_type: 'food', ref_id: 'tortilla', amount: 100, unit: 'g', position: 0, ...fields });

describe('buildSlots', () => {
  it('produces one slot per date × window, in window order, empty where nothing is planned', () => {
    const slots = buildSlots({ dates: ['2026-09-16'], windows: WINDOWS, entries: [], items: [], catalog });
    expect(slots.map((s) => s.windowName)).toEqual(['Breakfast', 'Lunch', 'HS Snack']);
    expect(slots.every((s) => s.entry === null && s.items.length === 0)).toBe(true);
    expect(slots[0]!.key).toBe(slotKey('2026-09-16', 'Breakfast'));
  });

  it('fills a slot with its live items in position order and core carbs', () => {
    const slots = buildSlots({
      dates: ['2026-09-16'],
      windows: WINDOWS,
      entries: [entry({})],
      items: [item({ id: 'i2', position: 1, amount: 50 }), item({ id: 'i1', position: 0, amount: 100 })],
      catalog,
    });
    const lunch = slots.find((s) => s.windowName === 'Lunch')!;
    expect(lunch.items.map((i) => i.id)).toEqual(['i1', 'i2']);
    expect(lunch.carbs).toEqual({ carbs_g: 72, complete: true });
    expect(lunch.goal).toEqual({ min: 50, max: 80 });
    expect(lunch.entry!.status).toBe('planned');
  });

  it('ignores deleted entries and deleted items', () => {
    const slots = buildSlots({
      dates: ['2026-09-16'],
      windows: WINDOWS,
      entries: [entry({ id: 'gone' }), synced(entry({}), { deleted: 1 })],
      items: [synced(item({ plan_entry_id: 'gone' }), { deleted: 1 })],
      catalog,
    });
    const lunch = slots.find((s) => s.windowName === 'Lunch')!;
    expect(lunch.entry!.id).toBe('gone');
    expect(lunch.items).toEqual([]);
    expect(lunch.carbs).toEqual({ carbs_g: 0, complete: true });
  });

  it('marks a slot incomplete when an item points at a food that has not synced yet', () => {
    const slots = buildSlots({
      dates: ['2026-09-16'],
      windows: WINDOWS,
      entries: [entry({})],
      items: [item({ ref_id: 'not-here-yet' })],
      catalog,
    });
    expect(slots.find((s) => s.windowName === 'Lunch')!.carbs.complete).toBe(false);
  });
});

describe('windowsFor', () => {
  it('uses the dose-settings version active at local noon of that date', () => {
    const versions = [synced(SEED_SETTINGS)];
    expect(windowsFor(versions, '2026-09-16').map((w) => w.name)).toEqual(SEED_SETTINGS.windows.map((w) => w.name));
  });

  it('returns no windows when no version is effective yet', () => {
    const future = synced({ ...SEED_SETTINGS, id: 'later', effective_from: new Date(2030, 0, 1).getTime() });
    expect(windowsFor([future], '2026-09-16')).toEqual([]);
  });
});

describe('dayCarbs / dayTotalText (quick-carbs spec §3: no day goal)', () => {
  it('sums the slots carbs', () => {
    const slots = buildSlots({ dates: ['2026-09-16'], windows: WINDOWS, entries: [entry({})], items: [item({})], catalog });
    expect(dayCarbs(slots)).toEqual({ carbs_g: 48, complete: true });
  });

  it('counts quick carbs rows', () => {
    const slots = buildSlots({
      dates: ['2026-09-16'],
      windows: WINDOWS,
      entries: [entry({})],
      items: [item({}), item({ id: 'q1', ref_type: 'quick', ref_id: 'q1', amount: 7, unit: 'carbs', position: 1, label: 'Salsa' })],
      catalog,
    });
    expect(dayCarbs(slots)).toEqual({ carbs_g: 55, complete: true });
  });

  it('is incomplete when any slot in the day is incomplete', () => {
    const slots = buildSlots({
      dates: ['2026-09-16'],
      windows: WINDOWS,
      entries: [entry({})],
      items: [item({ ref_id: 'not-here-yet' })],
      catalog,
    });
    expect(dayCarbs(slots).complete).toBe(false);
  });

  it('formats plain grams, or "missing data"', () => {
    expect(dayTotalText({ carbs_g: 72, complete: true })).toBe('72 g');
    expect(dayTotalText({ carbs_g: 80.4167, complete: true })).toBe('80.4 g');
    expect(dayTotalText({ carbs_g: 12, complete: false })).toBe('missing data');
  });
});

describe('slotKey normalization (server matches window_name case-insensitively, trimmed)', () => {
  it('finds an existing entry when the window name differs only by case or whitespace', () => {
    const slots = buildSlots({
      dates: ['2026-09-16'],
      windows: WINDOWS,
      entries: [entry({ window_name: ' lunch ' })],
      items: [item({})],
      catalog,
    });
    const lunch = slots.find((s) => s.windowName === 'Lunch')!;
    expect(lunch.entry).not.toBeNull();
    expect(lunch.items).toHaveLength(1);
  });

  it('treats differently-cased window names as the same slot key', () => {
    expect(slotKey('2026-09-16', 'Lunch')).toBe(slotKey('2026-09-16', ' lunch '));
  });
});
