import {
  type Catalog,
  createCatalog,
  type FoodData,
  type MealData,
  type MealItemData,
  type PortionData,
  type Synced,
} from '@carbbook/core';
import { usdaFoodId, usdaPortionId } from '../lib/ids';
import type { CarbBookDb, UsdaFoodRow, UsdaPortionRow } from './db';
import { isLive } from './db';

export interface CatalogData {
  foods: Synced<FoodData>[];
  portions: Synced<PortionData>[];
  meals: Synced<MealData>[];
  meal_items: Synced<MealItemData>[];
}

/** A USDA library food shaped like a saved food, before (or without) copying it into `food`. */
export interface UsdaFoodEntry {
  food: FoodData;
  portions: PortionData[];
}

/** Non-deleted foods, portions, meals and meal items, read consistently. */
export function loadCatalogData(db: CarbBookDb): Promise<CatalogData> {
  return db.transaction('r', [db.food, db.portion, db.meal, db.meal_item], async () => {
    const [foods, portions, meals, mealItems] = await Promise.all([
      db.food.filter(isLive).toArray(),
      db.portion.filter(isLive).toArray(),
      db.meal.filter(isLive).toArray(),
      db.meal_item.filter(isLive).toArray(),
    ]);
    return { foods, portions, meals, meal_items: mealItems };
  });
}

export function usdaAsFood(food: UsdaFoodRow, portions: UsdaPortionRow[]): UsdaFoodEntry {
  const id = usdaFoodId(food.fdc_id);
  return {
    food: {
      id,
      name: food.name,
      brand: null,
      source: 'usda',
      source_ref: String(food.fdc_id),
      derived_from: null,
      carbs_per_100g: food.carbs_per_100g,
      fiber_per_100g: food.fiber_per_100g,
      density_g_per_ml: null,
      notes: null,
    },
    portions: portions.map((p) => ({
      id: usdaPortionId(p.id),
      food_id: id,
      label: p.label,
      kind: p.kind,
      quantity: p.quantity,
      grams: p.grams,
    })),
  };
}

export async function loadUsdaFood(db: CarbBookDb, fdcId: number): Promise<UsdaFoodEntry | null> {
  const food = await db.usda_food.get(fdcId);
  if (!food) return null;
  return usdaAsFood(food, await db.usda_portion.where('fdc_id').equals(fdcId).toArray());
}

/**
 * Core catalog over saved data plus USDA foods that are not saved yet. A saved copy (same
 * deterministic id) always wins over the library entry.
 */
export function buildCatalog(data: CatalogData, usda: UsdaFoodEntry[] = []): Catalog {
  const saved = new Set(data.foods.map((f) => f.id));
  const extra = usda.filter((entry) => !saved.has(entry.food.id));
  return createCatalog({
    foods: [...data.foods, ...extra.map((entry) => entry.food)],
    portions: [...data.portions, ...extra.flatMap((entry) => entry.portions)],
    meals: data.meals,
    meal_items: data.meal_items,
  });
}
