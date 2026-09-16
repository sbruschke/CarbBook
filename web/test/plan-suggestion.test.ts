import { beforeEach, describe, expect, it } from 'vitest';
import { DISMISSED_KEY, dismissSlot, loadDismissed } from '../src/plan/dismissed';

describe('dismissed slots (per device, never synced)', () => {
  beforeEach(() => localStorage.clear());

  it('starts empty', () => {
    expect(loadDismissed().size).toBe(0);
  });

  it('remembers a dismissal keyed by date and window', () => {
    dismissSlot('2026-09-16|Lunch');
    expect(loadDismissed().has('2026-09-16|Lunch')).toBe(true);
    expect(loadDismissed().has('2026-09-16|Dinner')).toBe(false);
    expect(JSON.parse(localStorage.getItem(DISMISSED_KEY)!)).toEqual(['2026-09-16|Lunch']);
  });

  it('survives corrupt storage without throwing', () => {
    localStorage.setItem(DISMISSED_KEY, 'not json');
    expect(loadDismissed().size).toBe(0);
    dismissSlot('2026-09-16|Lunch');
    expect(loadDismissed().has('2026-09-16|Lunch')).toBe(true);
  });

  it('does not throw when storage is unavailable', () => {
    const broken = {
      getItem() {
        throw new Error('blocked');
      },
      setItem() {
        throw new Error('blocked');
      },
    } as unknown as Storage;
    expect(loadDismissed(broken).size).toBe(0);
    expect(() => dismissSlot('2026-09-16|Lunch', broken)).not.toThrow();
  });
});

import type { PlanEntryData, PlanItemData, Synced } from '@carbbook/core';
import { buildCatalog } from '../src/db/catalog';
import { suggestionFor } from '../src/plan/suggestion';
import { foodData, synced } from './helpers';

const catalog = buildCatalog({
  foods: [synced(foodData({ id: 'tortilla', name: 'Tortilla', carbs_per_100g: 48 }))],
  portions: [],
  meals: [],
  meal_items: [],
});

const planned: Synced<PlanEntryData> = synced({
  id: 'p1',
  date: '2026-09-16',
  window_name: 'Lunch',
  status: 'planned',
  note: null,
  log_entry_id: null,
});

const planItem: Synced<PlanItemData> = synced({
  id: 'i1',
  plan_entry_id: 'p1',
  ref_type: 'food',
  ref_id: 'tortilla',
  amount: 150,
  unit: 'g',
  position: 0,
});

const args = (over: Partial<Parameters<typeof suggestionFor>[0]> = {}) => ({
  date: '2026-09-16',
  windowName: 'Lunch',
  entries: [planned],
  items: [planItem],
  catalog,
  dismissed: new Set<string>(),
  ...over,
});

describe('suggestionFor', () => {
  it('offers the planned slot for the current date and window, with names and carbs', () => {
    const suggestion = suggestionFor(args())!;
    expect(suggestion.entry.id).toBe('p1');
    expect(suggestion.names).toEqual(['Tortilla']);
    expect(suggestion.carbs).toEqual({ carbs_g: 72, complete: true });
  });

  it('offers nothing when the window is unknown', () => {
    expect(suggestionFor(args({ windowName: null }))).toBeNull();
  });

  it('offers nothing for another date or another window', () => {
    expect(suggestionFor(args({ date: '2026-09-17' }))).toBeNull();
    expect(suggestionFor(args({ windowName: 'Dinner' }))).toBeNull();
  });

  it('offers nothing once the slot is skipped or logged', () => {
    expect(suggestionFor(args({ entries: [{ ...planned, status: 'skipped' }] }))).toBeNull();
    expect(suggestionFor(args({ entries: [{ ...planned, status: 'logged' }] }))).toBeNull();
  });

  it('offers nothing for a slot dismissed on this device', () => {
    // slotKey normalizes (trim + lowercase) to match the server's case-insensitive window_name
    // comparison — see plan/slots.ts — so the dismissed key must be normalized too.
    expect(suggestionFor(args({ dismissed: new Set(['2026-09-16|lunch']) }))).toBeNull();
  });

  it('offers nothing for a deleted entry or an entry with no items', () => {
    expect(suggestionFor(args({ entries: [synced(planned, { deleted: 1 })] }))).toBeNull();
    expect(suggestionFor(args({ items: [] }))).toBeNull();
  });
});
