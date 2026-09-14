import type { PortionKind } from '@carbbook/core';
import type { CarbBookDb } from '../db/db';
import { getMeta, setMeta } from '../db/meta';
import { type Api, ApiError } from '../lib/api';
import type { UsdaJsonBundle, UsdaManifest } from '../lib/wire';

export type UsdaSyncResult =
  | { status: 'up_to_date' | 'updated'; version: string; food_count: number }
  | { status: 'not_imported' };

export interface BundleCodec {
  sha256Hex(bytes: ArrayBuffer): Promise<string>;
  gunzipText(bytes: ArrayBuffer): Promise<string>;
}

export const browserCodec: BundleCodec = {
  async sha256Hex(bytes) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  },
  async gunzipText(bytes) {
    const body = new Response(bytes).body;
    if (!body) throw new Error('USDA library download was empty');
    return new Response(body.pipeThrough(new DecompressionStream('gzip'))).text();
  },
};

export const CHECKSUM_MESSAGE = 'USDA library download was corrupted (checksum mismatch). Try again.';

/**
 * Downloads the versioned USDA bundle (spec §5/§6) when the server has a version this browser
 * does not; verifies its sha256, then replaces the local library in one transaction.
 */
export async function syncUsdaLibrary(db: CarbBookDb, api: Api, codec: BundleCodec = browserCodec): Promise<UsdaSyncResult> {
  let manifest: UsdaManifest;
  try {
    manifest = await api.get<UsdaManifest>('/api/usda/manifest');
  } catch (error) {
    if (error instanceof ApiError && error.code === 'usda_not_imported') return { status: 'not_imported' };
    throw error;
  }
  const current = await getMeta(db, 'usda_version');
  if (current === manifest.version && (await db.usda_food.count()) > 0) {
    return { status: 'up_to_date', version: manifest.version, food_count: manifest.food_count };
  }

  const bytes = await api.getBytes(manifest.json_url);
  if ((await codec.sha256Hex(bytes)) !== manifest.json_sha256) throw new Error(CHECKSUM_MESSAGE);
  const bundle = JSON.parse(await codec.gunzipText(bytes)) as UsdaJsonBundle;
  if (bundle.format !== 1) throw new Error(`Unsupported USDA bundle format ${String(bundle.format)}`);

  await db.transaction('rw', [db.usda_food, db.usda_portion, db.meta], async () => {
    await db.usda_food.clear();
    await db.usda_portion.clear();
    await db.usda_food.bulkPut(
      bundle.foods.map(([fdc_id, name, carbs_per_100g, fiber_per_100g]) => ({ fdc_id, name, carbs_per_100g, fiber_per_100g })),
    );
    await db.usda_portion.bulkPut(
      bundle.portions.map(([id, fdc_id, label, kind, quantity, grams, description]) => ({
        id,
        fdc_id,
        label,
        kind: kind as PortionKind,
        quantity,
        grams,
        description,
      })),
    );
    await setMeta(db, 'usda_version', manifest.version);
  });
  return { status: 'updated', version: manifest.version, food_count: bundle.foods.length };
}
