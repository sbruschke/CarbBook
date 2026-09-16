import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type Db, MIGRATIONS_DIR, migrate, openDb } from '../src/db';

const THROUGH_004 = ['001_init.sql', '002_usda_search.sql', '003_any_unit_foods.sql', '004_meal_plan.sql'];
const ITEM_TABLES = ['meal_item', 'log_item', 'plan_item'] as const;

/** A DB at exactly version 4, as the live Pi database is before this deploy. */
function dbAtVersion4() {
  const dir = mkdtempSync(join(tmpdir(), 'carbbook-mig5-'));
  for (const file of THROUGH_004) copyFileSync(join(MIGRATIONS_DIR, file), join(dir, file));
  const db = openDb(':memory:');
  expect(migrate(db, dir)).toBe(4);
  return { db, dir };
}

/** Rows shaped like the live data on 2026-09-16: uuidv7 ids, portion units, a soft delete, device ids. */
function seedLiveLikeRows(db: Db) {
  db.exec(`
    INSERT INTO meal_item (id, meal_id, ref_type, ref_id, amount, unit, position, updated_at, updated_by, deleted, server_seq) VALUES
      ('01a0a519-3167-7aa1-8000-000000000001', '01a0a519-3167-7e92-8587-de9485f35723', 'food', 'usda-170903', 170, 'g', 0, 1789480000000, 'web-01a0a2c1', 0, 21),
      ('01a0a519-3167-7aa1-8000-000000000002', '01a0a519-3167-7e92-8587-de9485f35723', 'food', '01a0a518-9f00-7000-8000-000000000001', 0.5, 'p:01a0a518-9f00-7000-8000-000000000002', 1, 1789480000001, 'web-01a0a2c1', 0, 22),
      ('01a0a519-3167-7aa1-8000-000000000003', '01a0a519-3167-7e92-8587-de9485f35723', 'meal', '01a0a517-0000-7000-8000-000000000001', 1, 'serving', 2, 1789480000002, 'ios-01a0a2c9', 1, 23);
    INSERT INTO log_entry (id, eaten_at, window_name, bg_mgdl, bg_source, bg_trend, total_carbs_g, suggested_units, taken_units, settings_version_id, notes, updated_at, updated_by, deleted, server_seq) VALUES
      ('01a0ac75-2c6b-7128-ab9f-4d8930778697', 1789599755000, 'Dinner', NULL, 'none', NULL, 73.1, 9, 9, '01a0a9f0-0000-7000-8000-000000000001', NULL, 1789599755000, 'ios-01a0a2c9', 0, 40);
    INSERT INTO log_item (id, log_entry_id, ref_type, ref_id, display_name, amount, unit, carbs_g, updated_at, updated_by, deleted, server_seq) VALUES
      ('01a0ac75-2c6c-7000-8000-000000000001', '01a0ac75-2c6b-7128-ab9f-4d8930778697', 'food', '01a0ac6c-2f11-72fe-a0e5-3681ce8dedb0', 'Taquitos', 4.3, 'p:01a0ac6c-2f11-7e22-8c4b-97f9cf5c0683', 73.1, 1789599755000, 'ios-01a0a2c9', 0, 41),
      ('01a0ab23-bf2b-7000-8000-000000000001', '01a0ab23-bf2b-7bbd-8967-229be21606c2', 'food', 'usda-2263891', 'Grapes, green, seedless, raw', 85, 'g', 15.8131875, 1789577641000, 'web-01a0a2c1', 0, 42);
    INSERT INTO plan_entry (id, date, window_name, status, note, log_entry_id, updated_at, updated_by, deleted, server_seq) VALUES
      ('01a0ad00-0000-7000-8000-000000000001', '2026-09-17', 'Lunch', 'planned', 'leftovers', NULL, 1789600000000, 'web-01a0a2c1', 0, 43);
    INSERT INTO plan_item (id, plan_entry_id, ref_type, ref_id, amount, unit, position, updated_at, updated_by, deleted, server_seq) VALUES
      ('01a0ad00-0000-7000-8000-000000000002', '01a0ad00-0000-7000-8000-000000000001', 'meal', '01a0a519-3167-7e92-8587-de9485f35723', 1, 'serving', 0, 1789600000001, 'web-01a0a2c1', 0, 44),
      ('01a0ad00-0000-7000-8000-000000000003', '01a0ad00-0000-7000-8000-000000000001', 'food', 'usda-170903', 0, 'g', 1, 1789600000002, 'web-01a0a2c1', 1, 45);
    UPDATE seq_counter SET value = 45;
  `);
}

const rows = (db: Db, table: string) => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all() as Record<string, unknown>[];
const indexNames = (db: Db, table: string) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? ORDER BY name").pluck().all(table) as string[]);
const columns = (db: Db, table: string) => db.prepare(`SELECT name FROM pragma_table_info('${table}')`).pluck().all() as string[];

