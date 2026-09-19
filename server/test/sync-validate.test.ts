import { describe, expect, it } from 'vitest';
import { TABLE_SPECS } from '../src/sync/tables';
import { decodeRow, validateRecord } from '../src/sync/validate';
import { doseSettings, food, mealItem, planEntry, planItem } from './sync-helpers';

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
        carbs_per_100ml: null,
        fiber_per_100g: 3,
        density_g_per_ml: null,
        notes: null,
        image_id: null,
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
    [{ ...food(), carbs_per_100g: 100.1 }, 'carbs_per_100g must be <= 100'],
    [{ ...food(), fiber_per_100g: 100.1 }, 'fiber_per_100g must be <= 100'],
  ])('rejects invalid food %#', (record, message) => {
    expect(validateRecord(TABLE_SPECS.food, record)).toEqual({ ok: false, message });
  });

  it('accepts carbs_per_100g and fiber_per_100g at exactly the 100 max', () => {
    const result = validateRecord(TABLE_SPECS.food, { ...food(), carbs_per_100g: 100, fiber_per_100g: 100 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.row.carbs_per_100g).toBe(100);
    expect(result.row.fiber_per_100g).toBe(100);
  });

  it('rejects updated_at more than 24h in the future, relative to an injected clock', () => {
    const now = 1_000_000_000_000;
    const within = validateRecord(TABLE_SPECS.food, { ...food(), updated_at: now + 23 * 60 * 60 * 1000 }, now);
    expect(within.ok).toBe(true);

    const beyond = validateRecord(TABLE_SPECS.food, { ...food(), updated_at: now + 25 * 60 * 60 * 1000 }, now);
    expect(beyond).toEqual({ ok: false, message: 'updated_at is too far in the future' });
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

  describe('any-unit foods', () => {
    it('accepts a food with carbs_per_100ml set and carbs_per_100g null', () => {
      const record = { ...food({ id: 'f-ml' }), carbs_per_100g: null, carbs_per_100ml: 20.5 };
      const result = validateRecord(TABLE_SPECS.food, record);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.row.carbs_per_100ml).toBe(20.5);
    });

    it('treats a missing carbs_per_100ml as null', () => {
      const result = validateRecord(TABLE_SPECS.food, food({ id: 'f-ml2' }));
      expect(result.ok && result.row.carbs_per_100ml).toBeNull();
    });

    it.each([
      [{ carbs_per_100ml: -1 }, 'carbs_per_100ml must be >= 0'],
      [{ carbs_per_100ml: 150.1 }, 'carbs_per_100ml must be <= 150'],
      [{ carbs_per_100ml: 'lots' }, 'carbs_per_100ml must be a finite number'],
    ])('rejects invalid carbs_per_100ml %#', (fields, message) => {
      expect(validateRecord(TABLE_SPECS.food, { ...food(), ...fields })).toEqual({ ok: false, message });
    });

    it('accepts carbs_per_100ml at exactly the 150 max', () => {
      const result = validateRecord(TABLE_SPECS.food, { ...food(), carbs_per_100ml: 150 });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.row.carbs_per_100ml).toBe(150);
    });

    const volumePortion = { id: 'p1', food_id: 'f1', kind: 'volume', label: 'cup', quantity: 1, updated_at: 1, updated_by: 'd', deleted: 0 };
    const countPortion = { id: 'p2', food_id: 'f1', kind: 'count', label: 'bar', quantity: 1, updated_at: 1, updated_by: 'd', deleted: 0 };

    it('accepts a portion with grams and null carbs_g', () => {
      const result = validateRecord(TABLE_SPECS.portion, { ...countPortion, grams: 30, carbs_g: null });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.row).toMatchObject({ grams: 30, carbs_g: null });
    });

    it('accepts a count/serving portion with carbs_g and null grams', () => {
      const result = validateRecord(TABLE_SPECS.portion, { ...countPortion, grams: null, carbs_g: 22 });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.row).toMatchObject({ grams: null, carbs_g: 22 });
    });

    it('rejects a portion with neither grams nor carbs_g', () => {
      expect(validateRecord(TABLE_SPECS.portion, { ...countPortion, grams: null, carbs_g: null })).toEqual({
        ok: false,
        message: 'portion must have grams or carbs_g',
      });
    });

    it('rejects a volume portion without grams even if carbs_g is set', () => {
      expect(validateRecord(TABLE_SPECS.portion, { ...volumePortion, grams: null, carbs_g: 20 })).toEqual({
        ok: false,
        message: 'volume portions require grams',
      });
    });

    it.each([
      [{ carbs_g: -1 }, 'carbs_g must be >= 0'],
      [{ carbs_g: 500.1 }, 'carbs_g must be <= 500'],
      [{ carbs_g: 'lots' }, 'carbs_g must be a finite number'],
      [{ grams: 0 }, 'grams must be > 0'],
      [{ grams: -5 }, 'grams must be > 0'],
    ])('rejects invalid portion field %#', (fields, message) => {
      expect(validateRecord(TABLE_SPECS.portion, { ...countPortion, grams: 30, carbs_g: null, ...fields })).toEqual({
        ok: false,
        message,
      });
    });

    it('rejects carbs_g on a volume portion', () => {
      expect(validateRecord(TABLE_SPECS.portion, { ...volumePortion, grams: 158, carbs_g: 48 })).toEqual({
        ok: false,
        message: 'volume portions cannot have carbs_g',
      });
      expect(validateRecord(TABLE_SPECS.portion, { ...volumePortion, grams: 158, carbs_g: null }).ok).toBe(true);
    });

    it('accepts carbs_g at exactly the 500 max', () => {
      const result = validateRecord(TABLE_SPECS.portion, { ...countPortion, grams: null, carbs_g: 500 });
      expect(result.ok).toBe(true);
    });
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

describe('dose_settings carb_goal', () => {
  const withGoal = (carb_goal: unknown) =>
    doseSettings({
      windows: [{ name: 'Breakfast', start: '05:00', ratio_g_per_unit: 8, carb_goal }] as never,
    });

  it('accepts a window with a valid carb_goal and round-trips it', () => {
    const result = validateRecord(TABLE_SPECS.dose_settings, withGoal({ min: 30, max: 50 }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(decodeRow(TABLE_SPECS.dose_settings, result.row)).toMatchObject({
      windows: [{ name: 'Breakfast', start: '05:00', ratio_g_per_unit: 8, carb_goal: { min: 30, max: 50 } }],
    });
  });

  it('accepts a window with carb_goal null or absent', () => {
    expect(validateRecord(TABLE_SPECS.dose_settings, withGoal(null)).ok).toBe(true);
    expect(validateRecord(TABLE_SPECS.dose_settings, doseSettings()).ok).toBe(true);
  });

  it.each([
    [{ min: 80, max: 50 }],
    [{ min: -1, max: 50 }],
    [{ min: 0, max: 2001 }],
    [{ min: 30 }],
    ['30-50'],
  ])('rejects carb_goal %j', (goal) => {
    expect(validateRecord(TABLE_SPECS.dose_settings, withGoal(goal))).toEqual({
      ok: false,
      message: 'window "Breakfast" has an invalid carb_goal (need 0 <= min <= max <= 2000)',
    });
  });

  it('serializes carb_goal in a fixed key order so an identical republish is byte-identical', () => {
    const a = validateRecord(TABLE_SPECS.dose_settings, withGoal({ min: 30, max: 50 }));
    const b = validateRecord(TABLE_SPECS.dose_settings, withGoal({ max: 50, min: 30 }));
    expect(a.ok && b.ok && a.row.windows).toBe(b.ok ? b.row.windows : undefined);
  });
});

describe('plan_entry validation', () => {
  it('accepts a complete plan entry', () => {
    const result = validateRecord(TABLE_SPECS.plan_entry, planEntry({ id: 'p1', note: 'leftovers' }));
    expect(result).toEqual({
      ok: true,
      row: {
        id: 'p1',
        updated_at: 1000,
        updated_by: 'phone',
        deleted: 0,
        date: '2026-09-17',
        window_name: 'Lunch',
        status: 'planned',
        note: 'leftovers',
        log_entry_id: null,
      },
    });
  });

  it.each([
    [{ date: '17-09-2026' }, 'date must be a real calendar date in YYYY-MM-DD form'],
    [{ date: '2026-02-30' }, 'date must be a real calendar date in YYYY-MM-DD form'],
    [{ date: '2026-13-01' }, 'date must be a real calendar date in YYYY-MM-DD form'],
    [{ date: '' }, 'date must not be empty'],
    [{ window_name: '' }, 'window_name must not be empty'],
    [{ window_name: '   ' }, 'window_name must not be empty'],
    [{ window_name: 'x'.repeat(65) }, 'window_name is longer than 64 characters'],
    [{ status: 'eaten' }, 'status must be one of planned, logged, skipped'],
    [{ log_entry_id: 'x'.repeat(65) }, 'log_entry_id is longer than 64 characters'],
  ])('rejects plan_entry %j', (fields, message) => {
    expect(validateRecord(TABLE_SPECS.plan_entry, planEntry(fields))).toEqual({ ok: false, message });
  });

  it('accepts a leap day', () => {
    expect(validateRecord(TABLE_SPECS.plan_entry, planEntry({ date: '2028-02-29' })).ok).toBe(true);
  });

  it('trims window_name whitespace but keeps the original casing', () => {
    const result = validateRecord(TABLE_SPECS.plan_entry, planEntry({ window_name: '  Lunch  ' }));
    expect(result.ok && result.row.window_name).toBe('Lunch');
  });

  it('measures the 64-char max against the trimmed length', () => {
    const result = validateRecord(TABLE_SPECS.plan_entry, planEntry({ window_name: `  ${'x'.repeat(64)}  ` }));
    expect(result.ok).toBe(true);
  });
});

describe('plan_item validation', () => {
  it('accepts a complete plan item', () => {
    const result = validateRecord(TABLE_SPECS.plan_item, planItem('p1', { id: 'i1' }));
    expect(result).toEqual({
      ok: true,
      row: {
        id: 'i1',
        updated_at: 1000,
        updated_by: 'phone',
        deleted: 0,
        plan_entry_id: 'p1',
        ref_type: 'food',
        ref_id: 'f1',
        amount: 1,
        unit: 'g',
        position: 0,
        label: null,
      },
    });
  });

  it.each([
    [{ ref_type: 'snack' }, 'ref_type must be one of food, meal, quick'],
    [{ amount: -1 }, 'amount must be >= 0'],
    [{ amount: 'lots' }, 'amount must be a finite number'],
    [{ unit: '' }, 'unit must not be empty'],
    [{ position: 1.5 }, 'position must be an integer'],
    [{ position: -1 }, 'position must be >= 0'],
  ])('rejects plan_item %j', (fields, message) => {
    expect(validateRecord(TABLE_SPECS.plan_item, planItem('p1', fields))).toEqual({ ok: false, message });
  });
});

describe('quick carbs rows (quick-carbs spec §2)', () => {
  const meta = { updated_at: 1000, updated_by: 'phone', deleted: 0 };
  const quickMeal = (fields: Record<string, unknown> = {}) => ({
    id: 'q1', meal_id: 'm1', ref_type: 'quick', ref_id: 'q1', amount: 7, unit: 'carbs', position: 1, label: 'Ranch & salad', ...meta, ...fields,
  });
  const quickLog = (fields: Record<string, unknown> = {}) => ({
    id: 'l1', log_entry_id: 'e1', ref_type: 'quick', ref_id: 'l1', display_name: 'Ranch & salad', amount: 7, unit: 'carbs', carbs_g: 7, ...meta, ...fields,
  });
  const quickPlan = (fields: Record<string, unknown> = {}) => planItem('p1', { id: 'qp', ref_type: 'quick', ref_id: 'qp', amount: 7, unit: 'carbs', label: null, ...fields });

  it('accepts quick rows in all three tables, trimming the label', () => {
    const meal = validateRecord(TABLE_SPECS.meal_item, quickMeal({ label: '  Ranch & salad  ' }));
    expect(meal).toEqual({ ok: true, row: expect.objectContaining({ ref_type: 'quick', unit: 'carbs', amount: 7, label: 'Ranch & salad' }) });
    expect(validateRecord(TABLE_SPECS.log_item, quickLog()).ok).toBe(true);
    expect(validateRecord(TABLE_SPECS.plan_item, quickPlan()).ok).toBe(true);
    expect(validateRecord(TABLE_SPECS.plan_item, quickPlan({ amount: 0 })).ok).toBe(true);
    expect(validateRecord(TABLE_SPECS.plan_item, quickPlan({ amount: 2000 })).ok).toBe(true);
  });

  it('never resolves ref_id for a quick row', () => {
    expect(validateRecord(TABLE_SPECS.meal_item, quickMeal({ ref_id: 'anything-at-all' })).ok).toBe(true);
  });

  it('treats a missing label as null', () => {
    const { label: _label, ...noLabel } = quickMeal();
    const result = validateRecord(TABLE_SPECS.meal_item, noLabel);
    expect(result.ok && result.row.label).toBeNull();
  });

  it.each([
    [quickMeal({ unit: 'g' }), 'quick carbs rows need unit "carbs"'],
    [quickMeal({ amount: 2001 }), 'quick carbs amount must be 0-2000 g'],
    [quickMeal({ amount: -1 }), 'amount must be >= 0'],
    [quickMeal({ amount: 'lots' }), 'amount must be a finite number'],
    [quickMeal({ label: 'x'.repeat(81) }), 'label is longer than 80 characters'],
    [quickMeal({ ref_type: 'food', unit: 'g' }), 'label is only allowed on quick carbs rows'],
    [quickMeal({ ref_type: 'snack' }), 'ref_type must be one of food, meal, quick'],
  ])('rejects meal_item %#', (record, message) => {
    expect(validateRecord(TABLE_SPECS.meal_item, record)).toEqual({ ok: false, message });
  });

  it.each([
    [quickLog({ carbs_g: 8 }), 'quick carbs rows need carbs_g equal to amount'],
    [quickLog({ unit: 'serving' }), 'quick carbs rows need unit "carbs"'],
    [quickLog({ amount: 2001, carbs_g: 2001 }), 'quick carbs amount must be 0-2000 g'],
  ])('rejects log_item %#', (record, message) => {
    expect(validateRecord(TABLE_SPECS.log_item, record)).toEqual({ ok: false, message });
  });

  it.each([
    [quickPlan({ unit: 'g' }), 'quick carbs rows need unit "carbs"'],
    [quickPlan({ amount: 2001 }), 'quick carbs amount must be 0-2000 g'],
    [planItem('p1', { label: 'Salsa' }), 'label is only allowed on quick carbs rows'],
  ])('rejects plan_item %#', (record, message) => {
    expect(validateRecord(TABLE_SPECS.plan_item, record)).toEqual({ ok: false, message });
  });

  it('still accepts food and meal rows with no label', () => {
    expect(validateRecord(TABLE_SPECS.meal_item, mealItem('m1', 'food', 'f1')).ok).toBe(true);
    expect(validateRecord(TABLE_SPECS.plan_item, planItem('p1', { label: null })).ok).toBe(true);
  });

  it('stores a whitespace-only label as null, not empty', () => {
    const result = validateRecord(TABLE_SPECS.meal_item, quickMeal({ label: '   ' }));
    expect(result).toEqual({ ok: true, row: expect.objectContaining({ label: null }) });
  });
});
