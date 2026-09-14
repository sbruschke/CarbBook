import { foodAmountToGrams, type FoodData, type PortionData } from '@carbbook/core';
import { describe, expect, it } from 'vitest';
import { type FdcPortionRow, normalizePortion, splitLeadingQuantity } from '../src/usda/portions';

const UNITS = new Map([
  ['1000', 'cup'],
  ['1001', 'tablespoon'],
  ['1002', 'teaspoon'],
  ['1009', 'fl oz'],
  ['1044', 'pieces'],
  ['1045', 'quart'],
  ['1060', 'wedge'],
  ['1071', 'each'],
  ['1118', 'Tablespoons'],
]);

/** Columns: id, fdc_id, amount, measure_unit_id, portion_description, modifier, gram_weight (real FDC rows). */
const row = (...c: [string, string, string, string, string, string, string]): FdcPortionRow => ({
  id: c[0],
  fdc_id: c[1],
  amount: c[2],
  measure_unit_id: c[3],
  portion_description: c[4],
  modifier: c[5],
  gram_weight: c[6],
});

describe('splitLeadingQuantity', () => {
  it.each([
    ['1 cup', 1, 'cup'],
    ['1/4 cup', 0.25, 'cup'],
    ['1 1/2 cups', 1.5, 'cups'],
    ['0.5 fl oz', 0.5, 'fl oz'],
    ['Quantity not specified', null, 'Quantity not specified'],
  ])('%s', (input, quantity, text) => {
    expect(splitLeadingQuantity(input)).toEqual({ quantity, text });
  });
});

describe('normalizePortion — Foundation (measure_unit_id set)', () => {
  it.each([
    [row('119207', '324860', '2.0', '1001', '', '', '32.0'), { label: 'tbsp', kind: 'volume', quantity: 2, grams: 32, description: 'tablespoon' }],
    [row('118952', '322892', '1.0', '1009', '', '', '30.5'), { label: 'floz', kind: 'volume', quantity: 1, grams: 30.5, description: 'fl oz' }],
    [row('118954', '322892', '1.0', '1045', '', '', '976.0'), { label: 'cup', kind: 'volume', quantity: 4, grams: 976, description: 'quart' }],
    [row('119057', '323505', '1.0', '1000', '', 'pieces of ~1"', '20.6'), { label: 'cup', kind: 'volume', quantity: 1, grams: 20.6, description: 'cup, pieces of ~1"' }],
    [row('121452', '332597', '1.0', '1071', '', 'large', '230.0'), { label: 'large', kind: 'count', quantity: 1, grams: 230, description: 'large' }],
    [row('187511', '746770', '10.0', '1044', '', 'balls', '138.0'), { label: 'pieces, balls', kind: 'count', quantity: 10, grams: 138, description: 'pieces, balls' }],
    [row('187506', '746770', '1.0', '1060', '', 'large (1/8 of large melon)', '102.0'), { label: 'wedge, large (1/8 of large melon)', kind: 'count', quantity: 1, grams: 102, description: 'wedge, large (1/8 of large melon)' }],
    [row('900001', '1', '1.0', '1118', '', '', '14.0'), { label: 'tbsp', kind: 'volume', quantity: 1, grams: 14, description: 'Tablespoons' }],
  ])('row %#', (input, expected) => {
    expect(normalizePortion(input, UNITS)).toEqual({ id: Number(input.id), fdc_id: Number(input.fdc_id), ...expected });
  });
});

