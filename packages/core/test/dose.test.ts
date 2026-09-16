import { describe, expect, it } from 'vitest';
import type { DoseSettingsData } from '../src/types';
import {
  activeSettings,
  DOSE_LIMITS,
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
  it('breaks effective_from ties by the larger id', () => {
    const a = { id: 'a', effective_from: Date.UTC(2026, 8, 14) };
    const b = { id: 'b', effective_from: Date.UTC(2026, 8, 14) };
    expect(activeSettings([a, b], Date.UTC(2026, 8, 14))?.id).toBe('b');
    expect(activeSettings([b, a], Date.UTC(2026, 8, 14))?.id).toBe('b');
  });
  it('skips soft-deleted rows, even when they would otherwise be the newest match', () => {
    const live = { id: 'live', effective_from: Date.UTC(2026, 6, 1), deleted: 0 as const };
    const deleted = { id: 'deleted', effective_from: Date.UTC(2026, 7, 1), deleted: 1 as const };
    expect(activeSettings([live, deleted], Date.UTC(2026, 8, 14))?.id).toBe('live');
    expect(activeSettings([deleted], Date.UTC(2026, 8, 14))).toBeNull();
  });
});

describe('recentDoseWarning', () => {
  it('warns within 4 hours of a logged dose', () => {
    const now = Date.UTC(2026, 8, 14, 12);
    expect(recentDoseWarning(now - 3 * 3600_000, now)).toBe(true);
    expect(recentDoseWarning(now - 5 * 3600_000, now)).toBe(false);
    expect(recentDoseWarning(null, now)).toBe(false);
  });
  it('warns for a dose logged in the future (clock skew)', () => {
    const now = Date.UTC(2026, 8, 14, 12);
    expect(recentDoseWarning(now + 10 * 60_000, now)).toBe(true);
  });
});

describe('estimateDose validation', () => {
  it('rejects invalid input with reason invalid_input and null window', () => {
    expect(estimateDose({ settings, minutes: 1.5, carbs: { carbs_g: 10, complete: true }, bg: null }))
      .toEqual({ ok: false, reason: 'invalid_input', window: null });
    expect(estimateDose({ settings, minutes: -1, carbs: { carbs_g: 10, complete: true }, bg: null }))
      .toEqual({ ok: false, reason: 'invalid_input', window: null });
    expect(estimateDose({ settings, minutes: 1440, carbs: { carbs_g: 10, complete: true }, bg: null }))
      .toEqual({ ok: false, reason: 'invalid_input', window: null });
    expect(estimateDose({ settings, minutes: 600, carbs: { carbs_g: NaN, complete: true }, bg: null }))
      .toEqual({ ok: false, reason: 'invalid_input', window: null });
    expect(estimateDose({ settings, minutes: 600, carbs: { carbs_g: -1, complete: true }, bg: null }))
      .toEqual({ ok: false, reason: 'invalid_input', window: null });
    expect(estimateDose({ settings, minutes: 600, carbs: { carbs_g: 10, complete: true }, bg: NaN }))
      .toEqual({ ok: false, reason: 'invalid_input', window: null });
    expect(estimateDose({ settings, minutes: 600, carbs: { carbs_g: 10, complete: true }, bg: -1 }))
      .toEqual({ ok: false, reason: 'invalid_input', window: null });
  });

  it('rejects invalid settings with reason invalid_settings and null window', () => {
    const badStart = { ...settings, windows: [{ name: 'Bad', start: '25:99', ratio_g_per_unit: 8 }] };
    expect(estimateDose({ settings: badStart, minutes: 600, carbs: { carbs_g: 10, complete: true }, bg: null }))
      .toEqual({ ok: false, reason: 'invalid_settings', window: null });

    const dupStart = { ...settings, windows: [
      { name: 'A', start: '05:00', ratio_g_per_unit: 8 },
      { name: 'B', start: '05:00', ratio_g_per_unit: 10 },
    ] };
    expect(estimateDose({ settings: dupStart, minutes: 600, carbs: { carbs_g: 10, complete: true }, bg: null }))
      .toEqual({ ok: false, reason: 'invalid_settings', window: null });

    const badThreshold = { ...settings, correction: { ...settings.correction, threshold: NaN } };
    expect(estimateDose({ settings: badThreshold, minutes: 600, carbs: { carbs_g: 10, complete: true }, bg: null }))
      .toEqual({ ok: false, reason: 'invalid_settings', window: null });

    const badStep = { ...settings, correction: { ...settings.correction, step: 0 } };
    expect(estimateDose({ settings: badStep, minutes: 600, carbs: { carbs_g: 10, complete: true }, bg: null }))
      .toEqual({ ok: false, reason: 'invalid_settings', window: null });

    const badUnitsPerStep = { ...settings, correction: { ...settings.correction, units_per_step: -1 } };
    expect(estimateDose({ settings: badUnitsPerStep, minutes: 600, carbs: { carbs_g: 10, complete: true }, bg: null }))
      .toEqual({ ok: false, reason: 'invalid_settings', window: null });

    const badMode = { ...settings, correction: { ...settings.correction, mode: 'bogus' as never } };
    expect(estimateDose({ settings: badMode, minutes: 600, carbs: { carbs_g: 10, complete: true }, bg: null }))
      .toEqual({ ok: false, reason: 'invalid_settings', window: null });

    const badIncrement = { ...settings, rounding: { ...settings.rounding, increment: 0 } };
    expect(estimateDose({ settings: badIncrement, minutes: 600, carbs: { carbs_g: 10, complete: true }, bg: null }))
      .toEqual({ ok: false, reason: 'invalid_settings', window: null });

    const badRoundDownBg = { ...settings, rounding: { ...settings.rounding, round_down_below_bg: NaN } };
    expect(estimateDose({ settings: badRoundDownBg, minutes: 600, carbs: { carbs_g: 10, complete: true }, bg: null }))
      .toEqual({ ok: false, reason: 'invalid_settings', window: null });
  });
});

