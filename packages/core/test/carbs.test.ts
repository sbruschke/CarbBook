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
