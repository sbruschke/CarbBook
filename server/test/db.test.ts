import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { currentServerSeq, migrate, nextServerSeq, openDb } from '../src/db';

describe('migrate', () => {
  it('applies numbered files in order once and records user_version', () => {
    const dir = mkdtempSync(join(tmpdir(), 'carbbook-mig-'));
    writeFileSync(join(dir, '001_a.sql'), 'CREATE TABLE a (x INTEGER);');
    writeFileSync(join(dir, '002_b.sql'), 'CREATE TABLE b (y INTEGER);');
    writeFileSync(join(dir, 'README.txt'), 'ignored');
    const db = openDb(':memory:');
    expect(migrate(db, dir)).toBe(2);
    expect(migrate(db, dir)).toBe(2);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").pluck().all();
    expect(tables).toEqual(['a', 'b']);
  });

  it('rolls back a failing migration', () => {
    const dir = mkdtempSync(join(tmpdir(), 'carbbook-mig-'));
    writeFileSync(join(dir, '001_ok.sql'), 'CREATE TABLE ok (x INTEGER);');
    writeFileSync(join(dir, '002_bad.sql'), 'CREATE TABLE half (x INTEGER); THIS IS NOT SQL;');
    const db = openDb(':memory:');
    expect(() => migrate(db, dir)).toThrow();
    expect(db.pragma('user_version', { simple: true })).toBe(1);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'half'").get()).toBeUndefined();
  });
});

describe('schema 001', () => {
  it('creates every synced table with sync metadata columns', () => {
    const db = openDb(':memory:');
    migrate(db);
    for (const table of ['food', 'portion', 'barcode', 'meal', 'meal_item', 'log_entry', 'log_item', 'dose_settings']) {
      const columns = db.prepare(`SELECT name FROM pragma_table_info('${table}')`).pluck().all();
      expect(columns, table).toEqual(expect.arrayContaining(['id', 'updated_at', 'updated_by', 'deleted', 'server_seq']));
    }
  });

  it('enforces enum CHECK constraints', () => {
    const db = openDb(':memory:');
    migrate(db);
    expect(() =>
      db
        .prepare(
          "INSERT INTO food (id, name, source, updated_at, updated_by, server_seq) VALUES ('f1', 'x', 'bogus', 1, 'd', 1)",
        )
        .run(),
    ).toThrow(/CHECK constraint failed/);
  });

  it('hands out increasing server_seq values', () => {
    const db = openDb(':memory:');
    migrate(db);
    expect(currentServerSeq(db)).toBe(0);
    expect(nextServerSeq(db)).toBe(1);
    expect(nextServerSeq(db)).toBe(2);
    expect(currentServerSeq(db)).toBe(2);
  });
});
