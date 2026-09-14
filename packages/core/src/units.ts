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

function isValidAmount(amount: number): boolean {
  return Number.isFinite(amount) && amount >= 0;
}

export function densityOf(food: FoodData, portions: PortionData[]): number | null {
  if (food.density_g_per_ml != null && Number.isFinite(food.density_g_per_ml) && food.density_g_per_ml > 0) {
    return food.density_g_per_ml;
  }
  let best: PortionData | null = null;
  for (const p of portions) {
    if (
      p.kind === 'volume' &&
      isVolumeUnit(p.label) &&
      Number.isFinite(p.quantity) &&
      p.quantity > 0 &&
      Number.isFinite(p.grams) &&
      p.grams > 0 &&
      (best === null || p.id < best.id)
    ) {
      best = p;
    }
  }
  return best ? best.grams / (best.quantity * VOLUME_UNITS[best.label as VolumeUnit]) : null;
}

export function foodUnits(food: FoodData, portions: PortionData[]): string[] {
  const units: string[] = Object.keys(MASS_UNITS);
  if (densityOf(food, portions) !== null) units.push(...Object.keys(VOLUME_UNITS));
  for (const p of portions) {
    if (p.kind !== 'volume') units.push(PORTION_PREFIX + p.id);
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
    const validPortion =
      portion != null &&
      Number.isFinite(portion.grams) &&
      portion.grams > 0 &&
      Number.isFinite(portion.quantity) &&
      portion.quantity > 0;
    return validPortion ? (amount * portion.grams) / portion.quantity : null;
  }
  return null;
}
