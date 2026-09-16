import type { PlanEntryData } from '@carbbook/core';
import type { Change, Store } from '../db/store';
import { parseAmount } from '../ui/format';
import type { DraftItem } from '../ui/ItemEditor';
import { saveUsdaFoodsFor } from '../usda/materialize';

/**
 * Saves a plan slot and its items in one transaction (item key = plan_item id, order = position),
 * exactly as `saveMeal` does for meals. Every amount must already parse with `parseAmount` — the
 * editor blocks saving otherwise, so `!` here is safe.
 */
export async function saveSlot(
  store: Store,
  entry: PlanEntryData,
  items: DraftItem[],
  removedItemIds: string[] = [],
): Promise<void> {
  // A USDA library food picked into a plan must become a real `food` row, or the plan item would
  // dangle on every other device (same rule as the calculator and the meal editor).
  await saveUsdaFoodsFor(store, items);
  const changes: Change[] = [
    { table: 'plan_entry', data: entry },
    ...items.map(
      (item, position): Change => ({
        table: 'plan_item',
        data: {
          id: item.key,
          plan_entry_id: entry.id,
          ref_type: item.ref_type,
          ref_id: item.ref_id,
          amount: parseAmount(item.amount)!,
          unit: item.unit,
          position,
        },
      }),
    ),
  ];
  await store.saveMany(changes);
  for (const id of removedItemIds) await store.remove('plan_item', id);
}

/** Soft-deletes a slot: its items first, then the entry. */
export async function removeSlot(store: Store, entryId: string, itemIds: string[]): Promise<void> {
  for (const id of itemIds) await store.remove('plan_item', id);
  await store.remove('plan_entry', entryId);
}
