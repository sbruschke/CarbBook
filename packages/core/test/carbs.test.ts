import { describe, expect, it } from 'vitest';
import { createCatalog, itemCarbs, sumCarbs, wouldCreateCycle } from '../src/carbs';

const catalog = createCatalog({
  foods: [
    { id: 'rice', name: 'Rice', carbs_per_100g: 28.2 },
    { id: 'corn', name: 'Cream corn', carbs_per_100g: 18.13 },
    { id: 'bread', name: 'Bread', carbs_per_100g: 49 },
    { id: 'mystery', name: 'Mystery', carbs_per_100g: null },
  ],
  portions: [
    { id: 'rice-cup', food_id: 'rice', label: 'cup', kind: 'volume', quantity: 1, grams: 158 },
    { id: 'corn-cup', food_id: 'corn', label: 'cup', kind: 'volume', quantity: 1, grams: 256 },
    { id: 'bread-slice', food_id: 'bread', label: 'slice', kind: 'count', quantity: 1, grams: 25 },
  ],
  meals: [
    { id: 'rice-corn', name: 'Rice and corn', yield_servings: 2, total_weight_g: 414 },
    { id: 'plate', name: 'Plate', yield_servings: 1, total_weight_g: null },
    { id: 'bad', name: 'Bad', yield_servings: 1 },
  ],
  meal_items: [
    { id: 'i2', meal_id: 'rice-corn', ref_type: 'food', ref_id: 'corn', amount: 1, unit: 'cup', position: 1 },
    { id: 'i1', meal_id: 'rice-corn', ref_type: 'food', ref_id: 'rice', amount: 1, unit: 'cup', position: 0 },
    { id: 'i3', meal_id: 'plate', ref_type: 'meal', ref_id: 'rice-corn', amount: 1.5, unit: 'serving', position: 0 },
    { id: 'i4', meal_id: 'plate', ref_type: 'food', ref_id: 'bread', amount: 1, unit: 'p:bread-slice', position: 1 },
    { id: 'i5', meal_id: 'bad', ref_type: 'food', ref_id: 'rice', amount: 100, unit: 'g', position: 0 },
    { id: 'i6', meal_id: 'bad', ref_type: 'food', ref_id: 'mystery', amount: 50, unit: 'g', position: 1 },
  ],
});

describe('itemCarbs', () => {
  it('computes food carbs', () => {
    const r = itemCarbs(catalog, 'food', 'rice', 1, 'cup');
    expect(r.complete).toBe(true);
    expect(r.carbs_g).toBeCloseTo(44.556, 6);
  });
  it('flags foods with no carb data or unusable units', () => {
    expect(itemCarbs(catalog, 'food', 'mystery', 50, 'g')).toEqual({ carbs_g: 0, complete: false });
    expect(itemCarbs(catalog, 'food', 'bread', 1, 'cup')).toEqual({ carbs_g: 0, complete: false });
    expect(itemCarbs(catalog, 'food', 'nope', 1, 'g')).toEqual({ carbs_g: 0, complete: false });
  });
  it('computes meal servings and grams', () => {
    expect(itemCarbs(catalog, 'meal', 'rice-corn', 1, 'serving').carbs_g).toBeCloseTo(45.4844, 6);
    expect(itemCarbs(catalog, 'meal', 'rice-corn', 100, 'g').carbs_g).toBeCloseTo(21.97314, 5);
  });
  it('resolves nested meals', () => {
    const r = itemCarbs(catalog, 'meal', 'plate', 1, 'serving');
    expect(r.complete).toBe(true);
    expect(r.carbs_g).toBeCloseTo(80.4766, 6);
  });
  it('rejects grams for a meal without total weight', () => {
    expect(itemCarbs(catalog, 'meal', 'plate', 1, 'g')).toEqual({ carbs_g: 0, complete: false });
  });
  it('keeps the partial total but marks meals with an incomplete item', () => {
    const r = itemCarbs(catalog, 'meal', 'bad', 1, 'serving');
    expect(r.complete).toBe(false);
    expect(r.carbs_g).toBeCloseTo(28.2, 6);
  });
});

