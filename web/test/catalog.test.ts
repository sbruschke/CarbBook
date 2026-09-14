import { foodUnits, itemCarbs } from '@carbbook/core';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCatalog, loadCatalogData, loadUsdaFood } from '../src/db/catalog';
import type { CarbBookDb } from '../src/db/db';
import { createStore } from '../src/db/store';
import { saveUsdaFood, saveUsdaFoodsFor } from '../src/usda/materialize';
import { foodData, mealData, mealItemData, openTestDb, synced } from './helpers';

let db: CarbBookDb;
afterEach(async () => {
  await db.delete();
});

async function seedPeanutButter(target: CarbBookDb) {
  await target.usda_food.put({ fdc_id: 324860, name: 'Peanut butter, smooth style, with salt', carbs_per_100g: 22.3, fiber_per_100g: 4.8 });
  await target.usda_portion.put({ id: 119207, fdc_id: 324860, label: 'tbsp', kind: 'volume', quantity: 2, grams: 32, description: 'tablespoon' });
}

describe('catalog', () => {
  it('skips deleted rows and feeds core carb math', async () => {
    db = openTestDb();
    await db.food.bulkPut([
      synced(foodData({ id: 'f1', carbs_per_100g: 48 })),
      synced(foodData({ id: 'f2', name: 'Gone' }), { deleted: 1 }),
    ]);
    await db.meal.put(synced(mealData({ id: 'm1', yield_servings: 2 })));
    await db.meal_item.put(synced(mealItemData({ id: 'i1', meal_id: 'm1', ref_id: 'f1', amount: 100, unit: 'g' })));
    const data = await loadCatalogData(db);
    expect(data.foods.map((f) => f.id)).toEqual(['f1']);
    expect(itemCarbs(buildCatalog(data), 'meal', 'm1', 1, 'serving')).toEqual({ carbs_g: 24, complete: true });
  });

  it('resolves an unsaved USDA food with its volume portion', async () => {
    db = openTestDb();
    await seedPeanutButter(db);
    const usda = await loadUsdaFood(db, 324860);
    expect(usda?.food).toMatchObject({ id: 'usda-324860', source: 'usda', source_ref: '324860' });
    const catalog = buildCatalog(await loadCatalogData(db), [usda!]);
    expect(foodUnits(usda!.food, usda!.portions)).toContain('tbsp');
    const carbs = itemCarbs(catalog, 'food', 'usda-324860', 2, 'tbsp');
    expect(carbs.complete).toBe(true);
    expect(carbs.carbs_g).toBeCloseTo(7.136, 3);
    expect(await loadUsdaFood(db, 1)).toBeNull();
  });
});

describe('saveUsdaFood', () => {
  it('copies the food and portions once, and restores a deleted copy', async () => {
    db = openTestDb();
    await seedPeanutButter(db);
    const store = createStore(db, 'device-a', { now: () => 1000 });

    expect(await saveUsdaFood(store, 324860)).toBe('usda-324860');
    expect(await db.food.get('usda-324860')).toMatchObject({ source: 'usda', source_ref: '324860', carbs_per_100g: 22.3, deleted: 0 });
    expect(await db.portion.where('food_id').equals('usda-324860').toArray()).toEqual([
      { id: 'usda-portion-119207', food_id: 'usda-324860', label: 'tbsp', kind: 'volume', quantity: 2, grams: 32, updated_at: 1000, updated_by: 'device-a', deleted: 0 },
    ]);
    expect(await db.outbox.count()).toBe(2);

    await db.outbox.clear();
    await saveUsdaFood(store, 324860);
    expect(await db.outbox.count()).toBe(0);

    await store.remove('food', 'usda-324860');
    await saveUsdaFoodsFor(store, [
      { ref_type: 'food', ref_id: 'usda-324860' },
      { ref_type: 'meal', ref_id: 'usda-324860' },
      { ref_type: 'food', ref_id: 'f1' },
    ]);
    expect((await db.food.get('usda-324860'))?.deleted).toBe(0);
  });

  it('fails clearly when the library does not have the food', async () => {
    db = openTestDb();
    const store = createStore(db, 'device-a');
    await expect(saveUsdaFood(store, 999)).rejects.toThrow('USDA food 999 is not in the downloaded library');
  });
});