describe('estimateDose sanity limits', () => {
  const at = (s: DoseSettingsData, carbs: number, bg: number | null, minutes = 600) =>
    estimateDose({ settings: s, minutes, carbs: { carbs_g: carbs, complete: true }, bg });
  const refused = (reason: string, window: unknown = null) => ({ ok: false, reason, window });

  it('exports the limits', () => {
    expect(DOSE_LIMITS).toEqual({
      maxCarbsG: 2000,
      maxBg: 1000,
      maxRatioGPerUnit: 1000,
      maxCorrectionThreshold: 1000,
      maxCorrectionStep: 1000,
      maxUnitsPerStep: 50,
      maxRoundingIncrement: 10,
      maxRoundDownBelowBg: 1000,
      maxRawUnits: 50,
    });
  });

  it('refuses carbs over 2000 g and BG over 1000 as invalid_input', () => {
    expect(at(settings, 2000, null)).not.toMatchObject({ reason: 'invalid_input' }); // 200u → exceeds_limit
    expect(at(settings, 2001, null)).toEqual(refused('invalid_input'));
    expect(at(settings, 10, 1000).ok).toBe(true);
    expect(at(settings, 10, 1001)).toEqual(refused('invalid_input'));
  });

  it('refuses out-of-range settings as invalid_settings', () => {
    const cases: DoseSettingsData[] = [
      { ...settings, windows: [...settings.windows.slice(1), { name: 'Huge', start: '05:00', ratio_g_per_unit: 1001 }] },
      { ...settings, correction: { ...settings.correction, threshold: 1001 } },
      { ...settings, correction: { ...settings.correction, step: 1001 } },
      { ...settings, correction: { ...settings.correction, units_per_step: 51 } },
      { ...settings, rounding: { ...settings.rounding, increment: 11 } },
      { ...settings, rounding: { ...settings.rounding, round_down_below_bg: 1001 } },
    ];
    for (const s of cases) expect(at(s, 10, null)).toEqual(refused('invalid_settings'));
    const atLimits: DoseSettingsData = {
      ...settings,
      windows: [{ name: 'All', start: '00:00', ratio_g_per_unit: 1000 }],
      correction: { threshold: 1000, step: 1000, units_per_step: 50, mode: 'started' },
      rounding: { increment: 10, round_down_below_bg: 1000 },
    };
    expect(at(atLimits, 10, null).ok).toBe(true);
  });

  it('refuses a raw dose over 50 units with exceeds_limit and the window', () => {
    const dinner = settings.windows[4];
    expect(at(settings, 400, null, 1080)).toMatchObject({ ok: true, raw_units: 50, units: 50 });
    expect(at(settings, 401, null, 1080)).toEqual(refused('exceeds_limit', dinner));
    // meal 45 + correction 6 (BG 500 → 6 started steps) = 51
    expect(at(settings, 360, 500, 1080)).toEqual(refused('exceeds_limit', dinner));
  });

  it('checks limits in order: input, settings, window, ratio, carbs, then exceeds_limit', () => {
    const badSettings = { ...settings, rounding: { ...settings.rounding, increment: 11 } };
    expect(at(badSettings, 2001, null)).toEqual(refused('invalid_input'));
    expect(at({ ...badSettings, windows: [] }, 5000 / 3, null)).toEqual(refused('invalid_settings'));
    expect(estimateDose({ settings, minutes: 1080, carbs: { carbs_g: 1000, complete: false }, bg: null }))
      .toEqual(refused('incomplete_carbs', settings.windows[4]));
    const zero = { ...settings, windows: [{ name: 'Z', start: '00:00', ratio_g_per_unit: 0 }] };
    expect(at(zero, 1000, null)).toEqual(refused('invalid_ratio', zero.windows[0]));
  });
});

