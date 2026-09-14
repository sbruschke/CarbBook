import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { Db } from '../db';

export interface UsdaManifest {
  version: string;
  created_at: number;
  food_count: number;
  portion_count: number;
  json_file: string;
  json_sha256: string;
  sqlite_file: string;
  sqlite_sha256: string;
}

/**
 * Web bundle (gzip JSON), format 1:
 *   foods:    [fdc_id, name, carbs_per_100g | null, fiber_per_100g | null]
 *   portions: [id, fdc_id, label, kind, quantity, grams, description]
 */
export interface UsdaJsonBundle {
  format: 1;
  foods: [number, string, number | null, number | null][];
  portions: [number, number, string, string, number, number, string][];
}

export const MANIFEST_FILE = 'manifest.json';

/** Schema of the iOS SQLite bundle (same shape as the server tables). */
export const BUNDLE_SCHEMA = `
CREATE TABLE usda_food (fdc_id INTEGER PRIMARY KEY, name TEXT NOT NULL, carbs_per_100g REAL, fiber_per_100g REAL);
CREATE TABLE usda_portion (id INTEGER PRIMARY KEY, fdc_id INTEGER NOT NULL, label TEXT NOT NULL, kind TEXT NOT NULL,
  quantity REAL NOT NULL, grams REAL NOT NULL, description TEXT NOT NULL);
CREATE INDEX usda_portion_fdc ON usda_portion (fdc_id);
CREATE VIRTUAL TABLE usda_fts USING fts5 (name, content = 'usda_food', content_rowid = 'fdc_id',
  tokenize = 'unicode61 remove_diacritics 2');
CREATE TABLE bundle_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

function writeSqliteBundle(path: string, bundle: UsdaJsonBundle, version: string): void {
  rmSync(path, { force: true });
  const out = new Database(path);
  try {
    out.exec(BUNDLE_SCHEMA);
    const food = out.prepare('INSERT INTO usda_food VALUES (?, ?, ?, ?)');
    const portion = out.prepare('INSERT INTO usda_portion VALUES (?, ?, ?, ?, ?, ?, ?)');
    out.transaction(() => {
      for (const f of bundle.foods) food.run(...f);
      for (const p of bundle.portions) portion.run(...p);
      out.prepare("INSERT INTO bundle_meta VALUES ('version', ?)").run(version);
    })();
    out.exec("INSERT INTO usda_fts (usda_fts) VALUES ('rebuild')");
  } finally {
    out.close();
  }
}

/** Writes usda-<version>.json.gz, usda-<version>.sqlite and manifest.json; removes older bundles. */
export function buildUsdaBundles(db: Db, outDir: string, now: number): UsdaManifest {
  const foods = db
    .prepare('SELECT fdc_id, name, carbs_per_100g, fiber_per_100g FROM usda_food ORDER BY fdc_id')
    .raw()
    .all() as UsdaJsonBundle['foods'];
  const portions = db
    .prepare('SELECT id, fdc_id, label, kind, quantity, grams, description FROM usda_portion ORDER BY fdc_id, id')
    .raw()
    .all() as UsdaJsonBundle['portions'];
  const bundle: UsdaJsonBundle = { format: 1, foods, portions };
  const json = JSON.stringify(bundle);
  const version = `fdc-${sha256(json).slice(0, 12)}`;

  mkdirSync(outDir, { recursive: true });
  const jsonFile = `usda-${version}.json.gz`;
  const sqliteFile = `usda-${version}.sqlite`;
  const gz = gzipSync(json, { level: 9 });
  writeFileSync(join(outDir, jsonFile), gz);
  writeSqliteBundle(join(outDir, sqliteFile), bundle, version);

  const manifest: UsdaManifest = {
    version,
    created_at: now,
    food_count: foods.length,
    portion_count: portions.length,
    json_file: jsonFile,
    json_sha256: sha256(gz),
    sqlite_file: sqliteFile,
    sqlite_sha256: sha256(readFileSync(join(outDir, sqliteFile))),
  };
  const tmp = join(outDir, `${MANIFEST_FILE}.tmp`);
  writeFileSync(tmp, JSON.stringify(manifest, null, 2));
  renameSync(tmp, join(outDir, MANIFEST_FILE));

  for (const file of readdirSync(outDir)) {
    if (/^usda-fdc-[0-9a-f]{12}\.(json\.gz|sqlite)$/.test(file) && file !== jsonFile && file !== sqliteFile) {
      rmSync(join(outDir, file));
    }
  }
  return manifest;
}

export function readManifest(dir: string): UsdaManifest | null {
  const path = join(dir, MANIFEST_FILE);
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as UsdaManifest) : null;
}
