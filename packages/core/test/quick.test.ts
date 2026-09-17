import { describe, expect, it } from 'vitest';
import { createCatalog, itemCarbs, sumCarbs, wouldCreateCycle } from '../src/carbs';
import {
  QUICK_DEFAULT_LABEL,
  QUICK_LABEL_MAX,
  QUICK_UNIT,
  isValidQuickCarbs,
  itemRefId,
  normalizeQuickLabel,
  quickDisplayName,
  quickUnits,
} from '../src/units';

describe('quick carbs helpers', () => {
  it('uses grams of carbs as the only unit', () => {
    expect(QUICK_UNIT).toBe('carbs');
    expect(quickUnits()).toEqual(['carbs']);
  });

  it('accepts 0..2000 g and fails closed on everything else', () => {
    for (const ok of [0, 7, 7.5, 2000]) expect(isValidQuickCarbs(ok), String(ok)).toBe(true);
    for (const bad of [-1, 2000.01, 2001, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(isValidQuickCarbs(bad), String(bad)).toBe(false);
    }
  });

  it('stores labels trimmed, capped at 80 characters, and null when blank', () => {
    expect(QUICK_LABEL_MAX).toBe(80);
    expect(normalizeQuickLabel('  Ranch & salad ')).toBe('Ranch & salad');
    expect(normalizeQuickLabel('   ')).toBeNull();
    expect(normalizeQuickLabel(undefined)).toBeNull();
    expect(normalizeQuickLabel(null)).toBeNull();
    expect(normalizeQuickLabel('x'.repeat(90))).toBe('x'.repeat(80));
  });

  it('shows a blank label as "Extra carbs"', () => {
    expect(QUICK_DEFAULT_LABEL).toBe('Extra carbs');
    expect(quickDisplayName(null)).toBe('Extra carbs');
    expect(quickDisplayName(' Salsa ')).toBe('Salsa');
  });

  it('points a quick row at itself and leaves other refs alone', () => {
    expect(itemRefId('quick', '', 'row-1')).toBe('row-1');
    expect(itemRefId('quick', 'stale', 'row-2')).toBe('row-2');
    expect(itemRefId('food', 'rice', 'row-3')).toBe('rice');
    expect(itemRefId('meal', 'bowl', 'row-4')).toBe('bowl');
  });
});

describe('itemCarbs for quick rows', () => {
  const catalog = createCatalog({
    foods: [{ id: 'tortilla', name: 'Tortilla', carbs_per_100g: 48 }],
    meals: [{ id: 'plate', name: 'Plate', yield_servings: 2, total_weight_g: null }],
    meal_items: [
      { id: 'm1', meal_id: 'plate', ref_type: 'food', ref_id: 'tortilla', amount: 100, unit: 'g', position: 0 },
      { id: 'm2', meal_id: 'plate', ref_type: 'quick', ref_id: 'm2', amount: 7, unit: 'carbs', position: 1, label: 'Salsa' },
    ],
  });

  it('is the amount itself, without looking up ref_id', () => {
    expect(itemCarbs(catalog, 'quick', 'no-such-row', 7, 'carbs')).toEqual({ carbs_g: 7, complete: true });
    expect(itemCarbs(catalog, 'quick', '', 0, 'carbs')).toEqual({ carbs_g: 0, complete: true });
    expect(itemCarbs(catalog, 'quick', 'q', 2000, 'carbs')).toEqual({ carbs_g: 2000, complete: true });
  });

  it('fails closed on a bad amount or unit', () => {
    for (const [amount, unit] of [
      [2001, 'carbs'],
      [-1, 'carbs'],
      [Number.NaN, 'carbs'],
      [Number.POSITIVE_INFINITY, 'carbs'],
      [7, 'g'],
      [7, 'serving'],
    ] as const) {
      expect(itemCarbs(catalog, 'quick', 'q', amount, unit), `${amount} ${unit}`).toEqual({ carbs_g: 0, complete: false });
    }
  });

  it('counts inside meals and totals like any other row', () => {
    expect(itemCarbs(catalog, 'meal', 'plate', 1, 'serving')).toEqual({ carbs_g: 27.5, complete: true });
    const total = sumCarbs([itemCarbs(catalog, 'food', 'tortilla', 100, 'g'), itemCarbs(catalog, 'quick', 'q', 7, 'carbs')]);
    expect(total).toEqual({ carbs_g: 55, complete: true });
  });

  it('never creates a meal cycle', () => {
    expect(wouldCreateCycle(catalog, 'plate', 'm2')).toBe(false);
  });
});