describe('carb_goal does not affect dose math', () => {
  it('produces an identical estimate with and without carb_goal on the window', () => {
    const base: DoseSettingsData = {
      id: 'settings-goal-check',
      effective_from: 0,
      windows: [
        { name: 'Breakfast', start: '05:00', ratio_g_per_unit: 8 },
        { name: 'Lunch', start: '11:00', ratio_g_per_unit: 8 },
      ],
      correction: { threshold: 200, step: 50, units_per_step: 1, mode: 'started' },
      rounding: { increment: 1, round_down_below_bg: 130 },
    };
    const withGoals: DoseSettingsData = {
      ...base,
      windows: [
        { name: 'Breakfast', start: '05:00', ratio_g_per_unit: 8, carb_goal: { min: 30, max: 50 } },
        { name: 'Lunch', start: '11:00', ratio_g_per_unit: 8, carb_goal: null },
      ],
    };
    const input = { minutes: 12 * 60, carbs: { carbs_g: 72, complete: true }, bg: 263 };
    const plain = estimateDose({ settings: base, ...input });
    const goals = estimateDose({ settings: withGoals, ...input });
    expect(plain.ok).toBe(true);
    if (!plain.ok || !goals.ok) throw new Error('expected both estimates to succeed');
    expect(goals.units).toBe(plain.units);
    expect(goals.meal_units).toBe(plain.meal_units);
    expect(goals.correction_units).toBe(plain.correction_units);
    expect(goals.raw_units).toBe(plain.raw_units);
    expect(formatBreakdown(goals)).toBe(formatBreakdown(plain));
  });

  it('still rejects a nonsense carb_goal without changing the dose', () => {
    const settings: DoseSettingsData = {
      id: 'settings-bad-goal',
      effective_from: 0,
      windows: [{ name: 'All day', start: '00:00', ratio_g_per_unit: 10, carb_goal: { min: 90, max: 10 } }],
      correction: { threshold: 200, step: 50, units_per_step: 1, mode: 'started' },
      rounding: { increment: 1, round_down_below_bg: null },
    };
    const estimate = estimateDose({ settings, minutes: 600, carbs: { carbs_g: 50, complete: true }, bg: null });
    expect(estimate).toMatchObject({ ok: true, units: 5 });
  });
});
