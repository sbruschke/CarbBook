import { DOSE_LIMITS } from './dose';
import type { CarbGoal } from './types';

/**
 * A carb goal is usable when both bounds are finite and 0 <= min <= max <= DOSE_LIMITS.maxCarbsG.
 * `null`/`undefined` (no goal for that window) is not an error — it is simply not a goal.
 */
export function isValidCarbGoal(value: unknown): value is CarbGoal {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const { min, max } = value as { min?: unknown; max?: unknown };
  if (typeof min !== 'number' || !Number.isFinite(min)) return false;
  if (typeof max !== 'number' || !Number.isFinite(max)) return false;
  return min >= 0 && min <= max && max <= DOSE_LIMITS.maxCarbsG;
}
