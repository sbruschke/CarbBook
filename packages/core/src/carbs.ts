import type { FoodData, Id, MealData, MealItemData, PortionData, RefType } from './types';
import {
  MASS_UNITS,
  PORTION_PREFIX,
  SERVING_UNIT,
  VOLUME_UNITS,
  densityOf,
  foodAmountToGrams,
  isMassUnit,
  isValidAmount,
  isValidCarbsPer100g,
  isValidCarbsPer100ml,
  isValidPortionCarbs,
  isVolumeUnit,
} from './units';

export interface Catalog {
  food(id: Id): FoodData | undefined;
  portions(foodId: Id): PortionData[];
  meal(id: Id): MealData | undefined;
  mealItems(mealId: Id): MealItemData[];
}

export interface CarbResult {
  carbs_g: number;
  complete: boolean;
}

const INCOMPLETE: CarbResult = { carbs_g: 0, complete: false };

function groupBy<T>(rows: T[], key: (row: T) => Id): Map<Id, T[]> {
  const map = new Map<Id, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = map.get(k);
    if (list) list.push(row);
    else map.set(k, [row]);
  }
  return map;
}

type Deletable<T> = T & { deleted?: 0 | 1 };

function notDeleted<T extends { deleted?: 0 | 1 }>(rows: T[]): T[] {
  return rows.filter((row) => row.deleted !== 1);
}

export function createCatalog(data: {
  foods?: Deletable<FoodData>[];
  portions?: Deletable<PortionData>[];
  meals?: Deletable<MealData>[];
  meal_items?: Deletable<MealItemData>[];
}): Catalog {
  const foods = new Map(notDeleted(data.foods ?? []).map((f) => [f.id, f]));
  const meals = new Map(notDeleted(data.meals ?? []).map((m) => [m.id, m]));
  const portions = groupBy(notDeleted(data.portions ?? []), (p) => p.food_id);
  const items = groupBy(notDeleted(data.meal_items ?? []), (i) => i.meal_id);
  for (const list of items.values()) list.sort((a, b) => a.position - b.position);
  return {
    food: (id) => foods.get(id),
    portions: (foodId) => portions.get(foodId) ?? [],
    meal: (id) => meals.get(id),
    mealItems: (mealId) => items.get(mealId) ?? [],
  };
}

/**
 * Fail closed (any-unit foods addendum): only an absent (null/undefined) basis may fall back to
 * another path. A present-but-invalid basis (out of range, negative, NaN) makes that unit family
 * incomplete. Keep foodUnits in units.ts in step with this.
 */

/** Mass path: carbs_per_100g if present; else carbs_per_100ml + density if present; else incomplete. */
function carbsForGrams(food: FoodData, portions: PortionData[], grams: number): CarbResult {
  if (food.carbs_per_100g != null) {
    return isValidCarbsPer100g(food.carbs_per_100g)
      ? { carbs_g: (grams * food.carbs_per_100g) / 100, complete: true }
      : INCOMPLETE;
  }
  if (food.carbs_per_100ml != null) {
    const density = densityOf(food, portions);
    if (!isValidCarbsPer100ml(food.carbs_per_100ml) || density === null) return INCOMPLETE;
    return { carbs_g: ((grams / density) * food.carbs_per_100ml) / 100, complete: true };
  }
  return INCOMPLETE;
}

