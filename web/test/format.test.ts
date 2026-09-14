import { describe, expect, it } from 'vitest';
import { isBarcodeCode } from '../src/barcode/scanner';
import {
  dayKey,
  dayRange,
  formatAge,
  formatCarbs,
  formatUnits,
  fromDateTimeLocal,
  parseNonNegative,
  shiftDay,
  toDateTimeLocal,
  unitLabel,
} from '../src/ui/format';

describe('format helpers', () => {
  it('labels core unit ids', () => {
    const portions = [
      { id: 'p1', food_id: 'f', label: 'slice', kind: 'count' as const, quantity: 1, grams: 30 },
      { id: 'p2', food_id: 'f', label: 'cookies', kind: 'serving' as const, quantity: 2, grams: 28 },
    ];
    expect(unitLabel('p:p1', portions)).toBe('slice (30 g)');
    expect(unitLabel('p:p2', portions)).toBe('cookies (14 g)');
    expect(unitLabel('p:gone', portions)).toBe('unknown portion');
    expect(unitLabel('floz', [])).toBe('fl oz');
    expect(unitLabel('serving', [])).toBe('servings');
  });

  it('formats numbers and ages', () => {
    expect(formatCarbs(35.68)).toBe('35.7 g');
    expect(formatCarbs(72)).toBe('72 g');
    expect(formatUnits(4.5)).toBe('4.5 u');
    expect(formatAge(30_000)).toBe('just now');
    expect(formatAge(6 * 60_000)).toBe('6 min ago');
  });

  it('handles local days and datetime-local values', () => {
    const t = new Date(2026, 8, 14, 7, 5).getTime();
    expect(dayKey(t)).toBe('2026-09-14');
    expect(dayRange('2026-09-14')).toEqual([new Date(2026, 8, 14).getTime(), new Date(2026, 8, 15).getTime()]);
    expect(shiftDay('2026-03-01', -1)).toBe('2026-02-28');
    expect(toDateTimeLocal(t)).toBe('2026-09-14T07:05');
    expect(fromDateTimeLocal('2026-09-14T07:05')).toBe(t);
    expect(fromDateTimeLocal('')).toBeNull();
  });

  it('parses non-negative numbers', () => {
    expect(parseNonNegative(' 12.5 ')).toBe(12.5);
    expect(parseNonNegative('0')).toBe(0);
    expect(parseNonNegative('')).toBeNull();
    expect(parseNonNegative('-1')).toBeNull();
    expect(parseNonNegative('abc')).toBeNull();
  });

  it('accepts only the barcode codes the server looks up', () => {
    expect(isBarcodeCode('0737628064502')).toBe(true);
    expect(isBarcodeCode('12345')).toBe(false);
    expect(isBarcodeCode('https://example.com')).toBe(false);
  });
});
