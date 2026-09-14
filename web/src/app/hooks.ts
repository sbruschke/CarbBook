import type { DoseSettingsData, LogEntryData, LogItemData, Synced } from '@carbbook/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { type BgResult, fetchBg } from '../bg/bg';
import { type CatalogData, loadCatalogData, loadUsdaFood, type UsdaFoodEntry } from '../db/catalog';
import { isLive } from '../db/db';
import { buildSearchIndex, lastLoggedByRef, type SearchIndex } from '../search/search';
import { useServices } from './services';

export function useCatalogData(): CatalogData | undefined {
  const { db } = useServices();
  return useLiveQuery(() => loadCatalogData(db), [db]);
}

export function useDoseVersions(): Synced<DoseSettingsData>[] | undefined {
  const { db } = useServices();
  return useLiveQuery(() => db.dose_settings.filter(isLive).toArray(), [db]);
}

/**
 * Live dose_settings versions eligible to drive dosing right now: live and not the subject of a
 * recorded server rejection (mirrors `selectActiveSettings`'s belt-and-braces exclusion, reactively,
 * so a version rejected while a push is in flight can never drive a dose estimate in the meantime).
 * Use this — never the raw `useDoseVersions()` — wherever a screen picks the *active* settings.
 */
export function useEligibleDoseVersions(): Synced<DoseSettingsData>[] | undefined {
  const { db } = useServices();
  return useLiveQuery(async () => {
    const [versions, errors] = await Promise.all([db.dose_settings.filter(isLive).toArray(), db.sync_error.toArray()]);
    const rejected = new Set(errors.filter((e) => e.table === 'dose_settings').map((e) => e.id));
    return versions.filter((v) => !rejected.has(v.id));
  }, [db]);
}

export function useLogData(): { entries: Synced<LogEntryData>[]; items: Synced<LogItemData>[] } | undefined {
  const { db } = useServices();
  return useLiveQuery(async () => {
    const [entries, items] = await Promise.all([db.log_entry.filter(isLive).toArray(), db.log_item.filter(isLive).toArray()]);
    return { entries, items };
  }, [db]);
}

/** Most recent eaten_at of a logged entry with a taken dose (spec §4.3 step 6 warning). */
export function lastDoseAt(entries: Synced<LogEntryData>[]): number | null {
  let last: number | null = null;
  for (const entry of entries) {
    if (entry.deleted === 0 && entry.taken_units != null && entry.taken_units > 0 && (last === null || entry.eaten_at > last)) {
      last = entry.eaten_at;
    }
  }
  return last;
}

export function useSearchIndex(): SearchIndex | undefined {
  const { db } = useServices();
  const usdaFoods = useLiveQuery(() => db.usda_food.toArray(), [db]);
  const saved = useLiveQuery(async () => {
    const [foods, meals, entries, items] = await Promise.all([
      db.food.toArray(),
      db.meal.toArray(),
      db.log_entry.toArray(),
      db.log_item.toArray(),
    ]);
    return { foods, meals, entries, items };
  }, [db]);
  return useMemo(
    () =>
      usdaFoods && saved
        ? buildSearchIndex({ foods: saved.foods, meals: saved.meals, usdaFoods, lastLogged: lastLoggedByRef(saved.entries, saved.items) })
        : undefined,
    [usdaFoods, saved],
  );
}

/** USDA library foods picked into a draft (calculator or meal) but not saved yet. */
export function useUsdaPicks(): { entries: UsdaFoodEntry[]; add: (fdcId: number) => Promise<UsdaFoodEntry | null> } {
  const { db } = useServices();
  const [entries, setEntries] = useState<UsdaFoodEntry[]>([]);
  const add = useCallback(
    async (fdcId: number) => {
      const entry = await loadUsdaFood(db, fdcId);
      if (entry) setEntries((current) => (current.some((e) => e.food.id === entry.food.id) ? current : [...current, entry]));
      return entry;
    },
    [db],
  );
  return { entries, add };
}

/** services.now(), refreshed every `intervalMs` so ages and warnings stay current. */
export function useNow(intervalMs = 30_000): number {
  const { now } = useServices();
  const [value, setValue] = useState(now);
  useEffect(() => {
    const handle = setInterval(() => setValue(now()), intervalMs);
    return () => clearInterval(handle);
  }, [now, intervalMs]);
  return value;
}

export const BG_REFRESH_MS = 5 * 60_000;

/** Latest `/api/bg` result; refetched every 5 minutes and when the browser comes back online. */
export function useBgStatus(): BgResult | null {
  const { api, now } = useServices();
  const [result, setResult] = useState<BgResult | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void fetchBg(api, now).then((next) => {
        if (!cancelled) setResult(next);
      });
    };
    load();
    const handle = setInterval(load, BG_REFRESH_MS);
    window.addEventListener('online', load);
    return () => {
      cancelled = true;
      clearInterval(handle);
      window.removeEventListener('online', load);
    };
  }, [api, now]);
  return result;
}
