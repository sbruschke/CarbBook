import { PORTION_PREFIX, type PortionData } from '@carbbook/core';

const UNIT_NAMES: Record<string, string> = {
  g: 'g',
  kg: 'kg',
  oz: 'oz',
  lb: 'lb',
  ml: 'ml',
  l: 'l',
  tsp: 'tsp',
  tbsp: 'tbsp',
  floz: 'fl oz',
  cup: 'cup',
  serving: 'servings',
};

const trim = (n: number, digits: number) => String(Number(n.toFixed(digits)));

/** Display name for a unit id from core's foodUnits/mealUnits (`p:<portion id>` → "slice (30 g)"). */
export function unitLabel(unit: string, portions: PortionData[]): string {
  if (unit.startsWith(PORTION_PREFIX)) {
    const portion = portions.find((p) => p.id === unit.slice(PORTION_PREFIX.length));
    if (!portion) return 'unknown portion';
    // Unknown weight (any-unit foods): don't invent a gram figure.
    if (portion.grams === null) return portion.label;
    return `${portion.label} (${trim(portion.grams / portion.quantity, 1)} g)`;
  }
  return UNIT_NAMES[unit] ?? unit;
}

export const formatCarbs = (grams: number): string => `${trim(grams, 1)} g`;

export const formatUnits = (units: number): string => `${trim(units, 2)} u`;

const pad = (n: number) => String(n).padStart(2, '0');

/** Local "HH:MM". */
export function formatTime(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Local "YYYY-MM-DD". */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** [start, end) of a local day in ms. */
export function dayRange(key: string): [number, number] {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  return [new Date(y, m - 1, d).getTime(), new Date(y, m - 1, d + 1).getTime()];
}

export function shiftDay(key: string, days: number): string {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  return dayKey(new Date(y, m - 1, d + days).getTime());
}

/** Value for `<input type="datetime-local">`. */
export function toDateTimeLocal(ms: number): string {
  const d = new Date(ms);
  return `${dayKey(ms)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Parses a `datetime-local` value as local time; null when empty or invalid. */
export function fromDateTimeLocal(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const [, y, mo, d, h, mi] = match.map(Number) as [number, number, number, number, number, number];
  return new Date(y, mo - 1, d, h, mi).getTime();
}

export function formatAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  return minutes < 1 ? 'just now' : `${minutes} min ago`;
}

/**
 * A non-negative amount from a text field: digits with an optional decimal part
 * (`^\d+(\.\d+)?$`), or null when empty/whitespace or not strictly a plain decimal.
 * Rejects anything `Number()` would otherwise accept loosely — hex ("0x64"), exponents
 * ("1e3"), binary ("0b1"), "Infinity", leading/trailing junk ("12O"). A single comma used
 * as a decimal separator ("1,5") is accepted here — this parser backs amount fields
 * (servings, quantities, grams, carbs, fiber, density), where a European-style comma is a
 * plausible typo worth accepting. BG entry uses `parseWholeNumber` instead, which does NOT
 * accept a comma: mg/dL is always a whole number, so there's no legitimate comma form to
 * accept, and guessing at one risks silently taking the wrong reading.
 */
export function parseNonNegative(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const normalized = /^\d+,\d+$/.test(trimmed) ? trimmed.replace(',', '.') : trimmed;
  return /^\d+(\.\d+)?$/.test(normalized) ? Number(normalized) : null;
}

/** A non-negative whole number from a text field (BG mg/dL), or null. No comma/decimal/exponent forms accepted. */
export function parseWholeNumber(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  return /^\d+$/.test(trimmed) ? Number(trimmed) : null;
}
