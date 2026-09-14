import type { DoseSettingsData } from '@carbbook/core';
import { SEED_WINDOWS } from '../src/seed';

let counter = 0;
export const uid = (prefix: string) => `${prefix}-${String(++counter).padStart(4, '0')}`;

type Meta = { updated_at?: number; updated_by?: string; deleted?: 0 | 1 };
const meta = (m: Meta) => ({ updated_at: m.updated_at ?? 1000, updated_by: m.updated_by ?? 'phone', deleted: m.deleted ?? 0 });

export const food = (fields: Partial<Record<string, unknown>> & Meta = {}) => ({
  id: uid('food'),
  name: 'Tortilla',
  brand: null,
  source: 'custom',
  source_ref: null,
  derived_from: null,
  carbs_per_100g: 48,
  fiber_per_100g: 3,
  density_g_per_ml: null,
  notes: null,
  ...fields,
  ...meta(fields),
});

export const meal = (fields: Partial<Record<string, unknown>> & Meta = {}) => ({
  id: uid('meal'),
  name: 'Tacos',
  yield_servings: 4,
  total_weight_g: null,
  notes: null,
  ...fields,
  ...meta(fields),
});

export const mealItem = (mealId: string, refType: 'food' | 'meal', refId: string, fields: Meta & { position?: number } = {}) => ({
  id: uid('item'),
  meal_id: mealId,
  ref_type: refType,
  ref_id: refId,
  amount: 1,
  unit: refType === 'meal' ? 'serving' : 'g',
  position: fields.position ?? 0,
  ...meta(fields),
});

export const doseSettings = (fields: Partial<DoseSettingsData> & Meta = {}) => ({
  id: uid('dose'),
  effective_from: Date.parse('2026-09-15T05:00:00Z'),
  windows: SEED_WINDOWS,
  correction: { threshold: 180, step: 40, units_per_step: 1, mode: 'started' },
  rounding: { increment: 0.5, round_down_below_bg: 130 },
  ...fields,
  ...meta(fields),
});
