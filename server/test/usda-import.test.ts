import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { initDatabase } from '../src/init';
import { importUsda } from '../src/usda/import';
import { USDA_FIXTURES } from './fixtures';

interface CsvFood {
  fdc_id: number;
  data_type?: string;
  description: string;
  carbs?: number;
  fiber?: number;
}

/** Writes a minimal extracted-FDC CSV directory with one food.csv row per entry and no portions. */
function writeUsdaDir(foods: CsvFood[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'carbbook-usda-synthetic-'));
  const foodRows = foods
    .map((f) => `"${f.fdc_id}","${f.data_type ?? 'foundation_food'}","${f.description}","1","2019-04-01"`)
    .join('\n');
  writeFileSync(join(dir, 'food.csv'), `"fdc_id","data_type","description","food_category_id","publication_date"\n${foodRows}\n`);
  const nutrientRows: string[] = [];
  for (const f of foods) {
    if (f.carbs !== undefined) nutrientRows.push(`"${f.fdc_id}0","${f.fdc_id}","1005","${f.carbs}"`);
    if (f.fiber !== undefined) nutrientRows.push(`"${f.fdc_id}1","${f.fdc_id}","1079","${f.fiber}"`);
  }
  writeFileSync(join(dir, 'food_nutrient.csv'), `"id","fdc_id","nutrient_id","amount"\n${nutrientRows.join('\n')}\n`);
  writeFileSync(join(dir, 'food_portion.csv'), `"id","fdc_id","amount","measure_unit_id","portion_description","modifier","gram_weight"\n`);
  writeFileSync(join(dir, 'measure_unit.csv'), `"id","name"\n`);
  return dir;
}

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

  it('clamps carbs/fiber to 0..100 and nulls fiber when it exceeds carbs', async () => {
    const db = initDatabase(':memory:');
    const dir = writeUsdaDir([
      { fdc_id: 900001, description: 'Too much carbs', carbs: 150 },
      { fdc_id: 900002, description: 'Negative carbs', carbs: -5 },
      { fdc_id: 900003, description: 'Fiber over carbs', carbs: 10, fiber: 15 },
      { fdc_id: 900004, description: 'Boundary values', carbs: 100, fiber: 100 },
    ]);
    await importUsda(db, [dir]);
    const get = (id: number) => db.prepare('SELECT carbs_per_100g, fiber_per_100g FROM usda_food WHERE fdc_id = ?').get(id);
    expect(get(900001)).toEqual({ carbs_per_100g: null, fiber_per_100g: null });
    expect(get(900002)).toEqual({ carbs_per_100g: null, fiber_per_100g: null });
    expect(get(900003)).toEqual({ carbs_per_100g: 10, fiber_per_100g: null });
    expect(get(900004)).toEqual({ carbs_per_100g: 100, fiber_per_100g: 100 });
  });

  it('rolls back the whole import when a later dataset directory fails to read', async () => {
    const db = initDatabase(':memory:');
    const good = writeUsdaDir([{ fdc_id: 900010, description: 'Should not be kept', carbs: 5 }]);
    const bad = mkdtempSync(join(tmpdir(), 'carbbook-usda-bad-'));
    await expect(importUsda(db, [good, bad])).rejects.toThrow(`${bad} is missing food.csv`);
    expect(db.prepare('SELECT count(*) FROM usda_food').pluck().get()).toBe(0);
  });

  it('leaves previous data and index consistent when a re-import fails partway', async () => {
    const db = initDatabase(':memory:');
    await importUsda(db, USDA_FIXTURES);
    const before = db.prepare('SELECT count(*) FROM usda_food').pluck().get();

    const good = writeUsdaDir([{ fdc_id: 900020, description: 'New food', carbs: 5 }]);
    const bad = mkdtempSync(join(tmpdir(), 'carbbook-usda-bad2-'));
    await expect(importUsda(db, [good, bad])).rejects.toThrow();

    expect(db.prepare('SELECT count(*) FROM usda_food').pluck().get()).toBe(before);
    expect(db.prepare('SELECT fdc_id FROM usda_food WHERE fdc_id = ?').get(900020)).toBeUndefined();
    expect(db.prepare("SELECT rowid FROM usda_fts WHERE usda_fts MATCH 'kale'").pluck().all()).toEqual([323505]);
  });

  it('removes USDA foods (and their portions + FTS entries) no longer present in a new import, without touching synced food rows', async () => {
    const db = initDatabase(':memory:');
    const first = writeUsdaDir([
      { fdc_id: 900030, description: 'Keeper Kiwi', carbs: 11 },
      { fdc_id: 900031, description: 'Gone Guava', carbs: 12 },
    ]);
    await importUsda(db, [first]);
    expect(db.prepare('SELECT count(*) FROM usda_food').pluck().get()).toBe(2);

    // A synced catalog food copied from USDA data; must survive the usda_food cleanup untouched.
    db.prepare(
      `INSERT INTO food (id, name, brand, source, source_ref, carbs_per_100g, fiber_per_100g, updated_at, updated_by, deleted, server_seq)
       VALUES ('synced-1', 'Gone Guava', NULL, 'usda', '900031', 12, NULL, 1, 'owner', 0, 1)`,
    ).run();

    const second = writeUsdaDir([{ fdc_id: 900030, description: 'Keeper Kiwi', carbs: 11 }]);
    await importUsda(db, [second]);

    expect(db.prepare('SELECT fdc_id FROM usda_food WHERE fdc_id = ?').get(900031)).toBeUndefined();
    expect(db.prepare('SELECT count(*) FROM usda_food').pluck().get()).toBe(1);
    expect(db.prepare("SELECT rowid FROM usda_fts WHERE usda_fts MATCH 'guava'").pluck().all()).toEqual([]);
    expect(db.prepare("SELECT rowid FROM usda_fts WHERE usda_fts MATCH 'kiwi'").pluck().all()).toEqual([900030]);
    // Synced food row (a different table) is untouched by usda_food cleanup.
    expect(db.prepare("SELECT name, source, deleted FROM food WHERE id = 'synced-1'").get()).toEqual({
      name: 'Gone Guava',
      source: 'usda',
      deleted: 0,
    });
  });
});