describe('migration 005 (quick carbs)', () => {
  it('upgrades a version-4 database keeping every row, server_seq, index and the sequence counter', () => {
    const { db } = dbAtVersion4();
    seedLiveLikeRows(db);
    const before = Object.fromEntries(ITEM_TABLES.map((t) => [t, rows(db, t)]));
    const indexesBefore = Object.fromEntries(ITEM_TABLES.map((t) => [t, indexNames(db, t)]));

    expect(migrate(db)).toBe(5);
    expect(db.pragma('user_version', { simple: true })).toBe(5);

    for (const table of ITEM_TABLES) {
      const after = rows(db, table).map(({ label, ...rest }) => {
        if (table !== 'log_item') expect(label, table).toBeNull();
        return rest;
      });
      expect(after, table).toEqual(before[table]);
      expect(indexNames(db, table), table).toEqual(indexesBefore[table]);
    }
    expect(columns(db, 'meal_item')).toContain('label');
    expect(columns(db, 'plan_item')).toContain('label');
    expect(columns(db, 'log_item')).not.toContain('label');
    expect(db.prepare('SELECT value FROM seq_counter').pluck().get()).toBe(45);
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    // No temp helper tables are left behind.
    expect(db.prepare("SELECT count(*) FROM temp.sqlite_master WHERE name LIKE 'migration_005%'").pluck().get()).toBe(0);
  });

  it('accepts well-formed quick rows and rejects malformed ones at the table level', () => {
    const db = openDb(':memory:');
    migrate(db);
    const meal = (fields: Record<string, unknown>) =>
      db
        .prepare(
          `INSERT INTO meal_item (id, meal_id, ref_type, ref_id, amount, unit, position, label, updated_at, updated_by, deleted, server_seq)
           VALUES (@id, 'm1', @ref_type, @id, @amount, @unit, 0, @label, 1, 'd', 0, 1)`,
        )
        .run({ ref_type: 'quick', amount: 7, unit: 'carbs', label: 'Ranch & salad', ...fields });
    const log = (fields: Record<string, unknown>) =>
      db
        .prepare(
          `INSERT INTO log_item (id, log_entry_id, ref_type, ref_id, display_name, amount, unit, carbs_g, updated_at, updated_by, deleted, server_seq)
           VALUES (@id, 'e1', 'quick', @id, 'Ranch & salad', @amount, 'carbs', @carbs_g, 1, 'd', 0, 1)`,
        )
        .run({ amount: 7, carbs_g: 7, ...fields });
    const plan = (fields: Record<string, unknown>) =>
      db
        .prepare(
          `INSERT INTO plan_item (id, plan_entry_id, ref_type, ref_id, amount, unit, position, label, updated_at, updated_by, deleted, server_seq)
           VALUES (@id, 'p1', @ref_type, @id, @amount, @unit, 0, @label, 1, 'd', 0, 1)`,
        )
        .run({ ref_type: 'quick', amount: 7, unit: 'carbs', label: null, ...fields });

    expect(() => meal({ id: 'ok1' })).not.toThrow();
    expect(() => meal({ id: 'ok2', amount: 2000, label: null })).not.toThrow();
    expect(() => log({ id: 'ok3' })).not.toThrow();
    expect(() => plan({ id: 'ok4', amount: 0 })).not.toThrow();

    expect(() => meal({ id: 'b1', unit: 'g' })).toThrow(/CHECK constraint failed/);
    expect(() => meal({ id: 'b2', amount: 2001 })).toThrow(/CHECK constraint failed/);
    expect(() => meal({ id: 'b3', amount: -1 })).toThrow(/CHECK constraint failed/);
    expect(() => meal({ id: 'b4', label: 'x'.repeat(81) })).toThrow(/CHECK constraint failed/);
    expect(() => meal({ id: 'b5', ref_type: 'food', unit: 'g', label: 'not on food rows' })).toThrow(/CHECK constraint failed/);
    expect(() => meal({ id: 'b6', ref_type: 'snack' })).toThrow(/CHECK constraint failed/);
    expect(() => log({ id: 'b7', carbs_g: 8 })).toThrow(/CHECK constraint failed/);
    expect(() => plan({ id: 'b8', amount: 2001 })).toThrow(/CHECK constraint failed/);
    expect(() => plan({ id: 'b9', amount: -1 })).toThrow(/CHECK constraint failed/);
  });

  it('refuses to run, changing nothing, when an item table already has a label column', () => {
    const { db } = dbAtVersion4();
    seedLiveLikeRows(db);
    db.exec('ALTER TABLE plan_item ADD COLUMN label TEXT');
    const before = rows(db, 'meal_item');

    expect(() => migrate(db)).toThrow(/migration 005: unexpected item data/);
    expect(db.pragma('user_version', { simple: true })).toBe(4);
    expect(columns(db, 'meal_item')).not.toContain('label');
    expect(rows(db, 'meal_item')).toEqual(before);
  });

  it('rolls everything back when a later statement in the file fails', () => {
    const { db, dir } = dbAtVersion4();
    seedLiveLikeRows(db);
    const sql = readFileSync(join(MIGRATIONS_DIR, '005_quick_carbs.sql'), 'utf8');
    writeFileSync(join(dir, '005_quick_carbs.sql'), `${sql}\nSELECT this_function_does_not_exist();\n`);
    const before = Object.fromEntries(ITEM_TABLES.map((t) => [t, rows(db, t)]));

    expect(() => migrate(db, dir)).toThrow();
    expect(db.pragma('user_version', { simple: true })).toBe(4);
    for (const table of ITEM_TABLES) expect(rows(db, table), table).toEqual(before[table]);
    expect(columns(db, 'meal_item')).not.toContain('label');
    expect(() =>
      db
        .prepare(
          `INSERT INTO plan_item (id, plan_entry_id, ref_type, ref_id, amount, unit, position, updated_at, updated_by, deleted, server_seq)
           VALUES ('q', 'p', 'quick', 'q', 7, 'carbs', 0, 1, 'd', 0, 1)`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/);
    expect(db.prepare("SELECT count(*) FROM sqlite_master WHERE name LIKE '%_new'").pluck().get()).toBe(0);
  });

  it('migrates a fresh database straight to version 5', () => {
    const db = openDb(':memory:');
    expect(migrate(db)).toBe(5);
  });
});
