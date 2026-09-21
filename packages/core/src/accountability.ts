/**
 * The accountability text: one copy-pasteable sentence pair about a log entry, in the wording the
 * user asked for —
 *
 *   "As of 9/20/26, 12:24:58 PM CDT my blood sugar is 170. I am eating something with 59 carbs and
 *    so am giving myself 7 units of fast acting insulin."
 *
 * It is a message about an entry, never a dose recommendation: it only restates what is already
 * logged. Anything missing is said plainly rather than guessed at, so a text can never imply a BG
 * or a dose that was not recorded.
 *
 * The timestamp arrives already formatted (`when`). Date formatting is locale/timezone work the
 * platform does far better than shared core would — the web passes `toLocaleString`, iOS passes a
 * `DateFormatter` — and keeping it out of here is what lets both clients produce the same sentence
 * from the same vectors.
 */
export interface AccountabilityInput {
  /** Local timestamp, already formatted, e.g. "9/20/26, 12:24:58 PM CDT". */
  when: string;
  /** Logged BG in mg/dL, or null when the entry has none. */
  bg_mgdl: number | null;
  /** The entry's carb total in grams. */
  carbs_g: number;
  /** Units actually taken, or null when no dose is recorded on the entry. */
  units: number | null;
}

/** Trailing zeros are noise in a sentence: 7 not 7.00, 59 not 59.0, 0.5 stays 0.5. */
function number(value: number, digits: number): string {
  return String(Number(value.toFixed(digits)));
}

function unitsPhrase(units: number): string {
  if (units === 0) return 'and so am not giving myself any fast acting insulin';
  const text = number(units, 2);
  return `and so am giving myself ${text} ${text === '1' ? 'unit' : 'units'} of fast acting insulin`;
}

/**
 * The text for one log entry. A non-finite carb total or BG is treated as missing rather than
 * printed — a sentence saying "NaN carbs" would be worse than one that admits the gap.
 */
export function accountabilityText(input: AccountabilityInput): string {
  const bg = input.bg_mgdl !== null && Number.isFinite(input.bg_mgdl) ? input.bg_mgdl : null;
  const opening = bg === null ? `As of ${input.when} I do not have a blood sugar reading.` : `As of ${input.when} my blood sugar is ${number(bg, 0)}.`;

  if (!Number.isFinite(input.carbs_g)) {
    return `${opening} I do not have a carb total for this meal.`;
  }
  const carbs = `I am eating something with ${number(input.carbs_g, 1)} carbs`;

  const units = input.units !== null && Number.isFinite(input.units) ? input.units : null;
  if (units === null) return `${opening} ${carbs} and have not recorded a dose yet.`;
  return `${opening} ${carbs} ${unitsPhrase(units)}.`;
}