describe('normalizePortion — SR Legacy (unit in modifier)', () => {
  it.each([
    [row('94062', '174273', '1', '9999', '', 'cup, stirred', '84'), { label: 'cup', kind: 'volume', quantity: 1, grams: 84, description: 'cup, stirred' }],
    [row('94063', '174273', '1', '9999', '', 'tbsp', '5.2'), { label: 'tbsp', kind: 'volume', quantity: 1, grams: 5.2, description: 'tbsp' }],
    [row('94693', '174643', '0.75', '9999', '', 'cup (1 NLEA serving)', '27'), { label: 'cup', kind: 'volume', quantity: 0.75, grams: 27, description: 'cup (1 NLEA serving)' }],
    [row('85728', '169944', '1', '9999', '', 'slice or ring (3" dia) with liquid', '49'), { label: 'slice or ring (3" dia) with liquid', kind: 'count', quantity: 1, grams: 49, description: 'slice or ring (3" dia) with liquid' }],
    [row('81549', '167512', '1', '9999', '', 'serving', '34'), { label: 'serving', kind: 'serving', quantity: 1, grams: 34, description: 'serving' }],
  ])('row %#', (input, expected) => {
    expect(normalizePortion(input, UNITS)).toEqual({ id: Number(input.id), fdc_id: Number(input.fdc_id), ...expected });
  });

  it('drops mass portions (4 oz steak) because mass units are always available', () => {
    expect(normalizePortion(row('83480', '168642', '4', '9999', '', 'oz', '113'), UNITS)).toBeNull();
  });
});

describe('normalizePortion — FNDDS (text in portion_description, modifier is a code)', () => {
  it.each([
    [row('290506', '2705383', '', '9999', '1 cup', '10205', '246.0'), { label: 'cup', kind: 'volume', quantity: 1, grams: 246, description: 'cup' }],
    [row('290508', '2705383', '', '9999', '1 fl oz', '30000', '30.8'), { label: 'floz', kind: 'volume', quantity: 1, grams: 30.8, description: 'fl oz' }],
    [row('302942', '2708432', '', '9999', '1 cup, cooked', '10043', '155.0'), { label: 'cup', kind: 'volume', quantity: 1, grams: 155, description: 'cup, cooked' }],
    [row('293579', '2706093', '', '9999', '1 nugget', '61508', '16.0'), { label: 'nugget', kind: 'count', quantity: 1, grams: 16, description: 'nugget' }],
    [row('293582', '2706093', '', '9999', 'Quantity not specified', '90000', '80.0'), { label: 'Quantity not specified', kind: 'serving', quantity: 1, grams: 80, description: 'Quantity not specified' }],
    [row('900002', '2', '', '9999', '1/4 cup', '10210', '60.0'), { label: 'cup', kind: 'volume', quantity: 0.25, grams: 60, description: 'cup' }],
  ])('row %#', (input, expected) => {
    expect(normalizePortion(input, UNITS)).toEqual({ id: Number(input.id), fdc_id: Number(input.fdc_id), ...expected });
  });

  it('keeps "cup, dry, yields" as a count portion so it does not define a bogus density', () => {
    expect(normalizePortion(row('302943', '2708432', '', '9999', '1 cup, dry, yields', '10074', '624.0'), UNITS)).toMatchObject({
      label: 'cup, dry, yields',
      kind: 'count',
    });
  });

  it('drops zero-gram and mass rows', () => {
    expect(normalizePortion(row('290507', '2705383', '', '9999', 'Quantity not specified', '90000', '0.0'), UNITS)).toBeNull();
    expect(normalizePortion(row('302944', '2708432', '', '9999', '1 oz, dry, yields', '40049', '95.0'), UNITS)).toBeNull();
  });
});

describe('normalized portions work with core unit conversion', () => {
  it('derives density from a USDA cup portion', () => {
    const milk: FoodData = { id: 'usda:322892', name: 'Milk', carbs_per_100g: 4.67 };
    const portions = [row('118951', '322892', '1.0', '1000', '', '', '229.0'), row('118953', '322892', '1.0', '1001', '', '', '15.0')]
      .map((r) => normalizePortion(r, UNITS)!)
      .map((p): PortionData => ({ id: String(p.id), food_id: milk.id, label: p.label, kind: p.kind, quantity: p.quantity, grams: p.grams }));
    expect(foodAmountToGrams(1, 'cup', milk, portions)).toBeCloseTo(229, 6);
    expect(foodAmountToGrams(2, 'tbsp', milk, portions)).toBeCloseTo(28.63, 2);
  });
});
