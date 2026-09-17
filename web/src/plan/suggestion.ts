import { type CarbResult, type Catalog, itemCarbs, type PlanEntryData, type PlanItemData, type Synced, sumCarbs } from '@carbbook/core';
import { isLive } from '../db/db';
import { itemLabel } from '../ui/ItemEditor';
import { slotKey } from './slots';

export interface Suggestion {
  key: string;
  entry: Synced<PlanEntryData>;
  /** Live items in position order — what "Load" appends to the Calculator. */
  items: Synced<PlanItemData>[];
  names: string[];
  carbs: CarbResult;
}

/**
 * The planned slot the Calculator should offer right now (spec §5), or null. Never nags: a slot
 * that is already `logged` or `skipped`, or dismissed on this device, produces nothing. An empty
 * slot produces nothing either — there would be nothing to load.
 */
export function suggestionFor(args: {
  date: string;
  /** The window the Calculator is currently in; null (no window) means no suggestion. */
  windowName: string | null;
  entries: Synced<PlanEntryData>[];
  items: Synced<PlanItemData>[];
  catalog: Catalog;
  dismissed: Set<string>;
}): Suggestion | null {
  if (!args.windowName) return null;
  const key = slotKey(args.date, args.windowName);
  if (args.dismissed.has(key)) return null;
  const entry = args.entries.find((e) => isLive(e) && e.date === args.date && slotKey(e.date, e.window_name) === key);
  if (!entry || entry.status !== 'planned') return null;
  const items = args.items.filter((i) => isLive(i) && i.plan_entry_id === entry.id).sort((a, b) => a.position - b.position);
  if (items.length === 0) return null;
  return {
    key,
    entry,
    items,
    names: items.map((i) => itemLabel(args.catalog, i)),
    carbs: sumCarbs(items.map((i) => itemCarbs(args.catalog, i.ref_type, i.ref_id, i.amount, i.unit))),
  };
}
