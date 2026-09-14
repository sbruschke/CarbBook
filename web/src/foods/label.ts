import type { PortionKind } from '@carbbook/core';
import type { FoodDraft } from '../lib/wire';

/** Nutrition label → carbs per 100 g (spec §8 "create from label"), 2 decimals. */
export function carbsPer100gFromLabel(servingGrams: number | null, carbsPerServing: number | null): number | null {
  if (servingGrams === null || carbsPerServing === null || !(servingGrams > 0) || !(carbsPerServing >= 0)) return null;
  return Number(((carbsPerServing / servingGrams) * 100).toFixed(2));
}

/** Initial values for a new food (from a barcode draft or a typed/unknown code). */
export interface FoodPrefill {
  name?: string;
  brand?: string | null;
  carbs_per_100g?: number | null;
  fiber_per_100g?: number | null;
  source?: 'custom' | 'off';
  source_ref?: string | null;
  portions?: { label: string; kind: PortionKind; quantity: number; grams: number }[];
  barcode?: string | null;
  note?: string | null;
}

export function prefillFromDraft(draft: FoodDraft): FoodPrefill {
  return {
    name: draft.food.name,
    brand: draft.food.brand,
    carbs_per_100g: draft.food.carbs_per_100g,
    fiber_per_100g: draft.food.fiber_per_100g,
    source: 'off',
    source_ref: draft.food.source_ref,
    portions: draft.portions,
    barcode: draft.barcode,
    note: draft.serving_size
      ? `From Open Food Facts. Check against the label: serving size "${draft.serving_size}".`
      : 'From Open Food Facts. Check the values against the label.',
  };
}
