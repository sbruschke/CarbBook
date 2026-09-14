import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { initDatabase } from '../src/init';
import { importUsda } from '../src/usda/import';
import { USDA_FIXTURES } from './fixtures';

describe('importUsda', () => {
  it('imports Foundation, SR Legacy and FNDDS fixture CSVs', async () => {
    const db = initDatabase(':memory:');
    const stats = await importUsda(db, USDA_FIXTURES);
    expect(stats).toEqual({ datasets: 3, foods: 12, portions: 28, skipped_portions: 3 });

    const food = (fdcId: number) =>
      db.prepare('SELECT data_type, name, carbs_per_100g, fiber_per_100g FROM usda_food WHERE fdc_id = ?').get(fdcId);
    expect(food(324860)).toEqual({ data_type: 'foundation_food', name: 'Peanut butter, smooth style, with salt', carbs_per_100g: 22.3, fiber_per_100g: 4.8 });
    expect(food(322892)).toEqual({ data_type: 'foundation_food', name: 'Milk, whole, 3.25% milkfat, with added vitamin D', carbs_per_100g: 4.67, fiber_per_100g: null });
    expect(food(174643)).toMatchObject({ data_type: 'sr_legacy_food', carbs_per_100g: 89.72, fiber_per_100g: 2.6 });
    // FNDDS stores nutrient numbers (205/291) in food_nutrient.nutrient_id.
    expect(food(2706093)).toMatchObject({ data_type: 'survey_fndds_food', carbs_per_100g: 14.93, fiber_per_100g: 0.9 });
    expect(food(2705383)).toMatchObject({ name: 'Milk, human', carbs_per_100g: null });
    // sub_sample_food rows in the Foundation download are not foods.
    expect(food(319877)).toBeUndefined();

    expect(
      db.prepare('SELECT label, kind, quantity, grams FROM usda_portion WHERE fdc_id = ? ORDER BY id').all(322892),
    ).toEqual([
      { label: 'cup', kind: 'volume', quantity: 1, grams: 229 },
      { label: 'floz', kind: 'volume', quantity: 1, grams: 30.5 },
      { label: 'tbsp', kind: 'volume', quantity: 1, grams: 15 },
      { label: 'cup', kind: 'volume', quantity: 4, grams: 976 },
    ]);
  });

  it('is re-runnable without duplicating rows and rebuilds the USDA FTS index', async () => {
    const db = initDatabase(':memory:');
    await importUsda(db, USDA_FIXTURES);
    await importUsda(db, USDA_FIXTURES);
    expect(db.prepare('SELECT count(*) FROM usda_food').pluck().get()).toBe(12);
    expect(db.prepare('SELECT count(*) FROM usda_portion').pluck().get()).toBe(28);
    expect(db.prepare("SELECT rowid FROM usda_fts WHERE usda_fts MATCH 'kale'").pluck().all()).toEqual([323505]);
  });

  it('fails clearly when a CSV is missing', async () => {
    const db = initDatabase(':memory:');
    const empty = mkdtempSync(join(tmpdir(), 'carbbook-usda-'));
    await expect(importUsda(db, [empty])).rejects.toThrow(`${empty} is missing food.csv`);
  });
});
