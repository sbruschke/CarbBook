import type { MealData, MealItemData } from '@carbbook/core';
import type { CatalogData } from '../db/catalog';
import type { Change, Store } from '../db/store';
import { parseAmount } from '../ui/format';
import type { DraftItem } from '../ui/ItemEditor';
import { saveUsdaFoodsFor } from '../usda/materialize';

/** Saves a meal and its components (item key = meal_item id, order = position). */
export async function saveMeal(store: Store, meal: MealData, items: DraftItem[], removedItemIds: string[] = []): Promise<void> {
  await saveUsdaFoodsFor(store, items);
  const changes: Change[] = [
    { table: 'meal', data: meal },
    ...items.map(
      (item, position): Change => ({
        table: 'meal_item',
        data: {
          id: item.key,
          meal_id: meal.id,
          ref_type: item.ref_type,
          ref_id: item.ref_id,
          amount: parseAmount(item.amount)!,
          unit: item.unit,
          position,
        },
      }),
    ),
  ];
  await store.saveMany(changes);
  for (const id of removedItemIds) await store.remove('meal_item', id);
}

/** Catalog data with an unsaved meal draft in place of the stored meal, for live carbs and cycle checks. */
export function withDraftMeal(data: CatalogData, meal: MealData, items: DraftItem[]): CatalogData {
  const meta = { updated_at: 0, updated_by: 'draft', deleted: 0 as const };
  const draftItems = items.map(
    (item, position): MealItemData & typeof meta => ({
      id: item.key,
      meal_id: meal.id,
      ref_type: item.ref_type,
      ref_id: item.ref_id,
      amount: parseAmount(item.amount) ?? Number.NaN,
      unit: item.unit,
      position,
      ...meta,
    }),
  );
  return {
    ...data,
    meals: [...data.meals.filter((m) => m.id !== meal.id), { ...meal, ...meta }],
    meal_items: [...data.meal_items.filter((i) => i.meal_id !== meal.id), ...draftItems],
  };
}
