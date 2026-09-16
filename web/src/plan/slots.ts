import {
  activeSettings,
  type CarbGoal,
  type CarbResult,
  type Catalog,
  dayGoal,
  type DoseSettingsData,
  type DoseWindow,
  itemCarbs,
  parseHHMM,
  type PlanEntryData,
  type PlanItemData,
  type Synced,
  sumCarbs,
} from '@carbbook/core';
import { isLive } from '../db/db';
import { dayRange } from '../ui/format';

/**
 * Stable identity of a slot: a date plus a window name (spec §2: at most one live entry each).
 * Normalized (trimmed, lowercased) to match the server's uniqueness rule — `window_name` is
 * trimmed and compared case-insensitively there, so a slot must be found under this key
 * regardless of how its `window_name` is cased, or a save mints a duplicate the server rejects.
 */
export const slotKey = (date: string, windowName: string): string => `${date}|${windowName.trim().toLowerCase()}`;

export interface Slot {
  key: string;
  date: string;
  windowName: string;
  /** The live plan_entry for this slot, or null when nothing is planned here. */
  entry: Synced<PlanEntryData> | null;
  /** Live items in `position` order. */
  items: Synced<PlanItemData>[];
  /** Carbs computed live through core — plans never snapshot (spec §2). */
  carbs: CarbResult;
  goal: CarbGoal | null;
}

const NOON_MS = 12 * 3_600_000;

/**
 * The windows that apply to a calendar date: those of the dose-settings version effective at local
 * noon of that date. Callers must pass versions from the single eligible-versions path
 * (`useEligibleDoseVersions` / `selectActiveSettings`) — never the raw dose_settings table.
 */
export function windowsFor(versions: Synced<DoseSettingsData>[], date: string): DoseWindow[] {
  const settings = activeSettings(versions, dayRange(date)[0] + NOON_MS);
  return settings ? [...settings.windows].sort((a, b) => parseHHMM(a.start) - parseHHMM(b.start)) : [];
}

/** One slot per date × window, in date then window-start order. */
export function buildSlots(args: {
  dates: string[];
  windows: DoseWindow[];
  entries: Synced<PlanEntryData>[];
  items: Synced<PlanItemData>[];
  catalog: Catalog;
}): Slot[] {
  const { dates, windows, catalog } = args;
  const liveEntries = args.entries.filter(isLive);
  const byKey = new Map(liveEntries.map((e) => [slotKey(e.date, e.window_name), e]));
  const itemsByEntry = new Map<string, Synced<PlanItemData>[]>();
  for (const item of args.items.filter(isLive)) {
    itemsByEntry.set(item.plan_entry_id, [...(itemsByEntry.get(item.plan_entry_id) ?? []), item]);
  }

  return dates.flatMap((date) =>
    windows.map((window): Slot => {
      const entry = byKey.get(slotKey(date, window.name)) ?? null;
      const items = entry ? [...(itemsByEntry.get(entry.id) ?? [])].sort((a, b) => a.position - b.position) : [];
      return {
        key: slotKey(date, window.name),
        date,
        windowName: window.name,
        entry,
        items,
        carbs: sumCarbs(items.map((i) => itemCarbs(catalog, i.ref_type, i.ref_id, i.amount, i.unit))),
        goal: window.carb_goal ?? null,
      };
    }),
  );
}

/**
 * A day's planned carbs against the sum of that day's window goals (spec §3). Windows with no goal
 * contribute nothing to either side; with no goals at all the total has none, which `goalView`
 * renders as a plain number with no colour.
 *
 * Core's `dayGoal` takes `DoseWindow[]` and reads `carb_goal` off each — not the
 * `(CarbGoal | null)[]` this plan originally assumed, so each slot's goal is wrapped back into a
 * window-shaped stub before summing.
 */
export function dayTotal(slots: Slot[]): { carbs: CarbResult; goal: CarbGoal | null } {
  return {
    carbs: sumCarbs(slots.map((s) => s.carbs)),
    goal: dayGoal(slots.map((s) => ({ carb_goal: s.goal }) as DoseWindow)),
  };
}
