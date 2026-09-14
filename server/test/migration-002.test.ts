import { copyFileSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, migrate, openDb } from '../src/db';

const catalog = (db: ReturnType<typeof openDb>) =>
  db.prepare('SELECT kind, ref_id, name FROM catalog_fts ORDER BY kind, ref_id').all();

describe('migration 002 (USDA + search)', () => {
  it('backfills catalog_fts from rows written before the migration', () => {
    const onlyFirst = mkdtempSync(join(tmpdir(), 'carbbook-mig-'));
    copyFileSync(join(MIGRATIONS_DIR, '001_init.sql'), join(onlyFirst, '001_init.sql'));
    const db = openDb(':memory:');
    migrate(db, onlyFirst);
    db.prepare(
      "INSERT INTO food (id, name, source, updated_at, updated_by, deleted, server_seq) VALUES ('f1', 'Tortilla', 'custom', 1, 'd', 0, 1), ('f2', 'Gone', 'custom', 1, 'd', 1, 2)",
    ).run();
    db.prepare("INSERT INTO meal (id, name, updated_at, updated_by, deleted, server_seq) VALUES ('m1', 'Tacos', 1, 'd', 0, 3)").run();

    expect(readdirSync(MIGRATIONS_DIR)).toContain('002_usda_search.sql');
    expect(migrate(db)).toBe(2);
    expect(catalog(db)).toEqual([
      { kind: 'food', ref_id: 'f1', name: 'Tortilla' },
      { kind: 'meal', ref_id: 'm1', name: 'Tacos' },
    ]);
  });

  it('keeps catalog_fts in sync on insert, rename, soft delete and undelete', () => {
    const db = openDb(':memory:');
    migrate(db);
    const upsert = db.prepare(
      `INSERT INTO food (id, name, source, updated_at, updated_by, deleted, server_seq) VALUES (@id, @name, 'custom', 1, 'd', @deleted, 1)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, deleted = excluded.deleted`,
    );
    upsert.run({ id: 'f1', name: 'Tortilla', deleted: 0 });
    upsert.run({ id: 'f1', name: 'Flour tortilla', deleted: 0 });
    expect(catalog(db)).toEqual([{ kind: 'food', ref_id: 'f1', name: 'Flour tortilla' }]);
    upsert.run({ id: 'f1', name: 'Flour tortilla', deleted: 1 });
    expect(catalog(db)).toEqual([]);
    upsert.run({ id: 'f1', name: 'Flour tortilla', deleted: 0 });
    expect(catalog(db)).toEqual([{ kind: 'food', ref_id: 'f1', name: 'Flour tortilla' }]);
  });
});
