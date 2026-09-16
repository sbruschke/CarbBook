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
