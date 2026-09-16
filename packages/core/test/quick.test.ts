import { describe, expect, it } from 'vitest';
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