function foodItemCarbs(catalog: Catalog, foodId: Id, amount: number, unit: string): CarbResult {
  const food = catalog.food(foodId);
  if (!food || !isValidAmount(amount)) return INCOMPLETE;
  const portions = catalog.portions(foodId);

  if (isVolumeUnit(unit)) {
    if (food.carbs_per_100ml != null) {
      return isValidCarbsPer100ml(food.carbs_per_100ml)
        ? { carbs_g: (amount * VOLUME_UNITS[unit] * food.carbs_per_100ml) / 100, complete: true }
        : INCOMPLETE;
    }
    // No per-100 ml basis: per-100 g + density only.
    const grams = foodAmountToGrams(amount, unit, food, portions);
    if (grams === null || food.carbs_per_100g == null || !isValidCarbsPer100g(food.carbs_per_100g)) return INCOMPLETE;
    return { carbs_g: (grams * food.carbs_per_100g) / 100, complete: true };
  }

  if (unit.startsWith(PORTION_PREFIX)) {
    const portionId = unit.slice(PORTION_PREFIX.length);
    const portion = portions.find((p) => p.id === portionId);
    if (portion == null) return INCOMPLETE;
    // carbs_g is ignored on volume portions (they only carry a weight).
    if (portion.kind !== 'volume' && portion.carbs_g != null) {
      const quantityOk = Number.isFinite(portion.quantity) && portion.quantity > 0;
      return isValidPortionCarbs(portion.carbs_g) && quantityOk
        ? { carbs_g: (amount / portion.quantity) * portion.carbs_g, complete: true }
        : INCOMPLETE;
    }
  }

  // Mass units and portions without carbs_g go through a known weight.
  const grams = foodAmountToGrams(amount, unit, food, portions);
  if (grams === null) return INCOMPLETE;
  return carbsForGrams(food, portions, grams);
}

function mealTotalCarbs(catalog: Catalog, mealId: Id, visiting: Set<Id>): CarbResult {
  if (visiting.has(mealId) || !catalog.meal(mealId)) return INCOMPLETE;
  visiting.add(mealId);
  const mealItems = catalog.mealItems(mealId);
  const total =
    mealItems.length === 0
      ? INCOMPLETE
      : sumCarbs(mealItems.map((item) => resolveItem(catalog, item.ref_type, item.ref_id, item.amount, item.unit, visiting)));
  visiting.delete(mealId);
  return total;
}

function mealItemCarbs(catalog: Catalog, mealId: Id, amount: number, unit: string, visiting: Set<Id>): CarbResult {
  const meal = catalog.meal(mealId);
  if (!meal || !Number.isFinite(amount) || amount < 0) return INCOMPLETE;
  let factor: number | null = null;
  if (unit === SERVING_UNIT && Number.isFinite(meal.yield_servings) && meal.yield_servings > 0) {
    factor = amount / meal.yield_servings;
  } else if (
    isMassUnit(unit) &&
    meal.total_weight_g != null &&
    Number.isFinite(meal.total_weight_g) &&
    meal.total_weight_g > 0
  ) {
    factor = (amount * MASS_UNITS[unit]) / meal.total_weight_g;
  }
  if (factor === null) return INCOMPLETE;
  const total = mealTotalCarbs(catalog, mealId, visiting);
  return { carbs_g: total.carbs_g * factor, complete: total.complete };
}

function resolveItem(
  catalog: Catalog,
  refType: RefType,
  refId: Id,
  amount: number,
  unit: string,
  visiting: Set<Id>,
): CarbResult {
  return refType === 'food'
    ? foodItemCarbs(catalog, refId, amount, unit)
    : mealItemCarbs(catalog, refId, amount, unit, visiting);
}

/** Carbs for one line item (a food or a meal) at the given amount and unit. */
export function itemCarbs(catalog: Catalog, refType: RefType, refId: Id, amount: number, unit: string): CarbResult {
  return resolveItem(catalog, refType, refId, amount, unit, new Set());
}

export function sumCarbs(results: CarbResult[]): CarbResult {
  return results.reduce<CarbResult>(
    (acc, r) => ({ carbs_g: acc.carbs_g + r.carbs_g, complete: acc.complete && r.complete }),
    { carbs_g: 0, complete: true },
  );
}

/** True if adding `candidateMealId` as a component of `mealId` would make a meal contain itself. */
export function wouldCreateCycle(catalog: Catalog, mealId: Id, candidateMealId: Id): boolean {
  if (candidateMealId === mealId) return true;
  const stack: Id[] = [candidateMealId];
  const seen = new Set<Id>();
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const item of catalog.mealItems(current)) {
      if (item.ref_type !== 'meal') continue;
      if (item.ref_id === mealId) return true;
      stack.push(item.ref_id);
    }
  }
  return false;
}
