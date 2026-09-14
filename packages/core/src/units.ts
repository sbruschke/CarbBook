import type { FoodData, MealData, PortionData } from './types';

/** Grams per unit. */
export const MASS_UNITS = { g: 1, kg: 1000, oz: 28.349523125, lb: 453.59237 } as const;
/** Millilitres per unit (US customary). */
export const VOLUME_UNITS = {
  ml: 1,
  l: 1000,
  tsp: 4.92892159375,
  tbsp: 14.78676478125,
  floz: 29.5735295625,
  cup: 236.5882365,
} as const;

export type MassUnit = keyof typeof MASS_UNITS;
export type VolumeUnit = keyof typeof VOLUME_UNITS;

export const SERVING_UNIT = 'serving';
export const PORTION_PREFIX = 'p:';

export function isMassUnit(unit: string): unit is MassUnit {
  return Object.hasOwn(MASS_UNITS, unit);
}

export function isVolumeUnit(unit: string): unit is VolumeUnit {
  return Object.hasOwn(VOLUME_UNITS, unit);
}

/** Upper bounds shared by core math and server/web validation. */
export const MAX_CARBS_PER_100G = 100;
export const MAX_CARBS_PER_100ML = 150;
export const MAX_PORTION_CARBS_G = 500;

export function isValidAmount(amount: number): boolean {
  return Number.isFinite(amount) && amount >= 0;
}

function inRange(value: number | null | undefined, max: number): value is number {
  return value != null && Number.isFinite(value) && value >= 0 && value <= max;
}

export function isValidCarbsPer100g(value: number | null | undefined): value is number {
  return inRange(value, MAX_CARBS_PER_100G);
}

export function isValidCarbsPer100ml(value: number | null | undefined): value is number {
  return inRange(value, MAX_CARBS_PER_100ML);
}

export function isValidPortionCarbs(value: number | null | undefined): value is number {
  return inRange(value, MAX_PORTION_CARBS_G);
}

export function isValidPortionGrams(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value) && value > 0;
}

function isValidQuantity(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

export function densityOf(food: FoodData, portions: PortionData[]): number | null {
  if (food.density_g_per_ml != null && Number.isFinite(food.density_g_per_ml) && food.density_g_per_ml > 0) {
    return food.density_g_per_ml;
  }
  let best: { id: string; density: number } | null = null;
  for (const p of portions) {
    if (
      p.kind === 'volume' &&
      isVolumeUnit(p.label) &&
      isValidQuantity(p.quantity) &&
      isValidPortionGrams(p.grams) &&
      (best === null || p.id < best.id)
    ) {
      best = { id: p.id, density: p.grams / (p.quantity * VOLUME_UNITS[p.label]) };
    }
  }
  return best ? best.density : null;
}

/**
 * Units a food can be entered in. Fail closed (any-unit foods addendum): a carb basis that is
 * present but invalid hides its unit family instead of falling back to another basis; only an
 * absent (null/undefined) basis falls through. Mirrors foodItemCarbs in carbs.ts.
 */
export function foodUnits(food: FoodData, portions: PortionData[]): string[] {
  const density = densityOf(food, portions);
  const gPresent = food.carbs_per_100g != null;
  const mlPresent = food.carbs_per_100ml != null;
  const validG = isValidCarbsPer100g(food.carbs_per_100g);
  const validMl = isValidCarbsPer100ml(food.carbs_per_100ml);
  // carbs_g on a volume portion is ignored everywhere.
  const pieceCarbs = portions.filter((p) => p.kind !== 'volume' && p.carbs_g != null);
  const hasValidPieceBasis = pieceCarbs.some((p) => isValidPortionCarbs(p.carbs_g));
  // Mass: per-100 g if present; else per-100 ml + density if present; else (no basis) a placeholder
  // list, unless a valid portion carb basis makes the food portion-only.
  const massListed = gPresent ? validG : mlPresent ? validMl && density !== null : !hasValidPieceBasis;
  // Volume: per-100 ml if present; else convertible via density, unless per-100 g is present but invalid.
  const volumeListed = mlPresent ? validMl : density !== null && (!gPresent || validG);
  const units: string[] = [];
  if (massListed) units.push(...Object.keys(MASS_UNITS));
  if (volumeListed) units.push(...Object.keys(VOLUME_UNITS));
  for (const p of portions) {
    if (p.kind === 'volume') continue;
    const listed = p.carbs_g != null ? isValidPortionCarbs(p.carbs_g) : isValidPortionGrams(p.grams) && massListed;
    if (listed) units.push(PORTION_PREFIX + p.id);
  }
  return units;
}

export function mealUnits(meal: MealData): string[] {
  const hasWeight = meal.total_weight_g != null && meal.total_weight_g > 0;
  return hasWeight ? [SERVING_UNIT, ...Object.keys(MASS_UNITS)] : [SERVING_UNIT];
}

export function foodAmountToGrams(
  amount: number,
  unit: string,
  food: FoodData,
  portions: PortionData[],
): number | null {
  if (!isValidAmount(amount)) return null;
  if (isMassUnit(unit)) return amount * MASS_UNITS[unit];
  if (isVolumeUnit(unit)) {
    const density = densityOf(food, portions);
    return density === null ? null : amount * VOLUME_UNITS[unit] * density;
  }
  if (unit.startsWith(PORTION_PREFIX)) {
    const portionId = unit.slice(PORTION_PREFIX.length);
    const portion = portions.find((p) => p.id === portionId);
    if (portion == null || !isValidPortionGrams(portion.grams) || !isValidQuantity(portion.quantity)) return null;
    return (amount * portion.grams) / portion.quantity;
  }
  return null;
}
