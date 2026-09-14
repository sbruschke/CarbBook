import { describe, expect, it } from 'vitest';
import type { FoodData, MealData, PortionData } from '../src/types';
import { MAX_CARBS_PER_100ML, MAX_PORTION_CARBS_G, densityOf, foodAmountToGrams, foodUnits, mealUnits } from '../src/units';

const rice: FoodData = { id: 'rice', name: 'Rice', carbs_per_100g: 28.2 };
const riceCup: PortionData = { id: 'rice-cup', food_id: 'rice', label: 'cup', kind: 'volume', quantity: 1, grams: 158 };
const bread: FoodData = { id: 'bread', name: 'Bread', carbs_per_100g: 49 };
const slice: PortionData = { id: 'bread-slice', food_id: 'bread', label: 'slice', kind: 'count', quantity: 1, grams: 25 };
const milk: FoodData = { id: 'milk', name: 'Milk', carbs_per_100g: 4.8, density_g_per_ml: 1.03 };

describe('densityOf', () => {
  it('prefers the explicit density', () => {
    expect(densityOf(milk, [])).toBe(1.03);
  });
  it('derives density from a volume portion', () => {
    expect(densityOf(rice, [riceCup])).toBeCloseTo(158 / 236.5882365, 9);
  });
  it('is null with no volume information', () => {
    expect(densityOf(bread, [slice])).toBeNull();
  });
  it('falls through to portion-derived density when explicit density is non-finite', () => {
    const infMilk: FoodData = { ...milk, density_g_per_ml: Number.POSITIVE_INFINITY };
    expect(densityOf(infMilk, [riceCup])).toBeCloseTo(158 / 236.5882365, 9);
  });
  it('picks the volume portion with the lexicographically smallest id when several match', () => {
    const cupB: PortionData = { id: 'b-cup', food_id: 'rice', label: 'cup', kind: 'volume', quantity: 1, grams: 300 };
    const cupA: PortionData = { id: 'a-cup', food_id: 'rice', label: 'cup', kind: 'volume', quantity: 1, grams: 200 };
    expect(densityOf(rice, [cupB, cupA])).toBeCloseTo(200 / 236.5882365, 9);
  });
  it('skips volume portions with invalid quantity or grams', () => {
    const bad: PortionData = { id: 'a-cup', food_id: 'rice', label: 'cup', kind: 'volume', quantity: 0, grams: 200 };
    expect(densityOf(rice, [bad, riceCup])).toBeCloseTo(158 / 236.5882365, 9);
  });
});

describe('foodAmountToGrams', () => {
  it('converts mass units', () => {
    expect(foodAmountToGrams(4, 'oz', rice, [])).toBeCloseTo(113.398093, 5);
    expect(foodAmountToGrams(1, 'kg', rice, [])).toBe(1000);
  });
  it('converts volume via density', () => {
    expect(foodAmountToGrams(2, 'tbsp', rice, [riceCup])).toBeCloseTo(19.75, 6);
  });
  it('converts count portions', () => {
    expect(foodAmountToGrams(2, 'p:bread-slice', bread, [slice])).toBe(50);
  });
  it('returns null for volume without density, unknown units and bad amounts', () => {
    expect(foodAmountToGrams(1, 'cup', bread, [slice])).toBeNull();
    expect(foodAmountToGrams(1, 'handful', rice, [])).toBeNull();
    expect(foodAmountToGrams(1, 'p:missing', bread, [slice])).toBeNull();
    expect(foodAmountToGrams(-1, 'g', rice, [])).toBeNull();
    expect(foodAmountToGrams(Number.NaN, 'g', rice, [])).toBeNull();
  });
  it('rejects portions with non-finite or non-positive grams or quantity', () => {
    const zeroGrams: PortionData = { ...slice, grams: 0 };
    const negQuantity: PortionData = { ...slice, quantity: -1 };
    const infGrams: PortionData = { ...slice, grams: Number.POSITIVE_INFINITY };
    const nanQuantity: PortionData = { ...slice, quantity: Number.NaN };
    expect(foodAmountToGrams(2, 'p:bread-slice', bread, [zeroGrams])).toBeNull();
    expect(foodAmountToGrams(2, 'p:bread-slice', bread, [negQuantity])).toBeNull();
    expect(foodAmountToGrams(2, 'p:bread-slice', bread, [infGrams])).toBeNull();
    expect(foodAmountToGrams(2, 'p:bread-slice', bread, [nanQuantity])).toBeNull();
  });
});

describe('any-unit foods: units', () => {
  it('exports shared validation limits', () => {
    expect(MAX_CARBS_PER_100ML).toBe(150);
    expect(MAX_PORTION_CARBS_G).toBe(500);
  });
  it('densityOf ignores volume portions with unknown grams', () => {
    const noGrams: PortionData = { id: 'a-cup', food_id: 'rice', label: 'cup', kind: 'volume', quantity: 1, grams: null };
    expect(densityOf(bread, [noGrams])).toBeNull();
    expect(densityOf(rice, [noGrams, riceCup])).toBeCloseTo(158 / 236.5882365, 9);
  });
  it('foodAmountToGrams is null for portions with unknown grams', () => {
    const bar: PortionData = { id: 'bar', food_id: 'bread', label: 'bar', kind: 'count', quantity: 1, grams: null, carbs_g: 22 };
    expect(foodAmountToGrams(1, 'p:bar', bread, [bar])).toBeNull();
  });
  it('lists volume units for a valid per-100 ml basis without density', () => {
    const food: FoodData = { id: 'x', name: 'X', carbs_per_100g: null, carbs_per_100ml: 20 };
    expect(foodUnits(food, [])).toEqual(['ml', 'l', 'tsp', 'tbsp', 'floz', 'cup']);
  });
  it('omits portions with neither valid grams nor valid carbs', () => {
    const bad: PortionData = { id: 'bad', food_id: 'bread', label: 'x', kind: 'count', quantity: 1, grams: null, carbs_g: Number.NaN };
    expect(foodUnits(bread, [slice, bad])).toEqual(['g', 'kg', 'oz', 'lb', 'p:bread-slice']);
  });
  it('lists mass units when per-100 g is invalid but per-100 ml and density give a mass path', () => {
    const food: FoodData = { id: 'x', name: 'X', carbs_per_100g: 101, carbs_per_100ml: 50, density_g_per_ml: 1 };
    expect(foodUnits(food, [])).toEqual(['g', 'kg', 'oz', 'lb', 'ml', 'l', 'tsp', 'tbsp', 'floz', 'cup']);
  });
});

describe('unit lists', () => {
  it('lists mass + volume when density is known', () => {
    expect(foodUnits(rice, [riceCup])).toEqual(['g', 'kg', 'oz', 'lb', 'ml', 'l', 'tsp', 'tbsp', 'floz', 'cup']);
  });
  it('lists mass + count portions otherwise', () => {
    expect(foodUnits(bread, [slice])).toEqual(['g', 'kg', 'oz', 'lb', 'p:bread-slice']);
  });
  it('lists serving, plus mass when a meal has a total weight', () => {
    const withWeight: MealData = { id: 'm', name: 'M', yield_servings: 2, total_weight_g: 414 };
    const noWeight: MealData = { id: 'n', name: 'N', yield_servings: 1, total_weight_g: null };
    expect(mealUnits(withWeight)).toEqual(['serving', 'g', 'kg', 'oz', 'lb']);
    expect(mealUnits(noWeight)).toEqual(['serving']);
  });
});
