import type { FoodData, FoodSource, LogEntryData, LogItemData, MealData, Synced } from '@carbbook/core';
import type { UsdaFoodRow } from '../db/db';
import { usdaFoodId } from '../lib/ids';

export interface SearchResult {
  kind: 'meal' | 'food' | 'usda';
  /** meal/food id; USDA library entries use the deterministic saved-food id `usda-<fdc_id>`. */
  id: string;
  name: string;
  brand: string | null;
  source: FoodSource | null;
  carbs_per_100g: number | null;
}

export interface SearchInput {
  foods: Synced<FoodData>[];
  meals: Synced<MealData>[];
  usdaFoods: UsdaFoodRow[];
  /** ref_id → most recent eaten_at, from `lastLoggedByRef`. */
  lastLogged: Map<string, number>;
}

export interface SearchIndex {
  search(query: string, limit?: number): SearchResult[];
  /** Recently logged meals and foods, newest first (shown before typing). */
  recent(limit?: number): SearchResult[];
}

/** Lower-case, accents removed, split on anything that is not a letter or digit. */
export function tokenize(text: string): string[] {
  return (
    text
      .normalize('NFD')
      .replace(/\p{M}+/gu, '')
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

export function lastLoggedByRef(entries: Synced<LogEntryData>[], items: Synced<LogItemData>[]): Map<string, number> {
  const eatenAt = new Map(entries.filter((e) => e.deleted === 0).map((e) => [e.id, e.eaten_at]));
  const last = new Map<string, number>();
  for (const item of items) {
    if (item.deleted !== 0) continue;
    const at = eatenAt.get(item.log_entry_id);
    if (at !== undefined && at > (last.get(item.ref_id) ?? -Infinity)) last.set(item.ref_id, at);
  }
  return last;
}

interface Entry {
  result: SearchResult;
  tokens: string[];
  /** 0 meals + custom foods, 1 other saved foods, 2 USDA library (spec §6). */
  tier: 0 | 1 | 2;
  lastLogged: number | null;
}

/**
 * Local search index. Every query word must prefix-match a word of the name (or brand).
 * Order: tier, then most recently logged, then more exact word matches, then shorter names.
 */
export function buildSearchIndex(input: SearchInput): SearchIndex {
  const entries: Entry[] = [];
  const savedIds = new Set<string>();
  for (const meal of input.meals) {
    if (meal.deleted !== 0) continue;
    entries.push({
      result: { kind: 'meal', id: meal.id, name: meal.name, brand: null, source: null, carbs_per_100g: null },
      tokens: tokenize(meal.name),
      tier: 0,
      lastLogged: input.lastLogged.get(meal.id) ?? null,
    });
  }
  for (const food of input.foods) {
    if (food.deleted !== 0) continue;
    savedIds.add(food.id);
    const source = food.source ?? 'custom';
    entries.push({
      result: { kind: 'food', id: food.id, name: food.name, brand: food.brand ?? null, source, carbs_per_100g: food.carbs_per_100g },
      tokens: tokenize(`${food.name} ${food.brand ?? ''}`),
      tier: source === 'custom' ? 0 : 1,
      lastLogged: input.lastLogged.get(food.id) ?? null,
    });
  }
  for (const usda of input.usdaFoods) {
    const id = usdaFoodId(usda.fdc_id);
    if (savedIds.has(id)) continue;
    entries.push({
      result: { kind: 'usda', id, name: usda.name, brand: null, source: 'usda', carbs_per_100g: usda.carbs_per_100g },
      tokens: tokenize(usda.name),
      tier: 2,
      lastLogged: null,
    });
  }

  return {
    search(query, limit = 20) {
      const terms = tokenize(query).slice(0, 8);
      if (terms.length === 0) return [];
      const exact = (entry: Entry) => terms.filter((t) => entry.tokens.includes(t)).length;
      return entries
        .filter((entry) => terms.every((term) => entry.tokens.some((token) => token.startsWith(term))))
        .sort(
          (a, b) =>
            a.tier - b.tier ||
            (b.lastLogged ?? -Infinity) - (a.lastLogged ?? -Infinity) ||
            exact(b) - exact(a) ||
            a.result.name.length - b.result.name.length ||
            a.result.name.localeCompare(b.result.name),
        )
        .slice(0, limit)
        .map((entry) => entry.result);
    },
    recent(limit = 8) {
      return entries
        .filter((entry) => entry.lastLogged !== null)
        .sort((a, b) => b.lastLogged! - a.lastLogged!)
        .slice(0, limit)
        .map((entry) => entry.result);
    },
  };
}
