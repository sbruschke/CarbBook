import { describe, expect, it } from 'vitest';
import { GOAL_STATUS_LABELS, dayGoal, goalStatus, isValidCarbGoal } from '../src/goal';
import type { DoseWindow, PlanEntryData, PlanItemData, PlanStatus } from '../src/types';

const complete = (carbs_g: number) => ({ carbs_g, complete: true });
const GOAL = { min: 50, max: 80 };

const window = (name: string, start: string, carb_goal: { min: number; max: number } | null): DoseWindow => ({
  name,
  start,
  ratio_g_per_unit: 8,
  carb_goal,
});

describe('isValidCarbGoal', () => {
  it.each([
    [{ min: 30, max: 50 }],
    [{ min: 0, max: 0 }],
    [{ min: 0, max: 2000 }],
    [{ min: 50, max: 50 }],
  ])('accepts %j', (goal) => {
    expect(isValidCarbGoal(goal)).toBe(true);
  });

  it.each([
    [null],
    [undefined],
    [{ min: 50, max: 40 }],
    [{ min: -1, max: 50 }],
    [{ min: 0, max: 2001 }],
    [{ min: Number.NaN, max: 50 }],
    [{ min: 30, max: Number.POSITIVE_INFINITY }],
    [{ min: 30 }],
    [{ max: 50 }],
    [{ min: '30', max: '50' }],
    [[30, 50]],
    ['30-50'],
  ])('rejects %j', (goal) => {
    expect(isValidCarbGoal(goal)).toBe(false);
  });

  it('still rejects a max above the storage ceiling even though goalStatus/dayGoal no longer cap there', () => {
    expect(isValidCarbGoal({ min: 0, max: 6000 })).toBe(false);
  });
});

describe('goalStatus', () => {
  it.each([
    [50, 'in'],
    [65, 'in'],
    [80, 'in'],
    [49.9, 'near'],
    [45, 'near'],
    [80.1, 'near'],
    [85, 'near'],
    [44.9, 'off'],
    [40, 'off'],
    [85.1, 'off'],
    [90, 'off'],
    [39.9, 'out'],
    [0, 'out'],
    [90.1, 'out'],
    [200, 'out'],
  ])('carbs %s against 50-80 is %s', (carbs, expected) => {
    expect(goalStatus(complete(carbs), GOAL)).toBe(expected);
  });

  it('is "none" when there is no goal', () => {
    expect(goalStatus(complete(65), null)).toBe('none');
    expect(goalStatus(complete(65), undefined)).toBe('none');
  });

  it('is "none" when the goal is not usable', () => {
    expect(goalStatus(complete(65), { min: 80, max: 50 })).toBe('none');
  });

  it('is "none" when the carbs are incomplete, even inside the goal', () => {
    expect(goalStatus({ carbs_g: 65, complete: false }, GOAL)).toBe('none');
  });

  it('is "none" when the carb total is not finite', () => {
    expect(goalStatus({ carbs_g: Number.NaN, complete: true }, GOAL)).toBe('none');
  });

  it('treats a zero-width goal as reachable', () => {
    expect(goalStatus(complete(0), { min: 0, max: 0 })).toBe('in');
    expect(goalStatus(complete(5), { min: 0, max: 0 })).toBe('near');
  });

  it('has a screen-reader label for every status', () => {
    expect(Object.keys(GOAL_STATUS_LABELS).sort()).toEqual(['in', 'near', 'none', 'off', 'out']);
    expect(GOAL_STATUS_LABELS.in).toBe('in goal');
  });

  it('colours a range above the storage ceiling instead of falling back to "none"', () => {
    expect(goalStatus(complete(3000), { min: 0, max: 6000 })).toBe('in');
    expect(goalStatus(complete(6003), { min: 0, max: 6000 })).toBe('near');
    expect(goalStatus(complete(6008), { min: 0, max: 6000 })).toBe('off');
    expect(goalStatus(complete(6015), { min: 0, max: 6000 })).toBe('out');
  });

  it('is "none" for an inverted or non-finite range even when it is above the storage ceiling', () => {
    expect(goalStatus(complete(100), { min: 6000, max: 0 })).toBe('none');
    expect(goalStatus(complete(100), { min: Number.NaN, max: 6000 })).toBe('none');
    expect(goalStatus(complete(100), { min: 0, max: Number.POSITIVE_INFINITY })).toBe('none');
  });

  it('treats floating-point boundary noise symmetrically', () => {
    expect(goalStatus(complete(44.999999999), GOAL)).toBe('near');
    expect(goalStatus(complete(85.000000001), GOAL)).toBe('near');
  });
});

describe('dayGoal', () => {
  it('sums the goals of the windows that have one', () => {
    expect(
      dayGoal([
        window('Breakfast', '05:00', { min: 30, max: 50 }),
        window('Lunch', '11:00', { min: 50, max: 80 }),
      ]),
    ).toEqual({ min: 80, max: 130 });
  });

  it('ignores windows without a goal', () => {
    expect(
      dayGoal([
        window('Breakfast', '05:00', { min: 30, max: 50 }),
        window('AM Snack', '09:00', null),
        { name: 'Lunch', start: '11:00', ratio_g_per_unit: 8 },
      ]),
    ).toEqual({ min: 30, max: 50 });
  });

  it('ignores windows whose goal is unusable', () => {
    expect(
      dayGoal([window('Breakfast', '05:00', { min: 30, max: 50 }), window('Lunch', '11:00', { min: 90, max: 10 })]),
    ).toEqual({ min: 30, max: 50 });
  });

  it('is null when no window in the day has a goal', () => {
    expect(dayGoal([window('Breakfast', '05:00', null), window('Lunch', '11:00', null)])).toBeNull();
    expect(dayGoal([])).toBeNull();
  });

  it('produces a goal that goalStatus can use for a day total', () => {
    const goal = dayGoal([window('Breakfast', '05:00', { min: 30, max: 50 }), window('Lunch', '11:00', { min: 50, max: 80 })]);
    expect(goalStatus({ carbs_g: 100, complete: true }, goal)).toBe('in');
    expect(goalStatus({ carbs_g: 134, complete: true }, goal)).toBe('near');
  });

  it('sums past the per-window storage ceiling and still bands correctly (spec: dayGoal has no ceiling)', () => {
    const goal = dayGoal([
      window('W1', '05:00', { min: 150, max: 400 }),
      window('W2', '07:00', { min: 150, max: 400 }),
      window('W3', '09:00', { min: 150, max: 400 }),
      window('W4', '11:00', { min: 150, max: 400 }),
      window('W5', '13:00', { min: 150, max: 400 }),
      window('W6', '15:00', { min: 150, max: 400 }),
    ]);
    expect(goal).toEqual({ min: 900, max: 2400 });
    expect(goalStatus({ carbs_g: 2300, complete: true }, goal)).toBe('in');
  });
});

describe('plan row types', () => {
  it('describes a planned slot and its items', () => {
    const statuses: PlanStatus[] = ['planned', 'logged', 'skipped'];
    const entry: PlanEntryData = {
      id: 'pe1',
      date: '2026-09-17',
      window_name: 'Lunch',
      status: 'planned',
      note: null,
      log_entry_id: null,
    };
    const item: PlanItemData = {
      id: 'pi1',
      plan_entry_id: entry.id,
      ref_type: 'food',
      ref_id: 'f1',
      amount: 1,
      unit: 'g',
      position: 0,
    };
    expect(statuses).toContain(entry.status);
    expect(item.plan_entry_id).toBe('pe1');
  });
});
