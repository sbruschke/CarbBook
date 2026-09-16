import { type CorrectionMode, DOSE_LIMITS, type DoseSettingsData, parseHHMM } from '@carbbook/core';
import { useState } from 'react';
import { useServices } from '../app/services';
import { validateDoseSettings } from '../dose/dose';
import { uuidv7 } from '../lib/ids';
import { fromDateTimeLocal, parseNonNegative, parseWholeNumber, toDateTimeLocal } from '../ui/format';

interface WindowDraft {
  key: string;
  name: string;
  start: string;
  ratio: string;
  goalMin: string;
  goalMax: string;
}

const numText = (n: number | null) => (n !== null && Number.isFinite(n) ? String(n) : '');

type FieldKey = 'threshold' | 'step' | 'unitsPerStep' | 'increment' | 'roundDown' | `ratio:${string}` | `goal:${string}`;

/**
 * Edits a copy of a version and always saves a NEW dose_settings record (new id + effective
 * date): versions are append-only on the server.
 */
export function DoseSettingsEditor(props: { initial: DoseSettingsData; onDone: (saved: boolean) => void }) {
  const { initial } = props;
  const { store, now } = useServices();
  const [windows, setWindows] = useState<WindowDraft[]>(() =>
    initial.windows.map((w) => ({
      key: uuidv7(),
      name: w.name,
      start: w.start,
      ratio: numText(w.ratio_g_per_unit),
      goalMin: numText(w.carb_goal?.min ?? null),
      goalMax: numText(w.carb_goal?.max ?? null),
    })),
  );
  const [threshold, setThreshold] = useState(numText(initial.correction.threshold));
  const [step, setStep] = useState(numText(initial.correction.step));
  const [unitsPerStep, setUnitsPerStep] = useState(numText(initial.correction.units_per_step));
  const [mode, setMode] = useState<CorrectionMode>(initial.correction.mode);
  const [increment, setIncrement] = useState(numText(initial.rounding.increment));
  const [roundDown, setRoundDown] = useState(numText(initial.rounding.round_down_below_bg));
  const [effectiveText, setEffectiveText] = useState(() => toDateTimeLocal(now()));
  const [errors, setErrors] = useState<string[]>([]);
  const [invalid, setInvalid] = useState<Set<FieldKey>>(new Set());

  const update = (key: string, patch: Partial<WindowDraft>) =>
    setWindows((rows) => rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  async function save() {
    // Strict parsing (no hex, exponents, Infinity or junk): a loosely parsed number here would
    // silently change every dose estimate. mg/dL values are whole numbers; amounts may be decimal.
    const fieldErrors: string[] = [];
    const badFields = new Set<FieldKey>();
    const field = (key: FieldKey, text: string, parse: (t: string) => number | null, message: string) => {
      const value = parse(text);
      if (value === null) {
        fieldErrors.push(message);
        badFields.add(key);
        return Number.NaN;
      }
      return value;
    };
    const parsedWindows = windows.map((w, i) => {
      const both = w.goalMin.trim() !== '' && w.goalMax.trim() !== '';
      const neither = w.goalMin.trim() === '' && w.goalMax.trim() === '';
      let carbGoal: { min: number; max: number } | null = null;
      if (!neither) {
        if (!both) {
          fieldErrors.push(`Window ${i + 1} carb goal needs both a minimum and a maximum, or neither.`);
          badFields.add(`goal:${w.key}`);
        } else {
          // Carb grams are not "amounts": strict decimal only, no fractions (same rule as ratios).
          const min = field(`goal:${w.key}`, w.goalMin, parseNonNegative, `Window ${i + 1} carb goal minimum must be a number.`);
          const max = field(`goal:${w.key}`, w.goalMax, parseNonNegative, `Window ${i + 1} carb goal maximum must be a number.`);
          if (Number.isFinite(min) && Number.isFinite(max)) {
            if (min > max) {
              fieldErrors.push(`Window ${i + 1} carb goal minimum must not be above its maximum.`);
              badFields.add(`goal:${w.key}`);
            } else if (max > DOSE_LIMITS.maxCarbsG) {
              fieldErrors.push(`Window ${i + 1} carb goal maximum must be ${DOSE_LIMITS.maxCarbsG} g or less.`);
              badFields.add(`goal:${w.key}`);
            } else {
              carbGoal = { min, max };
            }
          }
        }
      }
      return {
        name: w.name.trim(),
        start: w.start,
        ratio_g_per_unit: field(`ratio:${w.key}`, w.ratio, parseNonNegative, `Window ${i + 1} carb ratio must be a number (like 8 or 12.5).`),
        carb_goal: carbGoal,
      };
    });
    const correction = {
      threshold: field('threshold', threshold, parseWholeNumber, 'Threshold must be a whole number of mg/dL.'),
      step: field('step', step, parseWholeNumber, 'Step must be a whole number of mg/dL.'),
      units_per_step: field('unitsPerStep', unitsPerStep, parseNonNegative, 'Units per step must be a number (like 1 or 0.5).'),
      mode,
    };
    const rounding = {
      increment: field('increment', increment, parseNonNegative, 'Round to increment must be a number (like 1 or 0.5).'),
      round_down_below_bg:
        roundDown.trim() === ''
          ? null
          : field('roundDown', roundDown, parseWholeNumber, 'Round down when BG is below must be empty or a whole number of mg/dL.'),
    };
    setInvalid(badFields);
    if (fieldErrors.length > 0) {
      setErrors(fieldErrors);
      return;
    }
    const draft: DoseSettingsData = {
      id: uuidv7(now()),
      effective_from: fromDateTimeLocal(effectiveText) ?? Number.NaN,
      windows: parsedWindows,
      correction,
      rounding,
    };
    const problems = validateDoseSettings(draft);
    if (!Number.isFinite(draft.effective_from)) problems.push('Enter when these settings take effect.');
    setErrors(problems);
    if (problems.length > 0) return;
    draft.windows.sort((a, b) => parseHHMM(a.start) - parseHHMM(b.start));
    await store.save('dose_settings', draft);
    props.onDone(true);
  }

  return (
    <form
      aria-label="Dose settings editor"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h3>Time windows</h3>
      {windows.map((w, i) => (
        <div className="window-row" key={w.key}>
          <input aria-label={`Window ${i + 1} name`} value={w.name} onChange={(e) => update(w.key, { name: e.target.value })} />
          <input type="time" aria-label={`Window ${i + 1} start`} value={w.start} onChange={(e) => update(w.key, { start: e.target.value })} />
          <input
            aria-label={`Window ${i + 1} carb ratio (g per unit)`}
            inputMode="decimal"
            value={w.ratio}
            aria-invalid={invalid.has(`ratio:${w.key}`) || undefined}
            onChange={(e) => update(w.key, { ratio: e.target.value })}
          />
          <input
            aria-label={`Window ${i + 1} carb goal minimum (g)`}
            inputMode="decimal"
            placeholder="min"
            value={w.goalMin}
            aria-invalid={invalid.has(`goal:${w.key}`) || undefined}
            onChange={(e) => update(w.key, { goalMin: e.target.value })}
          />
          <input
            aria-label={`Window ${i + 1} carb goal maximum (g)`}
            inputMode="decimal"
            placeholder="max"
            value={w.goalMax}
            aria-invalid={invalid.has(`goal:${w.key}`) || undefined}
            onChange={(e) => update(w.key, { goalMax: e.target.value })}
          />
          <button type="button" aria-label={`Remove window ${i + 1}`} onClick={() => setWindows((rows) => rows.filter((r) => r.key !== w.key))}>
            ✕
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => setWindows((rows) => [...rows, { key: uuidv7(), name: '', start: '12:00', ratio: '', goalMin: '', goalMax: '' }])}
      >
        Add window
      </button>
      <h3>Correction</h3>
      <label>
        Threshold (mg/dL)
        <input inputMode="numeric" aria-invalid={invalid.has('threshold') || undefined} value={threshold} onChange={(e) => setThreshold(e.target.value)} />
      </label>
      <label>
        Step (mg/dL)
        <input inputMode="numeric" aria-invalid={invalid.has('step') || undefined} value={step} onChange={(e) => setStep(e.target.value)} />
      </label>
      <label>
        Units per step
        <input inputMode="decimal" aria-invalid={invalid.has('unitsPerStep') || undefined} value={unitsPerStep} onChange={(e) => setUnitsPerStep(e.target.value)} />
      </label>
      <label>
        Mode
        <select value={mode} onChange={(e) => setMode(e.target.value as CorrectionMode)}>
          <option value="started">Started steps (round up)</option>
          <option value="full">Full steps only (round down)</option>
          <option value="proportional">Proportional</option>
        </select>
      </label>
      <h3>Rounding</h3>
      <label>
        Round to increment (u)
        <input inputMode="decimal" aria-invalid={invalid.has('increment') || undefined} value={increment} onChange={(e) => setIncrement(e.target.value)} />
      </label>
      <label>
        Round down when BG is below (mg/dL, optional)
        <input inputMode="numeric" aria-invalid={invalid.has('roundDown') || undefined} value={roundDown} onChange={(e) => setRoundDown(e.target.value)} />
      </label>
      <label>
        Takes effect
        <input type="datetime-local" value={effectiveText} onChange={(e) => setEffectiveText(e.target.value)} />
      </label>
      {errors.length > 0 && (
        <ul role="alert" className="errors">
          {errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      )}
      <div className="button-row">
        <button type="submit" className="primary">
          Save as new version
        </button>
        <button type="button" onClick={() => props.onDone(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}
