import type { LogEntryData, LogItemData } from '@carbbook/core';
import { describe, expect, it } from 'vitest';
import { buildSearchIndex, lastLoggedByRef, tokenize } from '../src/search/search';
import { foodData, mealData, synced } from './helpers';

const entry = (id: string, eatenAt: number, deleted: 0 | 1 = 0) =>
  synced<LogEntryData>(
    { id, eaten_at: eatenAt, window_name: 'Lunch', bg_mgdl: null, bg_source: 'none', total_carbs_g: 20, suggested_units: null, taken_units: null, settings_version_id: null },
    { deleted },
  );
const item = (id: string, entryId: string, refId: string) =>
  synced<LogItemData>({ id, log_entry_id: entryId, ref_type: 'food', ref_id: refId, display_name: 'x', amount: 1, unit: 'g', carbs_g: 1 });

function index() {
  return buildSearchIndex({
    foods: [
      synced(foodData({ id: 'off-old', name: 'Peanut butter crunchy', source: 'off', brand: 'Jif' })),
      synced(foodData({ id: 'off-recent', name: 'Peanut butter cups', source: 'off', brand: "Reese's" })),
      synced(foodData({ id: 'custom-pb', name: 'Peanut butter cookies', source: 'custom' })),
      synced(foodData({ id: 'gone', name: 'Peanut brittle', source: 'custom' }), { deleted: 1 }),
      synced(foodData({ id: 'creme', name: 'Crème fraîche', source: 'custom' })),
    ],
    meals: [synced(mealData({ id: 'meal-pb', name: 'PB toast with peanut butter' }))],
    usdaFoods: [
      { fdc_id: 324860, name: 'Peanut butter, smooth style, with salt', carbs_per_100g: 22.3, fiber_per_100g: 4.8 },
      { fdc_id: 2706093, name: 'Chicken nuggets, from fast food', carbs_per_100g: 14.93, fiber_per_100g: 0.9 },
    ],
    lastLogged: lastLoggedByRef([entry('e1', 5000)], [item('i1', 'e1', 'off-recent')]),
  });
}

describe('tokenize', () => {
  it('lower-cases, strips accents and punctuation', () => {
    expect(tokenize('Crème  Fraîche, 2%')).toEqual(['creme', 'fraiche', '2']);
    expect(tokenize('  !! ')).toEqual([]);
  });
});

describe('local search', () => {
  it('ranks meals and custom foods, then recently logged saved foods, then other saved foods, then USDA', () => {
    const hits = index().search('peanut butter');
    expect(hits.map((h) => h.id)).toEqual(['custom-pb', 'meal-pb', 'off-recent', 'off-old', 'usda-324860']);
    expect(hits[4]).toEqual({ kind: 'usda', id: 'usda-324860', name: 'Peanut butter, smooth style, with salt', brand: null, source: 'usda', carbs_per_100g: 22.3 });
    expect(hits.find((h) => h.id === 'off-old')).toMatchObject({ kind: 'food', brand: 'Jif', source: 'off' });
  });

  it('excludes deleted records, matches prefixes and brands, ignores accents', () => {
    const search = index();
    expect(search.search('brittle')).toEqual([]);
    expect(search.search('creme fra').map((h) => h.id)).toEqual(['creme']);
    expect(search.search('nugg').map((h) => h.id)).toEqual(['usda-2706093']);
    expect(search.search('jif').map((h) => h.id)).toEqual(['off-old']);
    expect(search.search('peanut', 3)).toHaveLength(3);
  });

  it('shows a saved USDA copy once, as a saved food', () => {
    const search = buildSearchIndex({
      foods: [synced(foodData({ id: 'usda-324860', name: 'Peanut butter, smooth style, with salt', source: 'usda', source_ref: '324860' }))],
      meals: [],
      usdaFoods: [{ fdc_id: 324860, name: 'Peanut butter, smooth style, with salt', carbs_per_100g: 22.3, fiber_per_100g: 4.8 }],
      lastLogged: new Map(),
    });
    expect(search.search('peanut')).toEqual([expect.objectContaining({ id: 'usda-324860', kind: 'food' })]);
  });

  it('lists recently logged items newest first, ignoring deleted log rows', () => {
    const lastLogged = lastLoggedByRef(
      [entry('e1', 1000), entry('e2', 3000), entry('e3', 9000, 1)],
      [item('i1', 'e1', 'creme'), item('i2', 'e2', 'meal-pb'), item('i3', 'e3', 'off-old')],
    );
    expect([...lastLogged.entries()]).toEqual([['creme', 1000], ['meal-pb', 3000]]);
    const search = buildSearchIndex({
      foods: [synced(foodData({ id: 'creme', name: 'Crème fraîche' }))],
      meals: [synced(mealData({ id: 'meal-pb', name: 'PB toast' }))],
      usdaFoods: [],
      lastLogged,
    });
    expect(search.recent().map((h) => h.id)).toEqual(['meal-pb', 'creme']);
  });
});
