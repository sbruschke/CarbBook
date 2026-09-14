import type { RefType } from '@carbbook/core';
import { loadUsdaFood } from '../db/catalog';
import type { Change, Store } from '../db/store';
import { parseUsdaFoodId, usdaFoodId } from '../lib/ids';

/**
 * Copies a USDA library food and its portions into the synced `food`/`portion` tables
 * (`source: 'usda'`, `source_ref: <fdc_id>`) so references resolve on every device.
 * A live copy is left untouched; a deleted copy is restored.
 */
export async function saveUsdaFood(store: Store, fdcId: number): Promise<string> {
  const id = usdaFoodId(fdcId);
  const existing = await store.db.food.get(id);
  if (existing && existing.deleted === 0) return id;
  const entry = await loadUsdaFood(store.db, fdcId);
  if (!entry) throw new Error(`USDA food ${fdcId} is not in the downloaded library`);
  const changes: Change[] = [
    { table: 'food', data: entry.food },
    ...entry.portions.map((portion): Change => ({ table: 'portion', data: portion })),
  ];
  await store.saveMany(changes);
  return id;
}

/** Saves every not-yet-saved USDA food referenced by these meal or log items. */
export async function saveUsdaFoodsFor(store: Store, refs: { ref_type: RefType; ref_id: string }[]): Promise<void> {
  const fdcIds = new Set<number>();
  for (const ref of refs) {
    const fdcId = ref.ref_type === 'food' ? parseUsdaFoodId(ref.ref_id) : null;
    if (fdcId !== null) fdcIds.add(fdcId);
  }
  for (const fdcId of fdcIds) await saveUsdaFood(store, fdcId);
}
