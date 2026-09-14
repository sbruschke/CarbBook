import {
  type CarbResult,
  DOSE_LIMITS,
  type DoseEstimate,
  type DoseSettingsData,
  estimateDose,
  minutesOfDay,
  parseHHMM,
} from '@carbbook/core';

export type RefusalReason = Extract<DoseEstimate, { ok: false }>['reason'];

/** Why core refused to estimate (spec §9) — shown instead of any number. */
export const REFUSAL_MESSAGES: Record<RefusalReason, string> = {
  incomplete_carbs: 'No dose estimate: an item is missing carb data or an amount.',
  invalid_input: 'No dose estimate: check the time, carbs and BG values.',
  invalid_settings: 'No dose estimate: the dose settings are invalid. Fix them in Settings.',
  no_window: 'No dose estimate: the dose settings have no time windows.',
  invalid_ratio: 'No dose estimate: this time window has no valid carb ratio.',
  exceeds_limit: `No dose estimate: the raw dose is above the ${DOSE_LIMITS.maxRawUnits}-unit sanity limit (carbs over ${DOSE_LIMITS.maxCarbsG} g or BG over ${DOSE_LIMITS.maxBg} can also trigger this). Check your numbers.`,
};

/** Fallback for any refusal reason not covered above (defensive — core's reason union is closed today). */
export const DEFAULT_REFUSAL_MESSAGE = "Can't estimate — check your numbers";

export function refusalMessage(reason: RefusalReason): string {
  return REFUSAL_MESSAGES[reason] ?? DEFAULT_REFUSAL_MESSAGE;
}

/**
 * A manual window choice is passed to core as settings with only that window, so core's own
 * window pick and ratio math still run. `null` (or an unknown name) keeps the automatic window.
 */
export function settingsForWindow(settings: DoseSettingsData, windowName: string | null): DoseSettingsData {
  const chosen = windowName ? settings.windows.find((w) => w.name === windowName) : undefined;
  return chosen ? { ...settings, windows: [chosen] } : settings;
}

export function estimateFor(input: {
  settings: DoseSettingsData;
  windowName: string | null;
  eatenAt: number;
  carbs: CarbResult;
  bg: number | null;
}): DoseEstimate {
  return estimateDose({
    settings: settingsForWindow(input.settings, input.windowName),
    minutes: minutesOfDay(new Date(input.eatenAt)),
    carbs: input.carbs,
    bg: input.bg,
  });
}

/** Problems that would stop core (or the server) from using a dose-settings draft. */
export function validateDoseSettings(draft: DoseSettingsData): string[] {
  const errors: string[] = [];
  if (draft.windows.length === 0) errors.push('Add at least one time window.');
  if (draft.windows.length > 24) errors.push('Use at most 24 time windows.');
  if (draft.windows.some((w) => w.name.trim() === '')) errors.push('Every time window needs a name.');
  if (!(draft.correction.threshold >= 0)) errors.push('Correction threshold must be 0 or more.');
  if (draft.rounding.round_down_below_bg !== null && !(draft.rounding.round_down_below_bg >= 0)) {
    errors.push('Round-down BG must be empty or 0 or more.');
  }
  const probe = (minutes: number) => estimateDose({ settings: draft, minutes, carbs: { carbs_g: 0, complete: true }, bg: null });
  const first = probe(0);
  if (!first.ok && first.reason === 'invalid_settings') {
    errors.push('Check window start times (HH:MM, no duplicates), correction step (> 0), units per step (0 or more) and rounding increment (> 0).');
    return errors;
  }
  for (const window of draft.windows) {
    const result = probe(parseHHMM(window.start));
    if (!result.ok && result.reason === 'invalid_ratio') errors.push(`${window.name || 'A window'}: carb ratio must be greater than 0.`);
  }
  return errors;
}