describe('invalid stored values', () => {
  it('rejects carbs_per_100g that is non-finite or out of the 0-100 range', () => {
    const invalid = createCatalog({
      foods: [
        { id: 'neg', name: 'Neg', carbs_per_100g: -1 },
        { id: 'huge', name: 'Huge', carbs_per_100g: 101 },
        { id: 'inf', name: 'Inf', carbs_per_100g: Number.POSITIVE_INFINITY },
        { id: 'nan', name: 'NaN', carbs_per_100g: Number.NaN },
        { id: 'edge0', name: 'Edge0', carbs_per_100g: 0 },
        { id: 'edge100', name: 'Edge100', carbs_per_100g: 100 },
      ],
    });
    expect(itemCarbs(invalid, 'food', 'neg', 50, 'g').complete).toBe(false);
    expect(itemCarbs(invalid, 'food', 'huge', 50, 'g').complete).toBe(false);
    expect(itemCarbs(invalid, 'food', 'inf', 50, 'g').complete).toBe(false);
    expect(itemCarbs(invalid, 'food', 'nan', 50, 'g').complete).toBe(false);
    expect(itemCarbs(invalid, 'food', 'edge0', 50, 'g')).toEqual({ carbs_g: 0, complete: true });
    expect(itemCarbs(invalid, 'food', 'edge100', 50, 'g')).toEqual({ carbs_g: 50, complete: true });
  });

  it('marks an empty meal incomplete', () => {
    const empty = createCatalog({ meals: [{ id: 'empty', name: 'Empty', yield_servings: 1 }] });
    expect(itemCarbs(empty, 'meal', 'empty', 1, 'serving')).toEqual({ carbs_g: 0, complete: false });
  });

  it('marks a meal with non-finite yield_servings or total_weight_g incomplete', () => {
    const badMeal = createCatalog({
      foods: [{ id: 'rice', name: 'Rice', carbs_per_100g: 28.2 }],
      meals: [
        { id: 'inf-yield', name: 'InfYield', yield_servings: Number.POSITIVE_INFINITY },
        { id: 'inf-weight', name: 'InfWeight', yield_servings: 1, total_weight_g: Number.POSITIVE_INFINITY },
      ],
      meal_items: [
        { id: 'i1', meal_id: 'inf-yield', ref_type: 'food', ref_id: 'rice', amount: 100, unit: 'g', position: 0 },
        { id: 'i2', meal_id: 'inf-weight', ref_type: 'food', ref_id: 'rice', amount: 100, unit: 'g', position: 0 },
      ],
    });
    expect(itemCarbs(badMeal, 'meal', 'inf-yield', 1, 'serving').complete).toBe(false);
    expect(itemCarbs(badMeal, 'meal', 'inf-weight', 100, 'g').complete).toBe(false);
  });
});

describe('any-unit foods: carbs', () => {
  const c = createCatalog({
    foods: [
      { id: 'vol-fallback', name: 'Per-100 ml invalid, per-100 g + density', carbs_per_100g: 50, carbs_per_100ml: 151, density_g_per_ml: 2 },
      { id: 'ml-edges', name: 'Edges', carbs_per_100g: null, carbs_per_100ml: 150 },
      { id: 'ml-nan', name: 'NaN', carbs_per_100g: null, carbs_per_100ml: Number.NaN, density_g_per_ml: 1 },
      { id: 'ml-neg', name: 'Neg', carbs_per_100g: null, carbs_per_100ml: -1 },
      { id: 'portion-fallback', name: 'Portion carbs invalid, grams valid', carbs_per_100g: 40 },
      { id: 'portion-none', name: 'Portion carbs, no basis', carbs_per_100g: null },
    ],
    portions: [
      { id: 'big', food_id: 'portion-fallback', label: 'big', kind: 'count', quantity: 2, grams: 50, carbs_g: 501 },
      { id: 'zero-q', food_id: 'portion-none', label: 'zq', kind: 'count', quantity: 0, grams: null, carbs_g: 10 },
      { id: 'serv', food_id: 'portion-none', label: 'serving', kind: 'serving', quantity: 2, grams: null, carbs_g: 500 },
      { id: 'grams-only', food_id: 'portion-none', label: 'g', kind: 'count', quantity: 1, grams: 30, carbs_g: null },
    ],
  });
  it('falls back to per-100 g + density for volume when per-100 ml is invalid', () => {
    const r = itemCarbs(c, 'food', 'vol-fallback', 10, 'ml');
    expect(r.complete).toBe(true);
    expect(r.carbs_g).toBeCloseTo(10, 9);
  });
  it('validates per-100 ml range and finiteness', () => {
    expect(itemCarbs(c, 'food', 'ml-edges', 100, 'ml')).toEqual({ carbs_g: 150, complete: true });
    expect(itemCarbs(c, 'food', 'ml-nan', 100, 'ml').complete).toBe(false);
    expect(itemCarbs(c, 'food', 'ml-nan', 100, 'g').complete).toBe(false);
    expect(itemCarbs(c, 'food', 'ml-neg', 100, 'ml').complete).toBe(false);
  });
  it('uses portion grams when portion carbs are out of range', () => {
    const r = itemCarbs(c, 'food', 'portion-fallback', 1, 'p:big');
    expect(r.complete).toBe(true);
    expect(r.carbs_g).toBeCloseTo(10, 9);
  });
  it('requires a valid quantity for portion carbs and scales by quantity', () => {
    expect(itemCarbs(c, 'food', 'portion-none', 1, 'p:zero-q')).toEqual({ carbs_g: 0, complete: false });
    expect(itemCarbs(c, 'food', 'portion-none', 1, 'p:serv')).toEqual({ carbs_g: 250, complete: true });
    expect(itemCarbs(c, 'food', 'portion-none', 1, 'p:grams-only')).toEqual({ carbs_g: 0, complete: false });
    expect(itemCarbs(c, 'food', 'portion-none', -1, 'p:serv').complete).toBe(false);
    expect(itemCarbs(c, 'food', 'portion-none', Number.NaN, 'p:serv').complete).toBe(false);
  });
});

