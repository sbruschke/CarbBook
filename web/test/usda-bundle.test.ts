import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import type { CarbBookDb } from '../src/db/db';
import { getMeta } from '../src/db/meta';
import { ApiError } from '../src/lib/api';
import type { UsdaJsonBundle, UsdaManifest } from '../src/lib/wire';
import { CHECKSUM_MESSAGE, syncUsdaLibrary } from '../src/usda/bundle';
import { FakeApi, openTestDb } from './helpers';

const PB_AND_KALE: UsdaJsonBundle = {
  format: 1,
  foods: [
    [324860, 'Peanut butter, smooth style, with salt', 22.3, 4.8],
    [323505, 'Kale, raw', 4.42, 4.1],
  ],
  portions: [[119207, 324860, 'tbsp', 'volume', 2, 32, 'tablespoon']],
};

function serve(api: FakeApi, bundle: UsdaJsonBundle, version: string, sha?: string): UsdaManifest {
  const gz = gzipSync(JSON.stringify(bundle));
  const bytes = gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength);
  const manifest: UsdaManifest = {
    version,
    created_at: 1,
    food_count: bundle.foods.length,
    portion_count: bundle.portions.length,
    json_file: `usda-${version}.json.gz`,
    json_sha256: sha ?? createHash('sha256').update(gz).digest('hex'),
    json_url: `/api/usda/files/usda-${version}.json.gz`,
    sqlite_file: `usda-${version}.sqlite`,
    sqlite_sha256: 'not-used-by-web',
    sqlite_url: `/api/usda/files/usda-${version}.sqlite`,
  };
  api.on('GET', '/api/usda/manifest', () => manifest).on('GET', manifest.json_url, () => bytes);
  return manifest;
}

let db: CarbBookDb;
afterEach(async () => {
  await db.delete();
});

describe('syncUsdaLibrary', () => {
  it('downloads, verifies and stores the library', async () => {
    db = openTestDb();
    const api = new FakeApi();
    serve(api, PB_AND_KALE, 'fdc-aaaaaaaaaaaa');
    expect(await syncUsdaLibrary(db, api)).toEqual({ status: 'updated', version: 'fdc-aaaaaaaaaaaa', food_count: 2 });
    expect(await db.usda_food.get(323505)).toEqual({ fdc_id: 323505, name: 'Kale, raw', carbs_per_100g: 4.42, fiber_per_100g: 4.1 });
    expect(await db.usda_portion.get(119207)).toEqual({
      id: 119207, fdc_id: 324860, label: 'tbsp', kind: 'volume', quantity: 2, grams: 32, description: 'tablespoon',
    });
    expect(await getMeta(db, 'usda_version')).toBe('fdc-aaaaaaaaaaaa');
  });

  it('skips the download when the version is unchanged', async () => {
    db = openTestDb();
    const api = new FakeApi();
    const manifest = serve(api, PB_AND_KALE, 'fdc-aaaaaaaaaaaa');
    await syncUsdaLibrary(db, api);
    expect(await syncUsdaLibrary(db, api)).toEqual({ status: 'up_to_date', version: 'fdc-aaaaaaaaaaaa', food_count: 2 });
    expect(api.calls.filter((c) => c.path === manifest.json_url)).toHaveLength(1);
  });

  it('replaces the library when the version changes', async () => {
    db = openTestDb();
    const api = new FakeApi();
    serve(api, PB_AND_KALE, 'fdc-aaaaaaaaaaaa');
    await syncUsdaLibrary(db, api);
    serve(api, { format: 1, foods: [[323505, 'Kale, raw', 4.42, 4.1]], portions: [] }, 'fdc-bbbbbbbbbbbb');
    expect(await syncUsdaLibrary(db, api)).toMatchObject({ status: 'updated', version: 'fdc-bbbbbbbbbbbb' });
    expect(await db.usda_food.get(324860)).toBeUndefined();
    expect(await db.usda_portion.count()).toBe(0);
  });

  it('rejects a corrupted download and keeps the current library', async () => {
    db = openTestDb();
    const api = new FakeApi();
    serve(api, PB_AND_KALE, 'fdc-aaaaaaaaaaaa');
    await syncUsdaLibrary(db, api);
    serve(api, { format: 1, foods: [], portions: [] }, 'fdc-cccccccccccc', '0'.repeat(64));
    await expect(syncUsdaLibrary(db, api)).rejects.toThrow(CHECKSUM_MESSAGE);
    expect(await db.usda_food.count()).toBe(2);
    expect(await getMeta(db, 'usda_version')).toBe('fdc-aaaaaaaaaaaa');
  });

  it('reports when the server has no library yet', async () => {
    db = openTestDb();
    const api = new FakeApi().on('GET', '/api/usda/manifest', () => {
      throw new ApiError(404, 'usda_not_imported', 'Run `carbbook import-usda` on the server first');
    });
    expect(await syncUsdaLibrary(db, api)).toEqual({ status: 'not_imported' });
  });
});
