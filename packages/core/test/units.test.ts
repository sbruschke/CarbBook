import { describe, expect, it } from 'vitest';
import type { FoodData, MealData, PortionData } from '../src/types';
import { densityOf, foodAmountToGrams, foodUnits, mealUnits } from '../src/units';

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
