import { describe, expect, it } from 'vitest';
import { isValidCarbGoal } from '../src/goal';

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
});

import { GOAL_STATUS_LABELS, goalStatus } from '../src/goal';

const complete = (carbs_g: number) => ({ carbs_g, complete: true });
const GOAL = { min: 50, max: 80 };

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
});
