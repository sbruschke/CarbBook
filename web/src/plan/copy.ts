import { itemRefId, type PlanEntryData, type PlanItemData, type Synced } from '@carbbook/core';
import { isLive } from '../db/db';
import type { Change, Store } from '../db/store';

/** What to do when the target day already has planned slots (spec §4). */
export type CopyMode = 'replace' | 'merge' | 'skip';

export interface CopyResult {
  changes: Change[];
  /** Soft deletes to apply after the writes, items before their entry. */
  removed: { table: 'plan_entry' | 'plan_item'; id: string }[];
}

/** Target dates that already hold at least one live entry, in the order given. */
export function conflictDates(entries: Synced<PlanEntryData>[], dates: string[]): string[] {
  const live = new Set(entries.filter(isLive).map((e) => e.date));
  return dates.filter((date) => live.has(date));
}

/** Same normalization as `slotKey` in `./slots` — matches the server's trimmed, case-insensitive
 * window_name comparison, so a merge finds an existing slot even if its stored casing differs. */
const windowKey = (windowName: string): string => windowName.trim().toLowerCase();

/**
 * Computes the writes for one or more `from → to` day copies. Pure: no db, no clock — the caller
 * supplies `newId` (uuidv7) so the result is deterministic in tests. Copied slots are always
 * `planned` with no `log_entry_id`: copying a logged dinner plans it again, it does not claim it
 * was eaten.
 */
export function copyChanges(args: {
  pairs: { from: string; to: string }[];
  entries: Synced<PlanEntryData>[];
  items: Synced<PlanItemData>[];
  mode: CopyMode;
  newId: () => string;
}): CopyResult {
  const { mode, newId } = args;
  const liveEntries = args.entries.filter(isLive);
  const liveItems = args.items.filter(isLive);
  const itemsOf = (entryId: string) => liveItems.filter((i) => i.plan_entry_id === entryId).sort((a, b) => a.position - b.position);

  const changes: Change[] = [];
  const removed: CopyResult['removed'] = [];

  for (const { from, to } of args.pairs) {
    if (from === to) continue; // copying a day onto itself must never duplicate its own items
    const sources = liveEntries.filter((e) => e.date === from);
    if (sources.length === 0) continue;
    let targets = liveEntries.filter((e) => e.date === to);

    if (targets.length > 0) {
      if (mode === 'skip') continue;
      if (mode === 'replace') {
        for (const target of targets) {
          for (const item of itemsOf(target.id)) removed.push({ table: 'plan_item', id: item.id });
          removed.push({ table: 'plan_entry', id: target.id });
        }
        targets = [];
      }
    }

    for (const source of sources) {
      const existing = targets.find((t) => windowKey(t.window_name) === windowKey(source.window_name));
      const sourceItems = itemsOf(source.id);
      if (existing) {
        // merge: append after whatever is already in that slot.
        const base = itemsOf(existing.id).reduce((max, i) => Math.max(max, i.position + 1), 0);
        sourceItems.forEach((item, offset) => {
          const id = newId();
          changes.push({
            table: 'plan_item',
            data: {
              id,
              plan_entry_id: existing.id,
              ref_type: item.ref_type,
              ref_id: itemRefId(item.ref_type, item.ref_id, id),
              amount: item.amount,
              unit: item.unit,
              position: base + offset,
              label: item.label ?? null,
            },
          });
        });
        continue;
      }
      const entryId = newId();
      changes.push({
        table: 'plan_entry',
        data: {
          id: entryId,
          date: to,
          window_name: source.window_name,
          status: 'planned',
          note: source.note ?? null,
          log_entry_id: null,
        },
      });
      sourceItems.forEach((item, position) => {
        const id = newId();
        changes.push({
          table: 'plan_item',
          data: {
            id,
            plan_entry_id: entryId,
            ref_type: item.ref_type,
            ref_id: itemRefId(item.ref_type, item.ref_id, id),
            amount: item.amount,
            unit: item.unit,
            position,
            label: item.label ?? null,
          },
        });
      });
    }
  }
  return { changes, removed };
}

/**
 * Applies a `copyChanges` result: the new/updated rows and every soft delete in ONE IndexedDB
 * transaction, so a "replace" copy can never leave both the old and the new slot live — either
 * everything commits or nothing does.
 */
export async function applyCopy(store: Store, result: CopyResult): Promise<void> {
  await store.saveMany(result.changes, result.removed);
}
