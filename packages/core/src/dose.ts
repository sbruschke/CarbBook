import type { CarbResult } from './carbs';
import type { CorrectionRule, DoseSettingsData, DoseWindow, RoundingRule } from './types';

const EPS = 1e-9;
const HOUR_MS = 3_600_000;

/**
 * Sanity limits for dose estimates. Values above these are refused rather than estimated:
 * inputs → `invalid_input`, settings → `invalid_settings`, raw units → `exceeds_limit`.
 * Mirrored as `DoseLimits` in the Swift core.
 */
export const DOSE_LIMITS = Object.freeze({
  maxCarbsG: 2000,
  maxBg: 1000,
  maxRatioGPerUnit: 1000,
  maxCorrectionThreshold: 1000,
  maxCorrectionStep: 1000,
  maxUnitsPerStep: 50,
  maxRoundingIncrement: 10,
  maxRoundDownBelowBg: 1000,
  /** Largest raw (meal + correction, before rounding) dose that is still estimated. */
  maxRawUnits: 50,
} as const);

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

/**
 * Rounds a raw dose to `rule.increment`. Pure: assumes `rule.increment > 0` (validated by
 * callers, e.g. `estimateDose`, before this is reached) — does not substitute a default.
 */
export function roundDose(raw: number, rule: RoundingRule, bg: number | null): { units: number; rounded_down: boolean } {
  const increment = rule.increment;
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
  | {
      ok: false;
      reason: 'no_window' | 'invalid_ratio' | 'incomplete_carbs' | 'invalid_input' | 'invalid_settings' | 'exceeds_limit';
      window: DoseWindow | null;
    };

const isFiniteNumber = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

function hasInvalidInput(input: DoseInput): boolean {
  if (!Number.isInteger(input.minutes) || input.minutes < 0 || input.minutes > 1439) return true;
  if (!isFiniteNumber(input.carbs.carbs_g) || input.carbs.carbs_g < 0 || input.carbs.carbs_g > DOSE_LIMITS.maxCarbsG) return true;
  if (input.bg != null && (!isFiniteNumber(input.bg) || input.bg < 0 || input.bg > DOSE_LIMITS.maxBg)) return true;
  return false;
}

const VALID_CORRECTION_MODES = new Set(['started', 'full', 'proportional']);

function hasInvalidSettings(settings: DoseSettingsData): boolean {
  const starts: number[] = [];
  for (const window of settings.windows) {
    let start: number;
    try {
      start = parseHHMM(window.start);
    } catch {
      return true;
    }
    if (starts.includes(start)) return true;
    starts.push(start);
    if (window.ratio_g_per_unit > DOSE_LIMITS.maxRatioGPerUnit) return true;
  }

  const correction = settings.correction;
  if (!isFiniteNumber(correction.threshold) || correction.threshold > DOSE_LIMITS.maxCorrectionThreshold) return true;
  if (!isFiniteNumber(correction.step) || correction.step <= 0 || correction.step > DOSE_LIMITS.maxCorrectionStep) return true;
  if (
    !isFiniteNumber(correction.units_per_step) ||
    correction.units_per_step < 0 ||
    correction.units_per_step > DOSE_LIMITS.maxUnitsPerStep
  )
    return true;
  if (!VALID_CORRECTION_MODES.has(correction.mode)) return true;

  const rounding = settings.rounding;
  if (!isFiniteNumber(rounding.increment) || rounding.increment <= 0 || rounding.increment > DOSE_LIMITS.maxRoundingIncrement)
    return true;
  if (
    rounding.round_down_below_bg != null &&
    (!isFiniteNumber(rounding.round_down_below_bg) || rounding.round_down_below_bg > DOSE_LIMITS.maxRoundDownBelowBg)
  )
    return true;

  return false;
}

export function estimateDose(input: DoseInput): DoseEstimate {
  if (hasInvalidInput(input)) return { ok: false, reason: 'invalid_input', window: null };
  if (hasInvalidSettings(input.settings)) return { ok: false, reason: 'invalid_settings', window: null };
  const window = pickWindow(input.settings.windows, input.minutes);
  if (!window) return { ok: false, reason: 'no_window', window: null };
  if (!(window.ratio_g_per_unit > 0)) return { ok: false, reason: 'invalid_ratio', window };
  if (!input.carbs.complete) return { ok: false, reason: 'incomplete_carbs', window };
  const mealUnits = input.carbs.carbs_g / window.ratio_g_per_unit;
  const correction = correctionUnits(input.settings.correction, input.bg);
  const raw = mealUnits + correction;
  if (raw > DOSE_LIMITS.maxRawUnits) return { ok: false, reason: 'exceeds_limit', window };
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

export function activeSettings<T extends Pick<DoseSettingsData, 'effective_from' | 'id'> & { deleted?: 0 | 1 }>(
  versions: T[],
  atMs: number,
): T | null {
  let best: T | null = null;
  for (const v of versions) {
    if (v.deleted === 1) continue;
    if (v.effective_from > atMs) continue;
    if (
      best === null ||
      v.effective_from > best.effective_from ||
      (v.effective_from === best.effective_from && v.id > best.id)
    ) {
      best = v;
    }
  }
  return best;
}

/** Warns near a logged dose in either time direction, including clock-skewed future timestamps. */
export function recentDoseWarning(lastDoseAtMs: number | null, nowMs: number, hours = 4): boolean {
  return lastDoseAtMs != null && nowMs - lastDoseAtMs < hours * HOUR_MS;
}
