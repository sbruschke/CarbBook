import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, migrate, openDb } from '../src/db';

/** A DB migrated to exactly version 3, as the live Pi database is today. */
function dbAtVersion3() {
  const dir = mkdtempSync(join(tmpdir(), 'carbbook-mig4-'));
  for (const file of ['001_init.sql', '002_usda_search.sql', '003_any_unit_foods.sql']) {
    copyFileSync(join(MIGRATIONS_DIR, file), join(dir, file));
  }
  const db = openDb(':memory:');
  migrate(db, dir);
  return { db, dir };
}

/** A migrations directory holding exactly 001-004, so migrate() stops at version 4. */
function dirThrough004() {
  const dir = mkdtempSync(join(tmpdir(), 'carbbook-mig4-through-'));
  for (const file of ['001_init.sql', '002_usda_search.sql', '003_any_unit_foods.sql', '004_meal_plan.sql']) {
    copyFileSync(join(MIGRATIONS_DIR, file), join(dir, file));
  }
  return dir;
}

function insertPlanEntry(db: ReturnType<typeof openDb>, fields: Record<string, unknown>): void {
  db.prepare(
    `INSERT INTO plan_entry (id, date, window_name, status, note, log_entry_id, updated_at, updated_by, deleted, server_seq)
     VALUES (@id, @date, @window_name, @status, @note, @log_entry_id, @updated_at, @updated_by, @deleted, @server_seq)`,
  ).run({
    note: null,
    log_entry_id: null,
    updated_at: 1,
    updated_by: 'd',
    deleted: 0,
    server_seq: 1,
    ...fields,
  });
}

describe('migration 004 (meal plan)', () => {
  it('upgrades a version-3 database with real rows without touching them', () => {
    const { db } = dbAtVersion3();
    db.prepare(
      "INSERT INTO food (id, name, source, carbs_per_100g, updated_at, updated_by, deleted, server_seq) VALUES ('f1', 'Rice', 'custom', 28.2, 1, 'd', 0, 1)",
    ).run();
    db.prepare(
      `INSERT INTO dose_settings (id, effective_from, windows, correction, rounding, updated_at, updated_by, deleted, server_seq)
       VALUES ('ds1', 1, '[]', '{}', '{}', 1, 'd', 0, 2)`,
    ).run();

    expect(migrate(db, dirThrough004())).toBe(4);
    expect(db.pragma('user_version', { simple: true })).toBe(4);
    expect(db.prepare('SELECT name, carbs_per_100g FROM food WHERE id = ?').get('f1')).toEqual({
      name: 'Rice',
      carbs_per_100g: 28.2,
    });
    expect(db.prepare('SELECT windows FROM dose_settings WHERE id = ?').pluck().get('ds1')).toBe('[]');
  });

  it('migrates a fresh database straight to version 4', () => {
    const db = openDb(':memory:');
    expect(migrate(db, dirThrough004())).toBe(4);
  });

  it('creates both tables with the usual sync metadata columns and indexes', () => {
    const db = openDb(':memory:');
    migrate(db);
    for (const table of ['plan_entry', 'plan_item']) {
      const columns = db.prepare(`SELECT name FROM pragma_table_info('${table}')`).pluck().all();
      expect(columns, table).toEqual(expect.arrayContaining(['id', 'updated_at', 'updated_by', 'deleted', 'server_seq']));
    }
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('plan_entry', 'plan_item')")
      .pluck()
      .all();
    expect(indexes).toEqual(
      expect.arrayContaining([
        'plan_entry_server_seq',
        'plan_entry_date',
        'plan_entry_log_entry',
        'plan_entry_slot',
        'plan_item_server_seq',
        'plan_item_entry',
      ]),
    );
  });

  it('allows one live slot per date and window, and a replacement after a soft delete', () => {
    const db = openDb(':memory:');
    migrate(db);
    insertPlanEntry(db, { id: 'p1', date: '2026-09-17', window_name: 'Lunch', status: 'planned' });
    expect(() =>
      insertPlanEntry(db, { id: 'p2', date: '2026-09-17', window_name: 'Lunch', status: 'planned' }),
    ).toThrow(/UNIQUE constraint failed/);

    // A different window and a different date are fine.
    insertPlanEntry(db, { id: 'p3', date: '2026-09-17', window_name: 'Dinner', status: 'planned' });
    insertPlanEntry(db, { id: 'p4', date: '2026-09-18', window_name: 'Lunch', status: 'planned' });

    // Soft-deleting the first frees the slot.
    db.prepare("UPDATE plan_entry SET deleted = 1 WHERE id = 'p1'").run();
    expect(() =>
      insertPlanEntry(db, { id: 'p5', date: '2026-09-17', window_name: 'Lunch', status: 'planned' }),
    ).not.toThrow();
  });

  it.each([
    [{ id: 'bad1', date: '17-09-2026', window_name: 'Lunch', status: 'planned' }],
    [{ id: 'bad2', date: '2026-09-17', window_name: '', status: 'planned' }],
    [{ id: 'bad3', date: '2026-09-17', window_name: 'Lunch', status: 'eaten' }],
  ])('rejects plan_entry %j', (fields) => {
    const db = openDb(':memory:');
    migrate(db);
    expect(() => insertPlanEntry(db, fields)).toThrow(/CHECK constraint failed/);
  });

  it('rejects a negative plan_item amount and a bad ref_type', () => {
    const db = openDb(':memory:');
    migrate(db);
    const insert = (fields: Record<string, unknown>) =>
      db
        .prepare(
          `INSERT INTO plan_item (id, plan_entry_id, ref_type, ref_id, amount, unit, position, updated_at, updated_by, deleted, server_seq)
           VALUES (@id, @plan_entry_id, @ref_type, @ref_id, @amount, @unit, @position, 1, 'd', 0, 1)`,
        )
        .run({ plan_entry_id: 'p1', ref_type: 'food', ref_id: 'f1', amount: 1, unit: 'g', position: 0, ...fields });
    expect(() => insert({ id: 'i1' })).not.toThrow();
    expect(() => insert({ id: 'i2', amount: -1 })).toThrow(/CHECK constraint failed/);
    expect(() => insert({ id: 'i3', ref_type: 'snack' })).toThrow(/CHECK constraint failed/);
    expect(() => insert({ id: 'i4', amount: 0 })).not.toThrow();
  });

  it('aborts cleanly rather than half-applying when a statement in the file fails', () => {
    const { db, dir } = dbAtVersion3();
    const sql = readFileSync(join(MIGRATIONS_DIR, '004_meal_plan.sql'), 'utf8');
    writeFileSync(join(dir, '004_meal_plan.sql'), `${sql}\nSELECT this_function_does_not_exist();\n`);

    expect(() => migrate(db, dir)).toThrow();
    expect(db.pragma('user_version', { simple: true })).toBe(3);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'plan_entry'").get()).toBeUndefined();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'plan_item'").get()).toBeUndefined();
  });

  it('refuses to run when a plan_entry table already exists', () => {
    const { db, dir } = dbAtVersion3();
    copyFileSync(join(MIGRATIONS_DIR, '004_meal_plan.sql'), join(dir, '004_meal_plan.sql'));
    db.prepare('CREATE TABLE plan_entry (id TEXT PRIMARY KEY)').run();
    expect(() => migrate(db, dir)).toThrow(/migration 004: plan_entry\/plan_item already exist/);
    expect(db.pragma('user_version', { simple: true })).toBe(3);
  });
});
