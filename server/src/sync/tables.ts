import {
  DOSE_LIMITS,
  isValidCarbGoal,
  isVolumeUnit,
  MAX_CARBS_PER_100ML,
  MAX_PORTION_CARBS_G,
  parseHHMM,
  VOLUME_UNITS,
} from '@carbbook/core';

export const SYNC_TABLES = [
  'food',
  'portion',
  'barcode',
  'meal',
  'meal_item',
  'log_entry',
  'log_item',
  'dose_settings',
  'plan_entry',
  'plan_item',
] as const;

export type SyncTable = (typeof SYNC_TABLES)[number];

export type FieldSpec =
  | { type: 'text'; nullable?: boolean; max?: number; trim?: boolean }
  | { type: 'number'; nullable?: boolean; min?: number; max?: number; positive?: boolean; integer?: boolean }
  | { type: 'enum'; values: readonly string[] }
  | { type: 'json'; check: (value: unknown) => string | null; canonicalize?: (value: unknown) => unknown };

export interface TableSpec {
  name: SyncTable;
  /** Data columns in schema order, excluding id and sync metadata. */
  fields: Record<string, FieldSpec>;
  /** Only the owner may write (spec §7: viewers cannot change dose settings). */
  ownerOnly?: boolean;
  /** Cross-field rule run after every field is valid. */
  check?: (record: Record<string, unknown>) => string | null;
}

export const META_COLUMNS = ['updated_at', 'updated_by', 'deleted', 'server_seq'] as const;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

export function checkWindows(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 24) {
    return 'windows must be an array of 1-24 windows';
  }
  const starts = new Set<number>();
  for (const window of value) {
    if (!isObject(window) || typeof window.name !== 'string' || window.name.trim() === '') {
      return 'every window needs a name';
    }
    let minutes: number;
    try {
      minutes = parseHHMM(String(window.start));
    } catch {
      return `window "${window.name}" has invalid start "${String(window.start)}"`;
    }
    if (starts.has(minutes)) return `duplicate window start ${String(window.start)}`;
    starts.add(minutes);
    if (!isFiniteNumber(window.ratio_g_per_unit) || window.ratio_g_per_unit <= 0) {
      return `window "${window.name}" needs ratio_g_per_unit > 0`;
    }
    // carb_goal is optional (meal-planning spec §2): absent or null means "no goal".
    if (window.carb_goal != null && !isValidCarbGoal(window.carb_goal)) {
      return `window "${window.name}" has an invalid carb_goal (need 0 <= min <= max <= ${DOSE_LIMITS.maxCarbsG})`;
    }
  }
  return null;
}

export function checkCorrection(value: unknown): string | null {
  if (!isObject(value)) return 'correction must be an object';
  if (!isFiniteNumber(value.threshold) || value.threshold < 0) return 'correction.threshold must be >= 0';
  if (!isFiniteNumber(value.step) || value.step <= 0) return 'correction.step must be > 0';
  if (!isFiniteNumber(value.units_per_step) || value.units_per_step < 0) return 'correction.units_per_step must be >= 0';
  if (!['started', 'full', 'proportional'].includes(value.mode as string)) {
    return 'correction.mode must be started, full or proportional';
  }
  return null;
}

export function checkRounding(value: unknown): string | null {
  if (!isObject(value)) return 'rounding must be an object';
  if (!isFiniteNumber(value.increment) || value.increment <= 0) return 'rounding.increment must be > 0';
  const below = value.round_down_below_bg;
  if (below !== null && (!isFiniteNumber(below) || below < 0)) {
    return 'rounding.round_down_below_bg must be null or >= 0';
  }
  return null;
}

/** Rebuilds an object with only the given keys, in the given order, dropping any others. */
function reorderKeys(value: unknown, keys: readonly string[]): unknown {
  if (!isObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of keys) if (key in value) out[key] = value[key];
  return out;
}

/**
 * Canonicalizers for dose_settings JSON fields: fixed key order so two pushes with the same
 * content but different key ordering serialize identically (see push.ts's append-only check).
 */
const canonicalizeCarbGoal = (value: unknown): unknown => (value == null ? value : reorderKeys(value, ['min', 'max']));

export const canonicalizeWindows = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map((w) => {
        const out = reorderKeys(w, ['name', 'start', 'ratio_g_per_unit', 'carb_goal']) as Record<string, unknown>;
        if ('carb_goal' in out) out.carb_goal = canonicalizeCarbGoal(out.carb_goal);
        return out;
      })
    : value;
export const canonicalizeCorrection = (value: unknown): unknown =>
  reorderKeys(value, ['threshold', 'step', 'units_per_step', 'mode']);
export const canonicalizeRounding = (value: unknown): unknown =>
  reorderKeys(value, ['increment', 'round_down_below_bg']);

const text = (max = 200): FieldSpec => ({ type: 'text', max });
const optionalText = (max = 200): FieldSpec => ({ type: 'text', nullable: true, max });
/**
 * meal_item.ref_id and log_item.ref_id point at food/meal rows but are not enforced as foreign
 * keys here: offline-first clients may push a child (e.g. a meal_item) before its parent syncs,
 * and the server must not reject a valid, merely out-of-order push. Core's catalog builder treats
 * a dangling reference as incomplete carbs data rather than an error, which is the safe default —
 * once the parent arrives on a later push, the reference resolves normally.
 */
