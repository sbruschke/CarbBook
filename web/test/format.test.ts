import { describe, expect, it } from 'vitest';
import { isBarcodeCode } from '../src/barcode/scanner';
import {
  dayKey,
  dayRange,
  formatAge,
  formatCarbs,
  formatDayLabel,
  formatUnits,
  fromDateTimeLocal,
  parseNonNegative,
  parseWholeNumber,
  shiftDay,
  startOfWeek,
  toDateTimeLocal,
  unitLabel,
  weekDates,
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

  it('shows just the label for a portion with unknown weight (any-unit foods)', () => {
    const portions = [{ id: 'p3', food_id: 'f', label: 'bar', kind: 'count' as const, quantity: 1, grams: null, carbs_g: 22 }];
    expect(unitLabel('p:p3', portions)).toBe('bar');
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

  it('parses amounts strictly, accepting a comma decimal separator', () => {
    expect(parseNonNegative('1,5')).toBe(1.5);
    expect(parseNonNegative(' 1,5 ')).toBe(1.5);
    expect(parseNonNegative('0x64')).toBeNull();
    expect(parseNonNegative('1e3')).toBeNull();
    expect(parseNonNegative('0b1')).toBeNull();
    expect(parseNonNegative('Infinity')).toBeNull();
    expect(parseNonNegative(' ')).toBeNull();
    expect(parseNonNegative('1,5,5')).toBeNull();
    expect(parseNonNegative('12O')).toBeNull();
  });

  it('parses whole-number BG strictly, rejecting a comma decimal separator', () => {
    expect(parseWholeNumber('120')).toBe(120);
    expect(parseWholeNumber(' 120 ')).toBe(120);
    expect(parseWholeNumber('')).toBeNull();
    expect(parseWholeNumber('   ')).toBeNull();
    expect(parseWholeNumber('12O')).toBeNull();
    expect(parseWholeNumber('-5')).toBeNull();
    expect(parseWholeNumber('1,5')).toBeNull();
    expect(parseWholeNumber('0x64')).toBeNull();
    expect(parseWholeNumber('1e3')).toBeNull();
    expect(parseWholeNumber('0b1')).toBeNull();
    expect(parseWholeNumber('Infinity')).toBeNull();
  });

  it('accepts only the barcode codes the server looks up', () => {
    expect(isBarcodeCode('0737628064502')).toBe(true);
    expect(isBarcodeCode('12345')).toBe(false);
    expect(isBarcodeCode('https://example.com')).toBe(false);
  });
});

describe('week helpers', () => {
  it('starts weeks on Monday', () => {
    expect(startOfWeek('2026-09-16')).toBe('2026-09-14'); // Wednesday → Monday
    expect(startOfWeek('2026-09-14')).toBe('2026-09-14'); // Monday → itself
    expect(startOfWeek('2026-09-20')).toBe('2026-09-14'); // Sunday → that Monday
  });

  it('lists the seven dates of a week in order', () => {
    expect(weekDates('2026-09-14')).toEqual([
      '2026-09-14',
      '2026-09-15',
      '2026-09-16',
      '2026-09-17',
      '2026-09-18',
      '2026-09-19',
      '2026-09-20',
    ]);
  });

  it('labels a day with its weekday and date', () => {
    expect(formatDayLabel('2026-09-16')).toBe('Wed 16 Sep');
  });
});
