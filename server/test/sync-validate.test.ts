import { describe, expect, it } from 'vitest';
import { TABLE_SPECS } from '../src/sync/tables';
import { decodeRow, validateRecord } from '../src/sync/validate';
import { doseSettings, food, mealItem } from './sync-helpers';

describe('validateRecord', () => {
  it('accepts a complete food and drops unknown fields', () => {
    const record = { ...food({ id: 'f1', name: 'Tortilla' }), favourite: true };
    const result = validateRecord(TABLE_SPECS.food, record);
    expect(result).toEqual({
      ok: true,
      row: {
        id: 'f1',
        updated_at: 1000,
        updated_by: 'phone',
        deleted: 0,
        name: 'Tortilla',
        brand: null,
        source: 'custom',
        source_ref: null,
        derived_from: null,
        carbs_per_100g: 48,
        fiber_per_100g: 3,
        density_g_per_ml: null,
        notes: null,
      },
    });
  });

  it('treats missing nullable fields as null', () => {
    const { brand: _b, notes: _n, ...record } = food({ id: 'f2' });
    const result = validateRecord(TABLE_SPECS.food, record);
    expect(result.ok && result.row.brand).toBeNull();
  });

  it.each([
    [{ ...food(), id: '' }, 'id must be a string of 1-64 characters'],
    [{ ...food(), updated_at: 1.5 }, 'updated_at must be a non-negative integer (ms)'],
    [{ ...food(), deleted: true }, 'deleted must be 0 or 1'],
    [{ ...food(), name: '  ' }, 'name must not be empty'],
    [{ ...food(), source: 'mystery' }, 'source must be one of usda, off, custom'],
    [{ ...food(), carbs_per_100g: -1 }, 'carbs_per_100g must be >= 0'],
    [{ ...food(), density_g_per_ml: 0 }, 'density_g_per_ml must be > 0'],
    [{ ...food(), carbs_per_100g: 'lots' }, 'carbs_per_100g must be a finite number'],
  ])('rejects invalid food %#', (record, message) => {
    expect(validateRecord(TABLE_SPECS.food, record)).toEqual({ ok: false, message });
  });

  it('requires volume portions to use a core volume unit id', () => {
    const base = { id: 'p1', food_id: 'f1', kind: 'volume', quantity: 1, grams: 229, updated_at: 1, updated_by: 'd', deleted: 0 };
    expect(validateRecord(TABLE_SPECS.portion, { ...base, label: 'cup' }).ok).toBe(true);
    expect(validateRecord(TABLE_SPECS.portion, { ...base, label: '1 cup, chopped' })).toEqual({
      ok: false,
      message: 'volume portion label must be one of ml, l, tsp, tbsp, floz, cup',
    });
    expect(validateRecord(TABLE_SPECS.portion, { ...base, kind: 'count', label: 'slice' }).ok).toBe(true);
  });

  it('requires integer meal_item positions', () => {
    expect(validateRecord(TABLE_SPECS.meal_item, { ...mealItem('m1', 'food', 'f1'), position: 0.5 })).toEqual({
      ok: false,
      message: 'position must be an integer',
    });
  });

  it('validates and serializes dose_settings JSON', () => {
    const record = doseSettings({ id: 'd1' });
    const result = validateRecord(TABLE_SPECS.dose_settings, record);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(typeof result.row.windows).toBe('string');
    expect(decodeRow(TABLE_SPECS.dose_settings, result.row)).toMatchObject({ windows: record.windows, correction: record.correction });
  });

  it.each([
    [{ windows: [] }, 'windows must be an array of 1-24 windows'],
    [{ windows: [{ name: 'Late', start: '25:00', ratio_g_per_unit: 8 }] }, 'window "Late" has invalid start "25:00"'],
    [
      {
        windows: [
          { name: 'A', start: '05:00', ratio_g_per_unit: 8 },
          { name: 'B', start: '05:00', ratio_g_per_unit: 9 },
        ],
      },
      'duplicate window start 05:00',
    ],
    [{ windows: [{ name: 'A', start: '05:00', ratio_g_per_unit: 0 }] }, 'window "A" needs ratio_g_per_unit > 0'],
    [{ correction: { threshold: 200, step: 0, units_per_step: 1, mode: 'started' } }, 'correction.step must be > 0'],
    [{ correction: { threshold: 200, step: 50, units_per_step: 1, mode: 'sometimes' } }, 'correction.mode must be started, full or proportional'],
    [{ rounding: { increment: 0, round_down_below_bg: null } }, 'rounding.increment must be > 0'],
  ])('rejects invalid dose_settings %#', (fields, message) => {
    expect(validateRecord(TABLE_SPECS.dose_settings, doseSettings(fields as never))).toEqual({ ok: false, message });
  });
});