const REF_TYPES = ['food', 'meal'] as const;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** True for a real calendar day written as YYYY-MM-DD (so "2026-02-30" is rejected). */
export function isValidPlanDate(value: unknown): boolean {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export const TABLE_SPECS: Record<SyncTable, TableSpec> = {
  food: {
    name: 'food',
    fields: {
      name: text(),
      brand: optionalText(),
      source: { type: 'enum', values: ['usda', 'off', 'custom'] },
      source_ref: optionalText(64),
      derived_from: optionalText(64),
      carbs_per_100g: { type: 'number', nullable: true, min: 0, max: 100 },
      carbs_per_100ml: { type: 'number', nullable: true, min: 0, max: MAX_CARBS_PER_100ML },
      fiber_per_100g: { type: 'number', nullable: true, min: 0, max: 100 },
      density_g_per_ml: { type: 'number', nullable: true, positive: true },
      notes: optionalText(4000),
    },
  },
  portion: {
    name: 'portion',
    fields: {
      food_id: text(64),
      label: text(),
      kind: { type: 'enum', values: ['volume', 'count', 'serving'] },
      quantity: { type: 'number', positive: true },
      grams: { type: 'number', nullable: true, positive: true },
      carbs_g: { type: 'number', nullable: true, min: 0, max: MAX_PORTION_CARBS_G },
    },
    check: (r) => {
      if (r.kind === 'volume' && !isVolumeUnit(String(r.label))) {
        return `volume portion label must be one of ${Object.keys(VOLUME_UNITS).join(', ')}`;
      }
      if (r.grams == null && r.carbs_g == null) return 'portion must have grams or carbs_g';
      if (r.kind === 'volume' && r.grams == null) return 'volume portions require grams';
      // Volume portions only carry a weight (density); their carbs come from the food's bases.
      if (r.kind === 'volume' && r.carbs_g != null) return 'volume portions cannot have carbs_g';
      return null;
    },
  },
  barcode: {
    name: 'barcode',
    fields: { code: text(32), food_id: text(64) },
  },
  meal: {
    name: 'meal',
    fields: {
      name: text(),
      yield_servings: { type: 'number', positive: true },
      total_weight_g: { type: 'number', nullable: true, positive: true },
      notes: optionalText(4000),
    },
  },
  meal_item: {
    name: 'meal_item',
    fields: {
      meal_id: text(64),
      ref_type: { type: 'enum', values: REF_TYPES },
      ref_id: text(64),
      amount: { type: 'number', min: 0 },
      unit: text(64),
      position: { type: 'number', integer: true, min: 0 },
    },
  },
  log_entry: {
    name: 'log_entry',
    fields: {
      eaten_at: { type: 'number', integer: true, min: 0 },
      window_name: optionalText(),
      bg_mgdl: { type: 'number', nullable: true, min: 0 },
      bg_source: { type: 'enum', values: ['dexcom', 'manual', 'none'] },
      bg_trend: optionalText(64),
      total_carbs_g: { type: 'number', min: 0 },
      suggested_units: { type: 'number', nullable: true, min: 0 },
      taken_units: { type: 'number', nullable: true, min: 0 },
      settings_version_id: optionalText(64),
      notes: optionalText(4000),
    },
  },
  log_item: {
    name: 'log_item',
    fields: {
      log_entry_id: text(64),
      ref_type: { type: 'enum', values: REF_TYPES },
      ref_id: text(64),
      display_name: text(),
      amount: { type: 'number', min: 0 },
      unit: text(64),
      carbs_g: { type: 'number', min: 0 },
    },
  },
  dose_settings: {
    name: 'dose_settings',
    ownerOnly: true,
    fields: {
      effective_from: { type: 'number', integer: true, min: 0 },
      windows: { type: 'json', check: checkWindows, canonicalize: canonicalizeWindows },
      correction: { type: 'json', check: checkCorrection, canonicalize: canonicalizeCorrection },
      rounding: { type: 'json', check: checkRounding, canonicalize: canonicalizeRounding },
    },
  },
  plan_entry: {
    name: 'plan_entry',
    fields: {
      date: text(10),
      // Trimmed so "Lunch", "lunch " etc. reliably collide with the case-insensitive slot-uniqueness
      // check below (validate.ts trims, push.ts's duplicateSlot and the DB index compare NOCASE);
      // the original casing is kept as the stored text, only leading/trailing whitespace is dropped.
      window_name: { type: 'text', max: 64, trim: true },
      status: { type: 'enum', values: ['planned', 'logged', 'skipped'] },
      note: optionalText(4000),
      // Checked against the log_entry table in push.ts, where the DB is available.
      log_entry_id: optionalText(64),
    },
    check: (r) => (isValidPlanDate(r.date) ? null : 'date must be a real calendar date in YYYY-MM-DD form'),
  },
  plan_item: {
    name: 'plan_item',
    fields: {
      plan_entry_id: text(64),
      ref_type: { type: 'enum', values: REF_TYPES },
      ref_id: text(64),
      amount: { type: 'number', min: 0 },
      unit: text(64),
      position: { type: 'number', integer: true, min: 0 },
    },
  },
};

export function isSyncTable(name: unknown): name is SyncTable {
  return typeof name === 'string' && (SYNC_TABLES as readonly string[]).includes(name);
}

export function columnsOf(spec: TableSpec): string[] {
  return ['id', ...Object.keys(spec.fields), ...META_COLUMNS];
}
