import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { estimateFor, REFUSAL_MESSAGES, type RefusalReason, validateDoseSettings } from '../src/dose/dose';
import { BgField, resolveBg } from '../src/ui/BgField';
import { DoseCard } from '../src/ui/DoseCard';
import { NOW, SEED_SETTINGS } from './render';

const carbs72 = { carbs_g: 72, complete: true };
const noop = () => {};

describe('estimateFor', () => {
  it('uses core window selection unless the user picks a window', () => {
    const auto = estimateFor({ settings: SEED_SETTINGS, windowName: null, eatenAt: NOW, carbs: carbs72, bg: 263 });
    expect(auto).toMatchObject({ ok: true, window: { name: 'Lunch' }, units: 11 });
    const chosen = estimateFor({ settings: SEED_SETTINGS, windowName: 'HS Snack', eatenAt: NOW, carbs: carbs72, bg: 263 });
    expect(chosen).toMatchObject({ ok: true, window: { name: 'HS Snack' }, meal_units: 6, units: 8 });
    expect(estimateFor({ settings: SEED_SETTINGS, windowName: 'Brunch', eatenAt: NOW, carbs: carbs72, bg: null })).toMatchObject({
      window: { name: 'Lunch' },
    });
  });

  it('has a message for every core refusal reason', () => {
    expect(Object.keys(REFUSAL_MESSAGES).sort()).toEqual([
      'exceeds_limit',
      'incomplete_carbs',
      'invalid_input',
      'invalid_ratio',
      'invalid_settings',
      'no_window',
    ]);
    expect(estimateFor({ settings: SEED_SETTINGS, windowName: null, eatenAt: Number.NaN, carbs: carbs72, bg: null })).toMatchObject({
      ok: false,
      reason: 'invalid_input',
    });
  });

  it('mentions the sanity limits when a raw dose would exceed them', () => {
    expect(REFUSAL_MESSAGES.exceeds_limit).toMatch(/50/);
  });
});

describe('validateDoseSettings', () => {
  it('accepts the seed settings', () => {
    expect(validateDoseSettings(SEED_SETTINGS)).toEqual([]);
  });

  it('reports missing windows, names, ratios and invalid rules', () => {
    expect(validateDoseSettings({ ...SEED_SETTINGS, windows: [] })).toContain('Add at least one time window.');
    const windows = SEED_SETTINGS.windows.map((w) => (w.name === 'Lunch' ? { ...w, ratio_g_per_unit: 0 } : w));
    expect(validateDoseSettings({ ...SEED_SETTINGS, windows })).toEqual(['Lunch: carb ratio must be greater than 0.']);
    expect(validateDoseSettings({ ...SEED_SETTINGS, windows: [{ name: ' ', start: '05:00', ratio_g_per_unit: 8 }] })).toEqual([
      'Every time window needs a name.',
    ]);
    const generic = 'Check window start times (HH:MM, no duplicates), correction step (> 0), units per step (0 or more) and rounding increment (> 0).';
    expect(validateDoseSettings({ ...SEED_SETTINGS, correction: { ...SEED_SETTINGS.correction, step: 0 } })).toEqual([generic]);
    const duplicate = [SEED_SETTINGS.windows[0]!, { ...SEED_SETTINGS.windows[1]!, start: '05:00' }];
    expect(validateDoseSettings({ ...SEED_SETTINGS, windows: duplicate })).toEqual([generic]);
  });
});

describe('DoseCard', () => {
  it('labels the dose an estimate and always shows the breakdown', () => {
    const estimate = estimateFor({ settings: SEED_SETTINGS, windowName: null, eatenAt: NOW, carbs: carbs72, bg: null });
    render(<DoseCard estimate={estimate} hasItems bg={null} lastDoseAt={null} now={NOW} />);
    expect(screen.getByTestId('dose-units')).toHaveTextContent('9 u');
    expect(screen.getByText('estimate')).toBeInTheDocument();
    expect(screen.getByTestId('dose-breakdown')).toHaveTextContent('72g ÷ 8 = 9.0 → 9u');
    expect(screen.getByText('No BG entered: correction not included.')).toBeInTheDocument();
  });

  it.each(Object.entries(REFUSAL_MESSAGES))('shows %s as a message and never a number', (reason, message) => {
    render(<DoseCard estimate={{ ok: false, reason: reason as RefusalReason, window: null }} hasItems bg={null} lastDoseAt={null} now={NOW} />);
    expect(screen.getByTestId('dose-refusal')).toHaveTextContent(message);
    expect(screen.queryByTestId('dose-units')).toBeNull();
    expect(screen.queryByTestId('dose-breakdown')).toBeNull();
  });

  it('falls back to a default message for an unknown refusal reason', () => {
    render(
      <DoseCard
        estimate={{ ok: false, reason: 'something_new' as RefusalReason, window: null }}
        hasItems
        bg={null}
        lastDoseAt={null}
        now={NOW}
      />,
    );
    expect(screen.getByTestId('dose-refusal')).toHaveTextContent("Can't estimate — check your numbers");
  });

  it('explains missing settings and warns about a recent dose', () => {
    render(<DoseCard estimate={null} hasItems bg={null} lastDoseAt={NOW - 3 * 3_600_000} now={NOW} />);
    expect(screen.getAllByRole('alert').map((a) => a.textContent)).toEqual([
      'No dose estimate: no dose settings apply at this time. Sync, or add settings in Settings.',
      'A dose was logged at 09:00, within the last 4 hours. This estimate does not subtract insulin on board.',
    ]);
  });
});

describe('BG entry', () => {
  const prefill = { mgdl: 180, trend: 'Flat', arrow: '→', age_ms: 4 * 60_000 };

  it('uses the Dexcom prefill until the user switches to manual entry', () => {
    expect(resolveBg(prefill, false, '')).toEqual({ mgdl: 180, source: 'dexcom', trend: 'Flat' });
    expect(resolveBg(prefill, true, '140')).toEqual({ mgdl: 140, source: 'manual', trend: null });
    expect(resolveBg(null, false, '')).toEqual({ mgdl: null, source: 'none', trend: null });
    expect(resolveBg(null, false, 'abc')).toEqual({ mgdl: null, source: 'none', trend: null });
  });

  it('asks for manual entry and says why', () => {
    const props = { manualMode: false, manualText: '', onManualModeChange: noop, onManualTextChange: noop };
    const { rerender } = render(<BgField status={{ kind: 'offline' }} prefill={null} {...props} />);
    expect(screen.getByText('Offline: enter BG manually.')).toBeInTheDocument();
    rerender(<BgField status={{ kind: 'unavailable', message: 'dexcom-api responded 500' }} prefill={null} {...props} />);
    expect(screen.getByText('Dexcom unavailable (dexcom-api responded 500): enter BG manually.')).toBeInTheDocument();
    rerender(<BgField status={null} prefill={prefill} {...props} />);
    expect(screen.getByTestId('bg-reading')).toHaveTextContent('BG 180 → · 4 min ago (Dexcom)');
    expect(screen.queryByLabelText('BG (mg/dL)')).toBeNull();
  });
});
