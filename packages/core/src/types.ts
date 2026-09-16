export type Id = string;

/** Fields every synced row carries (spec §3). */
export interface SyncMeta {
  updated_at: number; // ms since epoch, client clock
  updated_by: string; // device id
  deleted: 0 | 1;
  server_seq?: number; // assigned by the server on accept
}

export type Synced<T> = T & SyncMeta;

export type FoodSource = 'usda' | 'off' | 'custom';

export interface FoodData {
  id: Id;
  name: string;
  brand?: string | null;
  source?: FoodSource;
  source_ref?: string | null;
  derived_from?: Id | null;
  carbs_per_100g: number | null;
  /** Volume carb basis (any-unit foods addendum). Valid when finite 0..150. */
  carbs_per_100ml?: number | null;
  fiber_per_100g?: number | null;
  density_g_per_ml?: number | null;
  notes?: string | null;
}

export type PortionKind = 'volume' | 'count' | 'serving';

export interface PortionData {
  id: Id;
  food_id: Id;
  /** For kind "volume" this must be a volume unit id (e.g. "cup"); otherwise free text ("slice"). */
  label: string;
  kind: PortionKind;
  quantity: number;
  /** Weight of `quantity` portions; null when unknown. Valid when finite > 0. */
  grams: number | null;
  /** Carbs for `quantity` portions; null when unknown. Valid when finite 0..500. */
  carbs_g?: number | null;
}

export interface BarcodeData {
  id: Id;
  code: string;
  food_id: Id;
}

export interface MealData {
  id: Id;
  name: string;
  yield_servings: number;
  total_weight_g?: number | null;
  notes?: string | null;
}

/** `quick` = a carbs-only row with no food (quick-carbs spec §2): amount is grams of carbs, unit `carbs`. */
export type RefType = 'food' | 'meal' | 'quick';

export interface MealItemData {
  id: Id;
  meal_id: Id;
  ref_type: RefType;
  ref_id: Id;
  amount: number;
  unit: string;
  position: number;
  /** Quick carbs rows only (quick-carbs spec §2): optional text, at most 80 characters. */
  label?: string | null;
}

export type BgSource = 'dexcom' | 'manual' | 'none';

export interface LogEntryData {
  id: Id;
  eaten_at: number;
  window_name: string | null;
  bg_mgdl: number | null;
  bg_source: BgSource;
  bg_trend?: string | null;
  total_carbs_g: number;
  suggested_units: number | null;
  taken_units: number | null;
  settings_version_id: Id | null;
  notes?: string | null;
}

export interface LogItemData {
  id: Id;
  log_entry_id: Id;
  ref_type: RefType;
  ref_id: Id;
  display_name: string;
  amount: number;
  unit: string;
  carbs_g: number;
}

/** Per-window carb target (meal-planning spec §2). Both bounds finite, 0 <= min <= max <= 2000. */
export interface CarbGoal {
  min: number;
  max: number;
}

export interface DoseWindow {
  name: string;
  start: string; // "HH:MM", 24-hour local time
  ratio_g_per_unit: number;
  /**
   * Per-window carb target for the Plan screen's colour feedback (meal-planning spec §2).
   * Dose math never reads this: estimateDose only uses name/start/ratio_g_per_unit.
   */
  carb_goal?: CarbGoal | null;
}

export type CorrectionMode = 'started' | 'full' | 'proportional';

export interface CorrectionRule {
  threshold: number;
  step: number;
  units_per_step: number;
  mode: CorrectionMode;
}

export interface RoundingRule {
  increment: number;
  round_down_below_bg: number | null;
}

export interface DoseSettingsData {
  id: Id;
  effective_from: number; // ms since epoch
  windows: DoseWindow[];
  correction: CorrectionRule;
  rounding: RoundingRule;
}

export type PlanStatus = 'planned' | 'logged' | 'skipped';

/** One planned meal slot (meal-planning spec §2). At most one non-deleted row per date+window. */
export interface PlanEntryData {
  id: Id;
  /** Local calendar day, "YYYY-MM-DD". */
  date: string;
  /** Matches a dose-settings window name. */
  window_name: string;
  status: PlanStatus;
  note?: string | null;
  /** Set when this slot was logged from the Calculator; cleared if that log entry is deleted. */
  log_entry_id?: Id | null;
}

/** A row inside a planned slot: same shape as log_item minus the snapshot fields. */
export interface PlanItemData {
  id: Id;
  plan_entry_id: Id;
  ref_type: RefType;
  ref_id: Id;
  amount: number;
  unit: string;
  position: number;
  /** Quick carbs rows only (quick-carbs spec §2): optional text, at most 80 characters. */
  label?: string | null;
}
