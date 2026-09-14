import { describe, expect, it } from 'vitest';
import type { DoseSettingsData } from '../src/types';
import {
  activeSettings,
  correctionUnits,
  estimateDose,
  formatBreakdown,
  parseHHMM,
  pickWindow,
  recentDoseWarning,
  roundDose,
} from '../src/dose';

const settings: DoseSettingsData = {
  id: 's1',
  effective_from: Date.UTC(2026, 7, 12),
  windows: [
    { name: 'Breakfast', start: '05:00', ratio_g_per_unit: 8 },
    { name: 'AM Snack', start: '09:00', ratio_g_per_unit: 10 },
    { name: 'Lunch', start: '11:00', ratio_g_per_unit: 8 },
    { name: 'PM Snack', start: '14:00', ratio_g_per_unit: 10 },
    { name: 'Dinner', start: '16:30', ratio_g_per_unit: 8 },
    { name: 'HS Snack', start: '19:30', ratio_g_per_unit: 12 },
  ],
  correction: { threshold: 200, step: 50, units_per_step: 1, mode: 'started' },
  rounding: { increment: 1, round_down_below_bg: 130 },
};

describe('parseHHMM', () => {
  it('parses valid times and rejects invalid ones', () => {
    expect(parseHHMM('16:30')).toBe(990);
    expect(() => parseHHMM('24:00')).toThrow();
    expect(() => parseHHMM('9:00')).toThrow();
  });
});

describe('pickWindow', () => {
  it('uses start-inclusive windows and wraps overnight', () => {
    expect(pickWindow(settings.windows, parseHHMM('09:00'))?.name).toBe('AM Snack');
    expect(pickWindow(settings.windows, parseHHMM('08:59'))?.name).toBe('Breakfast');
    expect(pickWindow(settings.windows, parseHHMM('23:30'))?.name).toBe('HS Snack');
    expect(pickWindow(settings.windows, parseHHMM('04:59'))?.name).toBe('HS Snack');
    expect(pickWindow([], 600)).toBeNull();
  });
  it('does not depend on input order', () => {
    const shuffled = [...settings.windows].reverse();
    expect(pickWindow(shuffled, parseHHMM('12:00'))?.name).toBe('Lunch');
  });
});

describe('correctionUnits', () => {
  const rule = settings.correction;
  it('started mode', () => {
    expect(correctionUnits(rule, 200)).toBe(0);
    expect(correctionUnits(rule, 201)).toBe(1);
    expect(correctionUnits(rule, 250)).toBe(1);
    expect(correctionUnits(rule, 251)).toBe(2);
    expect(correctionUnits(rule, null)).toBe(0);
  });
  it('full and proportional modes', () => {
    expect(correctionUnits({ ...rule, mode: 'full' }, 249)).toBe(0);
    expect(correctionUnits({ ...rule, mode: 'full' }, 263)).toBe(1);
    expect(correctionUnits({ ...rule, mode: 'proportional' }, 275)).toBeCloseTo(1.5, 9);
  });
});

describe('roundDose', () => {
  it('rounds half-up normally and down below the BG cutoff', () => {
    expect(roundDose(9.5, settings.rounding, 140)).toEqual({ units: 10, rounded_down: false });
    expect(roundDose(9.9, settings.rounding, 125)).toEqual({ units: 9, rounded_down: true });
    expect(roundDose(2.5, settings.rounding, null)).toEqual({ units: 3, rounded_down: false });
    expect(roundDose(3.26, { increment: 0.5, round_down_below_bg: null }, 90)).toEqual({ units: 3.5, rounded_down: false });
  });
});

describe('estimateDose', () => {
  it('combines meal and correction units', () => {
    const r = estimateDose({ settings, minutes: parseHHMM('18:00'), carbs: { carbs_g: 72, complete: true }, bg: 263 });
    expect(r).toMatchObject({ ok: true, meal_units: 9, correction_units: 2, units: 11, rounded_down: false });
    if (r.ok) expect(formatBreakdown(r)).toBe('72g ÷ 8 = 9.0 + BG 263 → 2u = 11.0 → 11u');
  });
  it('refuses to estimate with incomplete carbs', () => {
    const r = estimateDose({ settings, minutes: 600, carbs: { carbs_g: 40, complete: false }, bg: 150 });
    expect(r).toEqual({ ok: false, reason: 'incomplete_carbs', window: settings.windows[1] });
  });
  it('reports missing windows and invalid ratios', () => {
    expect(estimateDose({ settings: { ...settings, windows: [] }, minutes: 600, carbs: { carbs_g: 10, complete: true }, bg: null }))
      .toEqual({ ok: false, reason: 'no_window', window: null });
    const zero = { ...settings, windows: [{ name: 'All', start: '00:00', ratio_g_per_unit: 0 }] };
    expect(estimateDose({ settings: zero, minutes: 600, carbs: { carbs_g: 10, complete: true }, bg: null }))
      .toMatchObject({ ok: false, reason: 'invalid_ratio' });
  });
});

describe('activeSettings', () => {
  it('picks the newest version already in effect', () => {
    const old = { ...settings, id: 'old', effective_from: Date.UTC(2025, 6, 19) };
    const future = { ...settings, id: 'future', effective_from: Date.UTC(2030, 0, 1) };
    expect(activeSettings([old, settings, future], Date.UTC(2026, 8, 14))?.id).toBe('s1');
    expect(activeSettings([future], Date.UTC(2026, 8, 14))).toBeNull();
  });
});

describe('recentDoseWarning', () => {
  it('warns within 4 hours of a logged dose', () => {
    const now = Date.UTC(2026, 8, 14, 12);
    expect(recentDoseWarning(now - 3 * 3600_000, now)).toBe(true);
    expect(recentDoseWarning(now - 5 * 3600_000, now)).toBe(false);
    expect(recentDoseWarning(null, now)).toBe(false);
  });
});
