import {
  isValidCarbsPer100g,
  isValidCarbsPer100ml,
  isValidPortionCarbs,
  isVolumeUnit,
  MAX_CARBS_PER_100ML,
  MAX_PORTION_CARBS_G,
  VOLUME_UNITS,
  type FoodData,
  type PortionData,
  type PortionKind,
  type VolumeUnit,
} from '@carbbook/core';
import type { FoodDraft } from '../lib/wire';

const trim2 = (n: number) => String(Number(n.toFixed(2)));

/** Nutrition label → carbs per 100 g (spec §8 "create from label"), 2 decimals. */
export function carbsPer100gFromLabel(servingGrams: number | null, carbsPerServing: number | null): number | null {
  if (servingGrams === null || carbsPerServing === null || !(servingGrams > 0) || !(carbsPerServing >= 0)) return null;
  return Number(((carbsPerServing / servingGrams) * 100).toFixed(2));
}

/** Unit offered by the "amount + unit = N g carbs" label entry (any-unit foods addendum). */
export type LabelUnit = 'g' | VolumeUnit | 'other';

/** A portion to add or update when label entry produces one (volume-with-weight, or a named piece/serving). */
export interface LabelPortionPatch {
  label: string;
  kind: PortionKind;
  quantity: number;
  grams: number | null;
  carbs_g: number | null;
}

export interface LabelBasis {
  carbs_per_100g: number | null;
  carbs_per_100ml: number | null;
  portion: LabelPortionPatch | null;
}

/**
 * "Amount [unit] contains N g carbs" -> the carb basis it maps to (any-unit foods addendum).
 * - g -> carbs_per_100g.
 * - a volume unit -> carbs_per_100ml; an optional weight also becomes a volume portion so grams
 *   work (density = grams / (quantity * unit_ml)), matching how existing volume portions work.
 * - a named piece/serving ("other") -> a portion with carbs_g; an optional weight also sets
 *   carbs_per_100g directly, since a known weight for a known carb count gives that basis for free.
 */
export function labelBasisFromEntry(params: {
  unit: LabelUnit;
  amount: number | null;
  carbs: number | null;
  weight: number | null;
  label: string;
}): LabelBasis | { error: string } {
  const { unit, amount, carbs, weight, label } = params;
  if (amount === null || !(amount > 0)) return { error: 'Enter an amount greater than 0.' };
  if (carbs === null || !(carbs >= 0)) return { error: 'Enter the carbs from the label.' };

  if (unit === 'g') {
    const carbs_per_100g = carbsPer100gFromLabel(amount, carbs);
    if (!isValidCarbsPer100g(carbs_per_100g)) return { error: 'Carbs per 100 g must be a number from 0 to 100.' };
    return { carbs_per_100g, carbs_per_100ml: null, portion: null };
  }

  if (isVolumeUnit(unit)) {
    const carbs_per_100ml = (carbs / (amount * VOLUME_UNITS[unit])) * 100;
    if (!isValidCarbsPer100ml(carbs_per_100ml)) {
      return { error: `Carbs per 100 ml must be a number from 0 to ${MAX_CARBS_PER_100ML}.` };
    }
    const portion: LabelPortionPatch | null =
      weight !== null && weight > 0 ? { label: unit, kind: 'volume', quantity: amount, grams: weight, carbs_g: null } : null;
    return { carbs_per_100g: null, carbs_per_100ml, portion };
  }

  // 'other': a named piece/serving (free-text label).
  const trimmedLabel = label.trim();
  if (!trimmedLabel) return { error: 'Enter a name for the portion (e.g. "bar", "slice").' };
  if (!isValidPortionCarbs(carbs)) return { error: `Carbs per portion must be a number from 0 to ${MAX_PORTION_CARBS_G}.` };
  const kind: PortionKind = trimmedLabel.toLowerCase() === 'serving' ? 'serving' : 'count';
  let carbs_per_100g: number | null = null;
  if (weight !== null && weight > 0) {
    carbs_per_100g = carbsPer100gFromLabel(weight, carbs);
    if (!isValidCarbsPer100g(carbs_per_100g)) return { error: 'Carbs per 100 g must be a number from 0 to 100.' };
  }
  return {
    carbs_per_100g,
    carbs_per_100ml: null,
    portion: { label: trimmedLabel, kind, quantity: amount, grams: weight !== null && weight > 0 ? weight : null, carbs_g: carbs },
  };
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

/**
 * The carb basis as the user entered it (any-unit foods addendum): "48 g carbs per cup" rather
 * than always "per 100 g". Null when the food has no valid carb basis at all.
 */
export function foodBasisSummary(food: FoodData, portions: PortionData[]): string | null {
  if (isValidCarbsPer100g(food.carbs_per_100g)) return `${trim2(food.carbs_per_100g)} g carbs per 100 g`;
  if (isValidCarbsPer100ml(food.carbs_per_100ml)) {
    // Prefer the volume portion the user weighed (its unit and amount are what they typed).
    const vp = portions.find((p) => p.kind === 'volume' && isVolumeUnit(p.label) && p.grams != null);
    if (vp) {
      const n = (food.carbs_per_100ml * vp.quantity * VOLUME_UNITS[vp.label as VolumeUnit]) / 100;
      const qty = vp.quantity === 1 ? '' : `${trim2(vp.quantity)} `;
      return `${trim2(n)} g carbs per ${qty}${vp.label}`;
    }
    const perCup = (food.carbs_per_100ml * VOLUME_UNITS.cup) / 100;
    return `${trim2(perCup)} g carbs per cup`;
  }
  const piece = portions.find((p) => p.kind !== 'volume' && isValidPortionCarbs(p.carbs_g));
  if (piece) {
    const qty = piece.quantity === 1 ? '' : `${trim2(piece.quantity)} `;
    return `${trim2(piece.carbs_g!)} g carbs per ${qty}${piece.label}`;
  }
  return null;
}
