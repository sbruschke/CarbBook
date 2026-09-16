import { type CarbGoal, type CarbResult, type GoalStatus, goalStatus } from '@carbbook/core';
import { formatCarbs } from '../ui/format';

/**
 * The words shown beside every goal number. Spec §3: colour is never the only signal, so each
 * state has a short label that is rendered visibly AND folded into the aria-label.
 *
 * Deliberately a separate vocabulary from core's `GOAL_STATUS_LABELS` ("in goal", "near goal", …):
 * that constant is not used anywhere in this web UI today, and these strings are worded for
 * conversational plan/log text rather than a terse screen-reader label. Both are keyed by the
 * same `GoalStatus`, and `goal.test.ts`'s shared-vectors case pins every `GOAL_WORDS[status]` to
 * being defined for each core-produced status — so the two can never disagree on WHICH band a
 * carbs/goal pair falls into, only on the words used to say so.
 */
export const GOAL_WORDS: Record<GoalStatus, string> = {
  none: '',
  in: 'on target',
  near: 'just outside',
  off: 'outside',
  out: 'far outside',
};

const trimGoal = (n: number): string => String(Number(n.toFixed(1)));

export interface GoalView {
  status: GoalStatus;
  /** CSS classes carrying the colour. Never the only signal — always rendered with `text`. */
  className: string;
  /** "68 g · goal 50–80" (en dash), or "68 g" with no goal, or "missing data …" when incomplete. */
  text: string;
  /** "on target" etc., or '' when there is no goal. Render this visibly next to `text`. */
  word: string;
  /** Screen-reader form: numbers spelled out with "to" and the status word. */
  ariaLabel: string;
}

/**
 * The ONE place carbs-against-a-goal are turned into something renderable. Plan cells, plan day
 * totals, the Calculator total and Log entries all go through this, so the four can never drift.
 * Banding itself is core's `goalStatus` — this function never re-implements the spec §3 formula.
 */
export function goalView(carbs: CarbResult, goal: CarbGoal | null): GoalView {
  const status = goalStatus(carbs, goal);
  const value = carbs.complete ? formatCarbs(carbs.carbs_g) : 'missing data';
  const range = goal ? `${trimGoal(goal.min)}–${trimGoal(goal.max)}` : null;
  const word = GOAL_WORDS[status];
  return {
    status,
    className: `goal goal-${status}`,
    text: range ? `${value} · goal ${range}` : value,
    word,
    ariaLabel: [value, range ? `goal ${trimGoal(goal!.min)} to ${trimGoal(goal!.max)}` : null, word || null]
      .filter(Boolean)
      .join(', '),
  };
}
