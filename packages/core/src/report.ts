import { goalStatus, type GoalStatus } from './goal';
import { quickDisplayName } from './units';
import type { CarbGoal, LogItemData, RefType } from './types';

/**
 * The printable log report (log export spec 2026-10-07): a range of days, grouped and totalled.
 *
 * Everything locale- or timezone-shaped (which day an entry falls on, its time, the day headings)
 * is done by the platform before it gets here — the same split as `accountabilityText` — so both
 * cores produce the same numbers from `testdata/log-report-vectors.json`. Rendering the HTML is
 * platform work too; this is only the arithmetic.
 */
export interface ReportItemInput {
  name: string;
  /** Already formatted, e.g. "1 cup"; empty for a quick-carbs row (its amount IS its carbs). */
  amount: string;
  carbs_g: number;
}

export interface ReportEntryInput {
  id: string;
  /** Local day key "YYYY-MM-DD" the entry falls on, worked out by the platform. */
  day: string;
  eaten_at: number;
  /** Already formatted local time, e.g. "12:30 PM". */
  time: string;
  window_name: string | null;
  bg_mgdl: number | null;
  carbs_g: number;
  suggested_units: number | null;
  taken_units: number | null;
  notes: string | null;
  /** The goal of the window the entry was logged in, if it has one. */
  goal: CarbGoal | null;
  items: ReportItemInput[];
}

export interface ReportInput {
  /** Every day in the range, in order, as local day keys. Days with no entries still appear. */
  days: string[];
  entries: ReportEntryInput[];
}

export interface ReportEntry extends ReportEntryInput {
  goal_status: GoalStatus;
}

export interface ReportDay {
  day: string;
  entries: ReportEntry[];
  carbs_g: number;
  taken_units: number;
}

export interface ReportSummary {
  days: number;
  logged_days: number;
  entries: number;
  carbs_g: number;
  /** Per day that has at least one entry — an unlogged day is missing data, not a 0 g day. */
  avg_carbs_per_logged_day: number | null;
  taken_units: number;
  avg_taken_per_logged_day: number | null;
  bg_readings: number;
  avg_bg: number | null;
  min_bg: number | null;
  max_bg: number | null;
  /** Entries per goal band; `none` counts entries whose window has no goal. */
  goal_counts: Record<GoalStatus, number>;
}

export interface Report {
  days: ReportDay[];
  summary: ReportSummary;
}

const finite = (value: number | null): value is number => value !== null && Number.isFinite(value);

/**
 * Groups entries onto the range's days (entries on a day outside `days` are dropped), orders each
 * day by time, and totals. A non-finite carb or dose figure counts as nothing rather than poisoning
 * a total with NaN.
 */
export function buildLogReport(input: ReportInput): Report {
  const goal_counts: Record<GoalStatus, number> = { none: 0, in: 0, near: 0, off: 0, out: 0 };
  const bgs: number[] = [];
  const days = input.days.map((day): ReportDay => {
    const entries = input.entries
      .filter((e) => e.day === day)
      .sort((a, b) => a.eaten_at - b.eaten_at)
      .map((e): ReportEntry => ({ ...e, goal_status: goalStatus({ carbs_g: e.carbs_g, complete: true }, e.goal) }));
    for (const e of entries) {
      goal_counts[e.goal_status] += 1;
      if (finite(e.bg_mgdl)) bgs.push(e.bg_mgdl);
    }
    return {
      day,
      entries,
      carbs_g: entries.reduce((sum, e) => sum + (finite(e.carbs_g) ? e.carbs_g : 0), 0),
      taken_units: entries.reduce((sum, e) => sum + (finite(e.taken_units) ? e.taken_units : 0), 0),
    };
  });
  const logged = days.filter((d) => d.entries.length > 0);
  const carbs = logged.reduce((sum, d) => sum + d.carbs_g, 0);
  const taken = logged.reduce((sum, d) => sum + d.taken_units, 0);
  return {
    days,
    summary: {
      days: days.length,
      logged_days: logged.length,
      entries: logged.reduce((sum, d) => sum + d.entries.length, 0),
      carbs_g: carbs,
      avg_carbs_per_logged_day: logged.length > 0 ? carbs / logged.length : null,
      taken_units: taken,
      avg_taken_per_logged_day: logged.length > 0 ? taken / logged.length : null,
      bg_readings: bgs.length,
      avg_bg: bgs.length > 0 ? bgs.reduce((a, b) => a + b, 0) / bgs.length : null,
      min_bg: bgs.length > 0 ? Math.min(...bgs) : null,
      max_bg: bgs.length > 0 ? Math.max(...bgs) : null,
      goal_counts,
    },
  };
}

/**
 * One row on the in-app clipboard (log copy spec 2026-10-07): what a Calculator or plan-slot row
 * needs to be rebuilt, and nothing that belongs to the row it came from (no id, no carb snapshot —
 * pasted rows recompute their carbs from today's food data, like a loaded plan).
 */
export interface ClipItem {
  ref_type: RefType;
  ref_id: string;
  amount: number;
  unit: string;
  /** Quick-carbs rows only; null means the default label. */
  label: string | null;
}

/**
 * Clipboard rows for logged items. A quick row's only record of its label is its logged
 * `display_name`; when that is just the default name it goes back to "no label", so pasting does
 * not freeze the default wording into a real label.
 */
export function clipItemsFromLog(items: Pick<LogItemData, 'ref_type' | 'ref_id' | 'amount' | 'unit' | 'display_name'>[]): ClipItem[] {
  return items.map((item) => ({
    ref_type: item.ref_type,
    ref_id: item.ref_id,
    amount: item.amount,
    unit: item.unit,
    label: item.ref_type === 'quick' && item.display_name !== quickDisplayName(null) ? item.display_name : null,
  }));
}
