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
  carbs: 'g carbs',
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

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The Monday of the local week containing `key` (spec §4: weeks are Monday-first). */
export function startOfWeek(key: string): string {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  const date = new Date(y, m - 1, d);
  // getDay(): 0 = Sunday. Monday-first means Sunday is 6 days into the week, not 0.
  const offset = (date.getDay() + 6) % 7;
  return shiftDay(key, -offset);
}

/** The seven local day keys of the week starting at `monday`, in order. */
export function weekDates(monday: string): string[] {
  return Array.from({ length: 7 }, (_, i) => shiftDay(monday, i));
}

/** "Wed 16 Sep" — short enough for a 375 px row header. */
export function formatDayLabel(key: string): string {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  const date = new Date(y, m - 1, d);
  return `${WEEKDAYS[date.getDay()]} ${d} ${MONTHS[m - 1]}`;
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
  if (!/^\d+(\.\d+)?$/.test(normalized)) return null;
  // An absurdly long digit string overflows to Infinity; never hand that to a ratio or dose.
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

/** A non-negative whole number from a text field (BG mg/dL), or null. No comma/decimal/exponent forms accepted. */
export function parseWholeNumber(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  return /^\d+$/.test(trimmed) ? Number(trimmed) : null;
}

/** Unicode vulgar fractions supported by `parseAmount`, and their exact `[numerator, denominator]`. */
const UNICODE_FRACTIONS: Record<string, [number, number]> = {
  '½': [1, 2],
  '⅓': [1, 3],
  '⅔': [2, 3],
  '¼': [1, 4],
  '¾': [3, 4],
  '⅛': [1, 8],
};
const UNICODE_FRACTION_CHARS = Object.keys(UNICODE_FRACTIONS).join('');

/**
 * A non-negative amount from a text field, accepting fractions (shared spec:
 * `testdata/number-parse-vectors.json`, `amount`). Backs food/meal amounts, label amounts,
 * portion quantities and servings — fields where "1/3" or "2/3 cup" are how the source (a
 * nutrition label, a measuring cup) actually reads. Accepts, in order:
 *  - a plain or leading-dot decimal ("1", "1.5", ".5"), or a single comma as decimal separator ("1,5");
 *  - an ASCII fraction "n/d" (denominator non-zero);
 *  - an ASCII mixed number "w n/d" (single space);
 *  - a unicode vulgar fraction (½ ⅓ ⅔ ¼ ¾ ⅛) alone, or preceded by a whole number with or
 *    without a space ("1½", "1 ½").
 * Every value is exact (numerator / denominator, no rounding). Returns null for anything else,
 * including negative numbers, hex/exponent forms, malformed fractions ("1/0", "1 1", "1//3"),
 * non-finite results (an absurdly long digit string), and two ambiguous-typo shapes that are
 * far more likely a mistyped mixed number than a deliberate improper fraction: a plain "n/d"
 * whose numerator has 2+ digits and exceeds the denominator ("11/2", "13/4"; "4/3", "12/16"
 * are still accepted), and a mixed "w n/d" whose fraction part is >= 1 ("1 3/2", "2 4/4").
 * Carbs grams, weights, ratios, BG and dose settings are NOT amounts: they keep `parseNonNegative`
 * (decimal + comma only, no fractions) since a fractional gram or ratio is never a legitimate entry.
 */
export function parseAmount(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;

  const commaDecimal = /^\d+,\d+$/.test(trimmed) ? trimmed.replace(',', '.') : trimmed;
  if (/^(\d+\.\d+|\.\d+|\d+)$/.test(commaDecimal)) {
    const value = Number(commaDecimal);
    return Number.isFinite(value) ? value : null;
  }

  // Plain "n/d": with 2+ numerator digits and numerator > denominator, this is very likely a
  // mistyped mixed number ("11/2" meant "1 1/2") rather than a genuine, deliberately-typed
  // improper fraction — reject it rather than silently returning 3.7x the intended value.
  const asciiFraction = /^(\d+)\/(\d+)$/.exec(trimmed);
  if (asciiFraction) {
    const [, numText, denText] = asciiFraction as unknown as [string, string, string];
    const num = Number(numText);
    const den = Number(denText);
    if (den === 0) return null;
    if (numText.length >= 2 && num > den) return null;
    const value = num / den;
    return Number.isFinite(value) ? value : null;
  }

  // Mixed "w n/d": a fraction part >= 1 ("1 3/2", "2 4/4") is malformed — never write it as
  // meaning "whole + fraction >= next whole", so reject rather than guess.
  const asciiMixed = /^(\d+) (\d+)\/(\d+)$/.exec(trimmed);
  if (asciiMixed) {
    const [, wholeText, numText, denText] = asciiMixed as unknown as [string, string, string, string];
    const whole = Number(wholeText);
    const num = Number(numText);
    const den = Number(denText);
    if (den === 0) return null;
    if (num / den >= 1) return null;
    const value = whole + num / den;
    return Number.isFinite(value) ? value : null;
  }

  const unicodeFraction = new RegExp(`^(\\d+)?[ ]?([${UNICODE_FRACTION_CHARS}])$`).exec(trimmed);
  if (unicodeFraction) {
    const whole = unicodeFraction[1] === undefined ? 0 : Number(unicodeFraction[1]);
    const [num, den] = UNICODE_FRACTIONS[unicodeFraction[2]!]!;
    const value = whole + num / den;
    return Number.isFinite(value) ? value : null;
  }

  return null;
}

/**
 * A timestamp for prose rather than a field: "9/20/26, 12:24:58 PM CDT" in en-US. The zone name
 * is part of it on purpose — the accountability text is sent to someone else, who has no reason
 * to assume the sender's timezone.
 */
export function formatStamp(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'long' });
}
