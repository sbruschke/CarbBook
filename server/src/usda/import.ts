import { parse } from 'csv-parse';
import { createReadStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../db';
import { type FdcPortionRow, normalizePortion, type UsdaPortion } from './portions';

export const USDA_DATA_TYPES = new Set(['foundation_food', 'sr_legacy_food', 'survey_fndds_food']);
/**
 * food_nutrient.nutrient_id values for carbohydrate (by difference) and total dietary fiber.
 * Foundation and SR Legacy use nutrient ids 1005/1079; the FNDDS 2024-10-31 CSV stores the legacy
 * nutrient numbers 205/291 in the same column.
 */
export const CARB_NUTRIENT_IDS = new Set(['1005', '205']);
export const FIBER_NUTRIENT_IDS = new Set(['1079', '291']);
export const REQUIRED_FILES = ['food.csv', 'food_nutrient.csv', 'food_portion.csv', 'measure_unit.csv'] as const;

export interface UsdaImportStats {
  datasets: number;
  foods: number;
  portions: number;
  skipped_portions: number;
}

interface PendingFood {
  fdc_id: number;
  data_type: string;
  name: string;
  carbs_per_100g: number | null;
  fiber_per_100g: number | null;
}

export async function* readCsv(path: string): AsyncGenerator<Record<string, string>> {
  const parser = createReadStream(path).pipe(parse({ columns: true, bom: true, skip_empty_lines: true }));
  for await (const record of parser) yield record as Record<string, string>;
}

/** Carbs/fiber are grams per 100g of food and can never exceed 100; anything else is bad data. */
function amount(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
}

async function readDataset(dir: string) {
  for (const file of REQUIRED_FILES) {
    if (!existsSync(join(dir, file))) throw new Error(`${dir} is missing ${file}`);
  }
  const unitNames = new Map<string, string>();
  for await (const row of readCsv(join(dir, 'measure_unit.csv'))) unitNames.set(row.id!, row.name!);

  const foods = new Map<string, PendingFood>();
  for await (const row of readCsv(join(dir, 'food.csv'))) {
    if (!USDA_DATA_TYPES.has(row.data_type!)) continue;
    foods.set(row.fdc_id!, {
      fdc_id: Number(row.fdc_id),
      data_type: row.data_type!,
      name: row.description!.trim(),
      carbs_per_100g: null,
      fiber_per_100g: null,
    });
  }

  for await (const row of readCsv(join(dir, 'food_nutrient.csv'))) {
    const food = foods.get(row.fdc_id!);
    if (!food) continue;
    const nutrientId = row.nutrient_id!;
    if (CARB_NUTRIENT_IDS.has(nutrientId) && food.carbs_per_100g === null) food.carbs_per_100g = amount(row.amount);
    if (FIBER_NUTRIENT_IDS.has(nutrientId) && food.fiber_per_100g === null) food.fiber_per_100g = amount(row.amount);
  }

  // A food can never store more fiber than carbs; unparseable/out-of-range fiber loses to a valid carbs value.
  for (const food of foods.values()) {
    if (food.carbs_per_100g !== null && food.fiber_per_100g !== null && food.fiber_per_100g > food.carbs_per_100g) {
      food.fiber_per_100g = null;
    }
  }

  const portions: UsdaPortion[] = [];
  let skipped = 0;
  for await (const row of readCsv(join(dir, 'food_portion.csv'))) {
    if (!foods.has(row.fdc_id!)) continue;
    const portion = normalizePortion(row as unknown as FdcPortionRow, unitNames);
    if (portion) portions.push(portion);
    else skipped++;
  }
  return { foods: [...foods.values()], portions, skipped };
}

/**
 * Imports one or more extracted FDC CSV directories (Foundation, SR Legacy, FNDDS). Re-runnable.
 *
 * All datasets are read (async, off any transaction) before anything is written, and the writes -
 * upserts, the removal of USDA foods absent from this import, and the FTS rebuild - happen in one
 * synchronous transaction, so a failure anywhere (a bad directory, a write error) leaves the
 * previously-imported usda_food/usda_portion/usda_fts data untouched rather than half-applied.
 * The `food` table (synced catalog rows, some copied from USDA with source='usda') is never touched.
 */
export async function importUsda(db: Db, datasetDirs: string[]): Promise<UsdaImportStats> {
  const stats: UsdaImportStats = { datasets: 0, foods: 0, portions: 0, skipped_portions: 0 };
  const datasets: Awaited<ReturnType<typeof readDataset>>[] = [];
  for (const dir of datasetDirs) datasets.push(await readDataset(dir));

  const upsertFood = db.prepare(
    `INSERT INTO usda_food (fdc_id, data_type, name, carbs_per_100g, fiber_per_100g)
     VALUES (@fdc_id, @data_type, @name, @carbs_per_100g, @fiber_per_100g)
     ON CONFLICT (fdc_id) DO UPDATE SET data_type = excluded.data_type, name = excluded.name,
       carbs_per_100g = excluded.carbs_per_100g, fiber_per_100g = excluded.fiber_per_100g`,
  );
  const clearPortions = db.prepare('DELETE FROM usda_portion WHERE fdc_id = ?');
  const insertPortion = db.prepare(
    `INSERT INTO usda_portion (id, fdc_id, label, kind, quantity, grams, description)
     VALUES (@id, @fdc_id, @label, @kind, @quantity, @grams, @description)`,
  );
  const deleteFood = db.prepare('DELETE FROM usda_food WHERE fdc_id = ?');
  const existingFdcIds = db.prepare('SELECT fdc_id FROM usda_food').pluck();

  const keepIds = new Set<number>();
  for (const dataset of datasets) for (const food of dataset.foods) keepIds.add(food.fdc_id);

  db.transaction(() => {
    for (const dataset of datasets) {
      for (const food of dataset.foods) {
        upsertFood.run(food);
        clearPortions.run(food.fdc_id);
      }
      for (const portion of dataset.portions) insertPortion.run(portion);
    }
    // usda_portion rows cascade-delete via the fdc_id foreign key; usda_fts is repopulated below.
    for (const fdcId of existingFdcIds.all() as number[]) {
      if (!keepIds.has(fdcId)) deleteFood.run(fdcId);
    }
    db.exec("INSERT INTO usda_fts (usda_fts) VALUES ('rebuild')");
  })();

  for (const dataset of datasets) {
    stats.datasets++;
    stats.foods += dataset.foods.length;
    stats.portions += dataset.portions.length;
    stats.skipped_portions += dataset.skipped;
  }
  return stats;
}
