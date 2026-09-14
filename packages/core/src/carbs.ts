import type { FoodData, Id, MealData, MealItemData, PortionData, RefType } from './types';
import { MASS_UNITS, SERVING_UNIT, foodAmountToGrams, isMassUnit } from './units';

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

export function createCatalog(data: {
  foods?: FoodData[];
  portions?: PortionData[];
  meals?: MealData[];
  meal_items?: MealItemData[];
}): Catalog {
  const foods = new Map((data.foods ?? []).map((f) => [f.id, f]));
  const meals = new Map((data.meals ?? []).map((m) => [m.id, m]));
  const portions = groupBy(data.portions ?? [], (p) => p.food_id);
  const items = groupBy(data.meal_items ?? [], (i) => i.meal_id);
  for (const list of items.values()) list.sort((a, b) => a.position - b.position);
  return {
    food: (id) => foods.get(id),
    portions: (foodId) => portions.get(foodId) ?? [],
    meal: (id) => meals.get(id),
    mealItems: (mealId) => items.get(mealId) ?? [],
  };
}

function foodItemCarbs(catalog: Catalog, foodId: Id, amount: number, unit: string): CarbResult {
  const food = catalog.food(foodId);
  if (!food || food.carbs_per_100g == null) return INCOMPLETE;
  const grams = foodAmountToGrams(amount, unit, food, catalog.portions(foodId));
  if (grams === null) return INCOMPLETE;
  return { carbs_g: (grams * food.carbs_per_100g) / 100, complete: true };
}

function mealTotalCarbs(catalog: Catalog, mealId: Id, visiting: Set<Id>): CarbResult {
  if (visiting.has(mealId) || !catalog.meal(mealId)) return INCOMPLETE;
  visiting.add(mealId);
  const total = sumCarbs(
    catalog
      .mealItems(mealId)
      .map((item) => resolveItem(catalog, item.ref_type, item.ref_id, item.amount, item.unit, visiting)),
  );
  visiting.delete(mealId);
  return total;
}

function mealItemCarbs(catalog: Catalog, mealId: Id, amount: number, unit: string, visiting: Set<Id>): CarbResult {
  const meal = catalog.meal(mealId);
  if (!meal || !Number.isFinite(amount) || amount < 0) return INCOMPLETE;
  let factor: number | null = null;
  if (unit === SERVING_UNIT && meal.yield_servings > 0) {
    factor = amount / meal.yield_servings;
  } else if (isMassUnit(unit) && meal.total_weight_g != null && meal.total_weight_g > 0) {
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
