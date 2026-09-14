import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { initDatabase } from '../src/init';
import { buildUsdaBundles, readManifest, type UsdaJsonBundle } from '../src/usda/bundle';
import { importUsda } from '../src/usda/import';
import { USDA_FIXTURES } from './fixtures';

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe('buildUsdaBundles', () => {
  it('writes a gzip JSON bundle, a SQLite bundle and a manifest', async () => {
    const db = initDatabase(':memory:');
    await importUsda(db, USDA_FIXTURES);
    const dir = mkdtempSync(join(tmpdir(), 'carbbook-bundle-'));
    const manifest = buildUsdaBundles(db, dir, 42);

    expect(manifest).toMatchObject({ created_at: 42, food_count: 12, portion_count: 28 });
    expect(manifest.version).toMatch(/^fdc-[0-9a-f]{12}$/);
    expect(readManifest(dir)).toEqual(manifest);

    const gz = readFileSync(join(dir, manifest.json_file));
    expect(sha256(gz)).toBe(manifest.json_sha256);
    const json = JSON.parse(gunzipSync(gz).toString('utf8')) as UsdaJsonBundle;
    expect(json.format).toBe(1);
    expect(json.foods).toContainEqual([324860, 'Peanut butter, smooth style, with salt', 22.3, 4.8]);
    expect(json.portions).toContainEqual([119207, 324860, 'tbsp', 'volume', 2, 32, 'tablespoon']);

    const sqlitePath = join(dir, manifest.sqlite_file);
    expect(sha256(readFileSync(sqlitePath))).toBe(manifest.sqlite_sha256);
    const bundle = new Database(sqlitePath, { readonly: true });
    expect(bundle.prepare("SELECT rowid FROM usda_fts WHERE usda_fts MATCH 'peanut'").pluck().all()).toEqual([324860]);
    expect(bundle.prepare("SELECT value FROM bundle_meta WHERE key = 'version'").pluck().get()).toBe(manifest.version);
    bundle.close();
  });

  it('keeps the version stable for identical data and removes superseded files', async () => {
    const db = initDatabase(':memory:');
    await importUsda(db, USDA_FIXTURES.slice(0, 1));
    const dir = mkdtempSync(join(tmpdir(), 'carbbook-bundle-'));
    const first = buildUsdaBundles(db, dir, 1);
    expect(buildUsdaBundles(db, dir, 2).version).toBe(first.version);

    await importUsda(db, USDA_FIXTURES);
    const second = buildUsdaBundles(db, dir, 3);
    expect(second.version).not.toBe(first.version);
    expect(existsSync(join(dir, first.json_file))).toBe(false);
    expect(existsSync(join(dir, first.sqlite_file))).toBe(false);
    expect(existsSync(join(dir, second.json_file))).toBe(true);
  });

  it('leaves existing immutable-cached files untouched on a re-import that yields the same version', async () => {
    const db = initDatabase(':memory:');
    await importUsda(db, USDA_FIXTURES);
    const dir = mkdtempSync(join(tmpdir(), 'carbbook-bundle-'));
    const first = buildUsdaBundles(db, dir, 1);
    const jsonPath = join(dir, first.json_file);
    const sqlitePath = join(dir, first.sqlite_file);
    const jsonStatBefore = statSync(jsonPath);
    const sqliteStatBefore = statSync(sqlitePath);

    const second = buildUsdaBundles(db, dir, 2);

    expect(second.version).toBe(first.version);
    expect(statSync(jsonPath).ino).toBe(jsonStatBefore.ino);
    expect(statSync(jsonPath).mtimeMs).toBe(jsonStatBefore.mtimeMs);
    expect(statSync(sqlitePath).ino).toBe(sqliteStatBefore.ino);
    expect(statSync(sqlitePath).mtimeMs).toBe(sqliteStatBefore.mtimeMs);
    // No .tmp leftovers from the skipped write.
    expect(readdirSync(dir).some((f) => f.endsWith('.tmp'))).toBe(false);
  });

  it('readManifest returns null when nothing was imported', () => {
    expect(readManifest(mkdtempSync(join(tmpdir(), 'carbbook-bundle-')))).toBeNull();
  });
});
