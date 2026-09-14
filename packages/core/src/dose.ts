import type { CarbResult } from './carbs';
import type { CorrectionRule, DoseSettingsData, DoseWindow, RoundingRule } from './types';

const EPS = 1e-9;
const HOUR_MS = 3_600_000;

export function parseHHMM(value: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error(`Invalid time "${value}", expected HH:MM`);
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) throw new Error(`Invalid time "${value}"`);
  return hours * 60 + minutes;
}

export function minutesOfDay(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

export function pickWindow(windows: DoseWindow[], minutes: number): DoseWindow | null {
  if (windows.length === 0) return null;
  const sorted = [...windows].sort((a, b) => parseHHMM(a.start) - parseHHMM(b.start));
  let chosen = sorted[sorted.length - 1]!; // before the first start → previous day's last window
  for (const window of sorted) {
    if (parseHHMM(window.start) <= minutes) chosen = window;
  }
  return chosen;
}

export function correctionUnits(rule: CorrectionRule, bg: number | null): number {
  if (bg == null || bg <= rule.threshold || rule.step <= 0) return 0;
  const steps = (bg - rule.threshold) / rule.step;
  switch (rule.mode) {
    case 'started':
      return Math.ceil(steps - EPS) * rule.units_per_step;
    case 'full':
      return Math.floor(steps + EPS) * rule.units_per_step;
    case 'proportional':
      return steps * rule.units_per_step;
  }
}

export function roundDose(raw: number, rule: RoundingRule, bg: number | null): { units: number; rounded_down: boolean } {
  const increment = rule.increment > 0 ? rule.increment : 1;
  const roundedDown = bg != null && rule.round_down_below_bg != null && bg < rule.round_down_below_bg;
  const steps = roundedDown ? Math.floor(raw / increment + EPS) : Math.floor(raw / increment + 0.5 + EPS);
  return { units: Number((steps * increment).toFixed(4)), rounded_down: roundedDown };
}

export interface DoseInput {
  settings: DoseSettingsData;
  /** Minutes since local midnight when the food is eaten. */
  minutes: number;
  carbs: CarbResult;
  bg: number | null;
}

export type DoseEstimate =
  | {
      ok: true;
      window: DoseWindow;
      carbs_g: number;
      bg: number | null;
      meal_units: number;
      correction_units: number;
      raw_units: number;
      units: number;
      rounded_down: boolean;
      round_down_below_bg: number | null;
    }
  | { ok: false; reason: 'no_window' | 'invalid_ratio' | 'incomplete_carbs'; window: DoseWindow | null };

export function estimateDose(input: DoseInput): DoseEstimate {
  const window = pickWindow(input.settings.windows, input.minutes);
  if (!window) return { ok: false, reason: 'no_window', window: null };
  if (!(window.ratio_g_per_unit > 0)) return { ok: false, reason: 'invalid_ratio', window };
  if (!input.carbs.complete) return { ok: false, reason: 'incomplete_carbs', window };
  const mealUnits = input.carbs.carbs_g / window.ratio_g_per_unit;
  const correction = correctionUnits(input.settings.correction, input.bg);
  const raw = mealUnits + correction;
  const { units, rounded_down } = roundDose(raw, input.settings.rounding, input.bg);
  return {
    ok: true,
    window,
    carbs_g: input.carbs.carbs_g,
    bg: input.bg,
    meal_units: mealUnits,
    correction_units: correction,
    raw_units: raw,
    units,
    rounded_down,
    round_down_below_bg: input.settings.rounding.round_down_below_bg,
  };
}

const trim = (n: number, digits: number) => String(Number(n.toFixed(digits)));

/** e.g. "72g ÷ 8 = 9.0 + BG 263 → 2u = 11.0 → 11u". Shared format with the iOS app. */
export function formatBreakdown(estimate: Extract<DoseEstimate, { ok: true }>): string {
  const e = estimate;
  let text = `${trim(e.carbs_g, 1)}g ÷ ${trim(e.window.ratio_g_per_unit, 2)} = ${e.meal_units.toFixed(1)}`;
  if (e.bg != null) {
    text += ` + BG ${trim(e.bg, 0)} → ${trim(e.correction_units, 2)}u = ${e.raw_units.toFixed(1)}`;
  }
  text += ` → ${trim(e.units, 2)}u`;
  if (e.rounded_down) text += ` (rounded down: BG under ${e.round_down_below_bg})`;
  return text;
}

export function activeSettings<T extends Pick<DoseSettingsData, 'effective_from'>>(versions: T[], atMs: number): T | null {
  let best: T | null = null;
  for (const v of versions) {
    if (v.effective_from <= atMs && (best === null || v.effective_from > best.effective_from)) best = v;
  }
  return best;
}

export function recentDoseWarning(lastDoseAtMs: number | null, nowMs: number, hours = 4): boolean {
  return lastDoseAtMs != null && nowMs - lastDoseAtMs >= 0 && nowMs - lastDoseAtMs < hours * HOUR_MS;
}
