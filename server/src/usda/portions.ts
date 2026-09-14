import type { PortionKind, VolumeUnit } from '@carbbook/core';

/** A food_portion.csv row (all FDC datasets share these columns). */
export interface FdcPortionRow {
  id: string;
  fdc_id: string;
  amount: string;
  measure_unit_id: string;
  portion_description: string;
  modifier: string;
  gram_weight: string;
}

export interface UsdaPortion {
  id: number;
  fdc_id: number;
  /** Core volume unit id when kind is "volume", otherwise the human label. */
  label: string;
  kind: PortionKind;
  quantity: number;
  grams: number;
  /** Original USDA wording, e.g. "cup, chopped". */
  description: string;
}

export const UNDETERMINED_UNIT_ID = '9999';

/** Lower-case USDA spellings → core volume unit id and multiplier. Longest match wins. */
const VOLUME_ALIASES: ReadonlyArray<readonly [string, VolumeUnit, number]> = (
  [
    ['fluid ounces', 'floz', 1],
    ['fluid ounce', 'floz', 1],
    ['fl oz', 'floz', 1],
    ['tablespoons', 'tbsp', 1],
    ['tablespoon', 'tbsp', 1],
    ['tbsp', 'tbsp', 1],
    ['teaspoons', 'tsp', 1],
    ['teaspoon', 'tsp', 1],
    ['tsp', 'tsp', 1],
    ['cups', 'cup', 1],
    ['cup', 'cup', 1],
    ['milliliters', 'ml', 1],
    ['milliliter', 'ml', 1],
    ['cubic centimeters', 'ml', 1],
    ['cubic centimeter', 'ml', 1],
    ['ml', 'ml', 1],
    ['liters', 'l', 1],
    ['liter', 'l', 1],
    ['quarts', 'cup', 4],
    ['quart', 'cup', 4],
    ['pints', 'cup', 2],
    ['pint', 'cup', 2],
    ['gallons', 'cup', 16],
    ['gallon', 'cup', 16],
  ] as const
)
  .slice()
  .sort((a, b) => b[0].length - a[0].length);

/** Mass portions duplicate the always-available mass units, so they are dropped. */
const MASS_WORDS = new Set(['oz', 'ounce', 'ounces', 'lb', 'lbs', 'pound', 'pounds', 'g', 'gram', 'grams', 'kg']);
/** Unit names that add nothing when a modifier is present ("each, large" → "large"). */
const GENERIC_UNITS = new Set(['each', 'unit']);
const SERVING_RE = /^(serving|nlea serving|quantity not specified|guideline amount)/i;

function matchVolume(text: string): { unit: VolumeUnit; factor: number; rest: string } | null {
  const lower = text.toLowerCase();
  for (const [alias, unit, factor] of VOLUME_ALIASES) {
    if (!lower.startsWith(alias)) continue;
    const next = lower.charAt(alias.length);
    if (next === '' || next === ' ' || next === ',' || next === '(' || next === ';') {
      return { unit, factor, rest: text.slice(alias.length).replace(/^[\s,;]+/, '') };
    }
  }
  return null;
}

/** "1 cup" → 1, "1/4 cup" → 0.25, "1 1/2 cups" → 1.5. */
export function splitLeadingQuantity(text: string): { quantity: number | null; text: string } {
  const match = /^(\d+\s+\d+\/\d+|\d+\/\d+|\d*\.?\d+)\s+(.+)$/.exec(text);
  if (!match) return { quantity: null, text };
  const token = match[1]!;
  let quantity: number;
  if (token.includes('/')) {
    const [whole, fraction] = token.includes(' ') ? token.split(/\s+/) : ['0', token];
    const [num, den] = fraction!.split('/').map(Number);
    quantity = Number(whole) + num! / den!;
  } else {
    quantity = Number(token);
  }
  return { quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : null, text: match[2]! };
}

function positive(value: string): number | null {
  const n = Number(value);
  return value.trim() !== '' && Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Normalizes an FDC portion row to core's portion model:
 * - Foundation: unit in measure_unit_id, text in modifier ("1.0" + cup + "chopped").
 * - SR Legacy: measure_unit_id 9999, unit is the start of modifier ("1" + "cup, chopped").
 * - FNDDS: measure_unit_id 9999, amount empty, "1 cup, cooked" in portion_description; modifier is a code.
 * Returns null for zero-gram rows and mass portions.
 */
export function normalizePortion(row: FdcPortionRow, unitNames: ReadonlyMap<string, string>): UsdaPortion | null {
  const grams = positive(row.gram_weight);
  if (grams === null) return null;
  const unitName = row.measure_unit_id === UNDETERMINED_UNIT_ID ? undefined : unitNames.get(row.measure_unit_id);
  const description = row.portion_description.trim();
  const modifier = row.modifier.trim();

  let quantity = positive(row.amount) ?? 1;
  let text: string;
  if (unitName) {
    const extra = [description, modifier].filter(Boolean);
    text = (GENERIC_UNITS.has(unitName.toLowerCase()) && extra.length > 0 ? extra : [unitName, ...extra]).join(', ');
  } else if (description) {
    const split = splitLeadingQuantity(description);
    quantity = split.quantity ?? 1;
    text = split.text;
  } else {
    text = modifier;
  }
  if (!text) return null;

  const base = { id: Number(row.id), fdc_id: Number(row.fdc_id), grams, description: text };
  const volume = matchVolume(text);
  if (volume && !/\byields?\b/i.test(volume.rest)) {
    return { ...base, label: volume.unit, kind: 'volume', quantity: quantity * volume.factor };
  }
  const firstWord = text.toLowerCase().split(/[\s,(]+/)[0] ?? '';
  if (MASS_WORDS.has(firstWord)) return null;
  return { ...base, label: text, kind: SERVING_RE.test(text) ? 'serving' : 'count', quantity };
}
