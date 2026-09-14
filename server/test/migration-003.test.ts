import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, migrate, openDb } from '../src/db';

/** A DB migrated to exactly version 2 (001 + 002 only), as if created before this migration existed. */
function dbAtVersion2() {
  const dir = mkdtempSync(join(tmpdir(), 'carbbook-mig3-'));
  copyFileSync(join(MIGRATIONS_DIR, '001_init.sql'), join(dir, '001_init.sql'));
  copyFileSync(join(MIGRATIONS_DIR, '002_usda_search.sql'), join(dir, '002_usda_search.sql'));
  const db = openDb(':memory:');
  migrate(db, dir);
  return db;
}

describe('migration 003 (any-unit foods)', () => {
  it('adds food.carbs_per_100ml and rebuilds portion with nullable grams + carbs_g, preserving existing rows', () => {
    const db = dbAtVersion2();
    expect(db.pragma('user_version', { simple: true })).toBe(2);

    db.prepare(
      "INSERT INTO food (id, name, source, updated_at, updated_by, deleted, server_seq) VALUES ('f1', 'Rice', 'custom', 1, 'd', 0, 1)",
    ).run();
    db.prepare(
      "INSERT INTO portion (id, food_id, label, kind, quantity, grams, updated_at, updated_by, deleted, server_seq) VALUES ('p1', 'f1', 'cup', 'volume', 1, 158, 2, 'd', 0, 2)",
    ).run();

    expect(migrate(db)).toBe(3);
    expect(db.pragma('user_version', { simple: true })).toBe(3);

    const food = db.prepare('SELECT * FROM food WHERE id = ?').get('f1') as Record<string, unknown>;
    expect(food.carbs_per_100ml).toBeNull();
    expect(food.name).toBe('Rice');

    const portion = db.prepare('SELECT * FROM portion WHERE id = ?').get('p1') as Record<string, unknown>;
    expect(portion).toMatchObject({
      id: 'p1',
      food_id: 'f1',
      label: 'cup',
      kind: 'volume',
      quantity: 1,
      grams: 158,
      carbs_g: null,
      updated_at: 2,
      updated_by: 'd',
      deleted: 0,
      server_seq: 2,
    });

    // Indexes survive the rebuild.
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'portion'").all() as { name: string }[];
    expect(indexes.map((i) => i.name).sort()).toEqual(['portion_food', 'portion_server_seq', 'sqlite_autoindex_portion_1']);
  });

  it.each([[0], [-5]])('refuses to run (and rolls back) when a portion has grams = %s', (grams) => {
    const db = dbAtVersion2();
    db.prepare(
      "INSERT INTO food (id, name, source, updated_at, updated_by, deleted, server_seq) VALUES ('f1', 'Rice', 'custom', 1, 'd', 0, 1)",
    ).run();
    db.prepare(
      "INSERT INTO portion (id, food_id, label, kind, quantity, grams, updated_at, updated_by, deleted, server_seq) VALUES ('bad', 'f1', 'slice', 'count', 1, ?, 2, 'd', 0, 2)",
    ).run(grams);

    expect(() => migrate(db)).toThrow(/migration 003: portion row\(s\) have grams <= 0/);
    expect(db.pragma('user_version', { simple: true })).toBe(2);
    // Nothing was changed: no new column, portion table untouched.
    const foodCols = (db.prepare('PRAGMA table_info(food)').all() as { name: string }[]).map((c) => c.name);
    expect(foodCols).not.toContain('carbs_per_100ml');
    const portionCols = (db.prepare('PRAGMA table_info(portion)').all() as { name: string }[]).map((c) => c.name);
    expect(portionCols).not.toContain('carbs_g');
    expect(db.prepare('SELECT grams FROM portion WHERE id = ?').pluck().get('bad')).toBe(grams);
  });

  it('accepts a portion with only carbs_g (no grams) after the rebuild', () => {
    const db = openDb(':memory:');
    migrate(db);
    db.prepare(
      "INSERT INTO food (id, name, source, updated_at, updated_by, deleted, server_seq) VALUES ('f1', 'X', 'custom', 1, 'd', 0, 1)",
    ).run();
    expect(() =>
      db
        .prepare(
          "INSERT INTO portion (id, food_id, label, kind, quantity, grams, carbs_g, updated_at, updated_by, deleted, server_seq) VALUES ('p2', 'f1', 'bar', 'count', 1, NULL, 22, 1, 'd', 0, 1)",
        )
        .run(),
    ).not.toThrow();
  });

  it('rejects a volume portion without grams', () => {
    const db = openDb(':memory:');
    migrate(db);
    expect(() =>
      db
        .prepare(
          "INSERT INTO portion (id, food_id, label, kind, quantity, grams, carbs_g, updated_at, updated_by, deleted, server_seq) VALUES ('p3', 'f1', 'cup', 'volume', 1, NULL, 20, 1, 'd', 0, 1)",
        )
        .run(),
    ).toThrow();
  });

  it('rejects a portion with neither grams nor carbs_g', () => {
    const db = openDb(':memory:');
    migrate(db);
    expect(() =>
      db
        .prepare(
          "INSERT INTO portion (id, food_id, label, kind, quantity, grams, carbs_g, updated_at, updated_by, deleted, server_seq) VALUES ('p4', 'f1', 'slice', 'count', 1, NULL, NULL, 1, 'd', 0, 1)",
        )
        .run(),
    ).toThrow();
  });

  it('rejects food.carbs_per_100ml outside 0..150', () => {
    const db = openDb(':memory:');
    migrate(db);
    expect(() =>
      db
        .prepare(
          "INSERT INTO food (id, name, source, carbs_per_100ml, updated_at, updated_by, deleted, server_seq) VALUES ('f2', 'X', 'custom', 151, 1, 'd', 0, 1)",
        )
        .run(),
    ).toThrow();
  });

  it('migrates a fresh database straight to version 3', () => {
    const db = openDb(':memory:');
    expect(migrate(db)).toBe(3);
    expect(db.pragma('user_version', { simple: true })).toBe(3);
  });
});