describe('soft-deleted rows', () => {
  it('excludes deleted foods, portions, meals and meal_items from the catalog', () => {
    const catalogWithDeletes = createCatalog({
      foods: [
        { id: 'rice', name: 'Rice', carbs_per_100g: 28.2 },
        { id: 'ghost-food', name: 'Ghost', carbs_per_100g: 10, deleted: 1 },
      ],
      portions: [
        { id: 'rice-cup', food_id: 'rice', label: 'cup', kind: 'volume', quantity: 1, grams: 158 },
        { id: 'ghost-portion', food_id: 'rice', label: 'tbsp', kind: 'volume', quantity: 1, grams: 10, deleted: 1 },
      ],
      meals: [
        { id: 'plate', name: 'Plate', yield_servings: 1 },
        { id: 'ghost-meal', name: 'Ghost meal', yield_servings: 1, deleted: 1 },
      ],
      meal_items: [
        { id: 'i1', meal_id: 'plate', ref_type: 'food', ref_id: 'rice', amount: 100, unit: 'g', position: 0 },
        { id: 'ghost-item', meal_id: 'plate', ref_type: 'food', ref_id: 'rice', amount: 999, unit: 'g', position: 1, deleted: 1 },
      ],
    });
    expect(catalogWithDeletes.food('ghost-food')).toBeUndefined();
    expect(catalogWithDeletes.meal('ghost-meal')).toBeUndefined();
    expect(catalogWithDeletes.portions('rice').map((p) => p.id)).toEqual(['rice-cup']);
    expect(catalogWithDeletes.mealItems('plate').map((i) => i.id)).toEqual(['i1']);
    expect(itemCarbs(catalogWithDeletes, 'meal', 'plate', 1, 'serving')).toEqual({ carbs_g: 28.2, complete: true });
  });
});

describe('cycles', () => {
  it('detects direct and transitive cycles', () => {
    expect(wouldCreateCycle(catalog, 'plate', 'plate')).toBe(true);
    expect(wouldCreateCycle(catalog, 'rice-corn', 'plate')).toBe(true);
    expect(wouldCreateCycle(catalog, 'plate', 'bad')).toBe(false);
  });
  it('does not loop forever on corrupt cyclic data', () => {
    const cyclic = createCatalog({
      meals: [
        { id: 'a', name: 'A', yield_servings: 1 },
        { id: 'b', name: 'B', yield_servings: 1 },
      ],
      meal_items: [
        { id: 'x', meal_id: 'a', ref_type: 'meal', ref_id: 'b', amount: 1, unit: 'serving', position: 0 },
        { id: 'y', meal_id: 'b', ref_type: 'meal', ref_id: 'a', amount: 1, unit: 'serving', position: 0 },
      ],
    });
    expect(itemCarbs(cyclic, 'meal', 'a', 1, 'serving').complete).toBe(false);
  });
});

describe('sumCarbs', () => {
  it('adds carbs and ANDs completeness', () => {
    expect(sumCarbs([{ carbs_g: 10, complete: true }, { carbs_g: 5, complete: false }])).toEqual({ carbs_g: 15, complete: false });
    expect(sumCarbs([])).toEqual({ carbs_g: 0, complete: true });
  });
});
