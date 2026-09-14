import { type CorrectionMode, type DoseSettingsData, parseHHMM } from '@carbbook/core';
import { useState } from 'react';
import { useServices } from '../app/services';
import { validateDoseSettings } from '../dose/dose';
import { uuidv7 } from '../lib/ids';
import { fromDateTimeLocal, toDateTimeLocal } from '../ui/format';

interface WindowDraft {
  key: string;
  name: string;
  start: string;
  ratio: string;
}

const numText = (n: number | null) => (n !== null && Number.isFinite(n) ? String(n) : '');
const num = (text: string) => (text.trim() === '' ? Number.NaN : Number(text));

/**
 * Edits a copy of a version and always saves a NEW dose_settings record (new id + effective
 * date): versions are append-only on the server.
 */
export function DoseSettingsEditor(props: { initial: DoseSettingsData; onDone: (saved: boolean) => void }) {
  const { initial } = props;
  const { store, now } = useServices();
  const [windows, setWindows] = useState<WindowDraft[]>(() =>
    initial.windows.map((w) => ({ key: uuidv7(), name: w.name, start: w.start, ratio: numText(w.ratio_g_per_unit) })),
  );
  const [threshold, setThreshold] = useState(numText(initial.correction.threshold));
  const [step, setStep] = useState(numText(initial.correction.step));
  const [unitsPerStep, setUnitsPerStep] = useState(numText(initial.correction.units_per_step));
  const [mode, setMode] = useState<CorrectionMode>(initial.correction.mode);
  const [increment, setIncrement] = useState(numText(initial.rounding.increment));
  const [roundDown, setRoundDown] = useState(numText(initial.rounding.round_down_below_bg));
  const [effectiveText, setEffectiveText] = useState(() => toDateTimeLocal(now()));
  const [errors, setErrors] = useState<string[]>([]);

  const update = (key: string, patch: Partial<WindowDraft>) =>
    setWindows((rows) => rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  async function save() {
    const draft: DoseSettingsData = {
      id: uuidv7(now()),
      effective_from: fromDateTimeLocal(effectiveText) ?? Number.NaN,
      windows: windows.map((w) => ({ name: w.name.trim(), start: w.start, ratio_g_per_unit: num(w.ratio) })),
      correction: { threshold: num(threshold), step: num(step), units_per_step: num(unitsPerStep), mode },
      rounding: { increment: num(increment), round_down_below_bg: roundDown.trim() === '' ? null : num(roundDown) },
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
            onChange={(e) => update(w.key, { ratio: e.target.value })}
          />
          <button type="button" aria-label={`Remove window ${i + 1}`} onClick={() => setWindows((rows) => rows.filter((r) => r.key !== w.key))}>
            ✕
          </button>
        </div>
      ))}
      <button type="button" onClick={() => setWindows((rows) => [...rows, { key: uuidv7(), name: '', start: '12:00', ratio: '' }])}>
        Add window
      </button>
      <h3>Correction</h3>
      <label>
        Threshold (mg/dL)
        <input inputMode="numeric" value={threshold} onChange={(e) => setThreshold(e.target.value)} />
      </label>
      <label>
        Step (mg/dL)
        <input inputMode="numeric" value={step} onChange={(e) => setStep(e.target.value)} />
      </label>
      <label>
        Units per step
        <input inputMode="decimal" value={unitsPerStep} onChange={(e) => setUnitsPerStep(e.target.value)} />
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
        <input inputMode="decimal" value={increment} onChange={(e) => setIncrement(e.target.value)} />
      </label>
      <label>
        Round down when BG is below (mg/dL, optional)
        <input inputMode="numeric" value={roundDown} onChange={(e) => setRoundDown(e.target.value)} />
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
