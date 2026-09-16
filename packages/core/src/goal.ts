import type { CarbResult } from './carbs';
import { DOSE_LIMITS } from './dose';
import type { CarbGoal, DoseWindow } from './types';

/**
 * A range is usable — a finite, non-inverted, non-negative {min, max} — with no upper ceiling.
 * `dayGoal` sums per-window goals, so a day's combined range can legitimately exceed the
 * per-window storage ceiling; this is what `goalStatus`/`dayGoal` check, not `isValidCarbGoal`.
 */
function isUsableRange(value: unknown): value is CarbGoal {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const { min, max } = value as { min?: unknown; max?: unknown };
  if (typeof min !== 'number' || !Number.isFinite(min)) return false;
  if (typeof max !== 'number' || !Number.isFinite(max)) return false;
  return min >= 0 && min <= max;
}

/**
 * A carb goal is valid for storage/push when both bounds are finite and
 * 0 <= min <= max <= DOSE_LIMITS.maxCarbsG. `null`/`undefined` (no goal for that window) is not an
 * error — it is simply not a goal. This ceiling applies to a single window's goal only; see
 * `isUsableRange` for the day-level check with no ceiling.
 */
export function isValidCarbGoal(value: unknown): value is CarbGoal {
  return isUsableRange(value) && value.max <= DOSE_LIMITS.maxCarbsG;
}

export type GoalStatus = 'none' | 'in' | 'near' | 'off' | 'out';

/** Distance bands from spec §3: within 5 g is yellow, within 10 g is orange, beyond is red. */
export const GOAL_NEAR_G = 5;
export const GOAL_OFF_G = 10;

/** Short labels for screen readers; the UI shows numbers too — colour is never the only signal. */
export const GOAL_STATUS_LABELS: Readonly<Record<GoalStatus, string>> = Object.freeze({
  none: 'no goal',
  in: 'in goal',
  near: 'near goal',
  off: 'off goal',
  out: 'outside goal',
});

/** Colour band for a carb total against one window's (or a day's) usable range (spec §3). */
export function goalStatus(carbs: CarbResult, goal: CarbGoal | null | undefined): GoalStatus {
  if (!isUsableRange(goal)) return 'none';
  if (!carbs.complete || !Number.isFinite(carbs.carbs_g)) return 'none';
  const value = carbs.carbs_g;
  if (value >= goal.min && value <= goal.max) return 'in';
  // Round to kill binary-rounding noise (e.g. 44.999999999) so both edges of a band land the same
  // way a value written as 5.0 or 10.0 would, rather than one band out depending on which side of
  // the goal the value falls.
  const distance = Number(Math.min(Math.abs(value - goal.min), Math.abs(value - goal.max)).toFixed(6));
  if (distance <= GOAL_NEAR_G) return 'near';
  if (distance <= GOAL_OFF_G) return 'off';
  return 'out';
}

/**
 * A day's combined goal: the sum of the goals of the day's windows. Windows without a usable goal
 * contribute nothing to either bound; a day where no window has a goal has no goal at all (null),
 * which `goalStatus` renders as `none` (spec §3).
 */
export function dayGoal(windows: DoseWindow[]): CarbGoal | null {
  let min = 0;
  let max = 0;
  let found = false;
  for (const w of windows) {
    const goal = w.carb_goal;
    if (!isUsableRange(goal)) continue;
    min += goal.min;
    max += goal.max;
    found = true;
  }
  return found ? { min, max } : null;
}
