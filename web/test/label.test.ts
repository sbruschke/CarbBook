import { describe, expect, it } from 'vitest';
import { foodBasisSummary, labelBasisFromEntry } from '../src/foods/label';
import { foodData, portionData } from './helpers';

describe('labelBasisFromEntry', () => {
  it('maps a gram label to carbs_per_100g (existing behavior)', () => {
    const r = labelBasisFromEntry({ unit: 'g', amount: 40, carbs: 20, weight: null, label: '' });
    expect(r).toEqual({ carbs_per_100g: 50, carbs_per_100ml: null, portion: null });
  });

  it('Calrose rice: 1 cup = 48 g carbs -> carbs_per_100ml', () => {
    const r = labelBasisFromEntry({ unit: 'cup', amount: 1, carbs: 48, weight: null, label: '' });
    expect('error' in r).toBe(false);
    if ('error' in r) throw r;
    expect(r.carbs_per_100ml).toBeCloseTo(20.2884136211058, 9);
    expect(r.carbs_per_100g).toBeNull();
    expect(r.portion).toBeNull();
  });

  it('2 tbsp = 7 g carbs -> carbs_per_100ml', () => {
    const r = labelBasisFromEntry({ unit: 'tbsp', amount: 2, carbs: 7, weight: null, label: '' });
    if ('error' in r) throw r;
    expect(r.carbs_per_100ml).toBeCloseTo(23.6698158912901, 9);
  });

  it('a volume label with a weight also adds a volume portion (enables grams via density)', () => {
    const r = labelBasisFromEntry({ unit: 'cup', amount: 1, carbs: 48, weight: 158, label: '' });
    if ('error' in r) throw r;
    expect(r.portion).toEqual({ label: 'cup', kind: 'volume', quantity: 1, grams: 158, carbs_g: null });
  });

  it('1 bar = 22 g carbs -> a named count portion with no grams', () => {
    const r = labelBasisFromEntry({ unit: 'other', amount: 1, carbs: 22, weight: null, label: 'bar' });
    if ('error' in r) throw r;
    expect(r.portion).toEqual({ label: 'bar', kind: 'count', quantity: 1, grams: null, carbs_g: 22 });
    expect(r.carbs_per_100g).toBeNull();
    expect(r.carbs_per_100ml).toBeNull();
  });

  it('a piece label with a weight also sets carbs_per_100g (enables grams)', () => {
    const r = labelBasisFromEntry({ unit: 'other', amount: 1, carbs: 20, weight: 30, label: 'cookie' });
    if ('error' in r) throw r;
    expect(r.carbs_per_100g).toBeCloseTo(66.67, 2);
    expect(r.portion).toEqual({ label: 'cookie', kind: 'count', quantity: 1, grams: 30, carbs_g: 20 });
  });

  it('a "serving" label gets kind serving', () => {
    const r = labelBasisFromEntry({ unit: 'other', amount: 1, carbs: 20, weight: null, label: 'Serving' });
    if ('error' in r) throw r;
    expect(r.portion?.kind).toBe('serving');
  });

  it('rejects a zero or negative amount', () => {
    expect(labelBasisFromEntry({ unit: 'g', amount: 0, carbs: 20, weight: null, label: '' })).toEqual({ error: expect.any(String) });
    expect(labelBasisFromEntry({ unit: 'cup', amount: -1, carbs: 20, weight: null, label: '' })).toEqual({ error: expect.any(String) });
    expect(labelBasisFromEntry({ unit: 'g', amount: null, carbs: 20, weight: null, label: '' })).toEqual({ error: expect.any(String) });
  });

  it('rejects missing carbs', () => {
    expect(labelBasisFromEntry({ unit: 'g', amount: 40, carbs: null, weight: null, label: '' })).toEqual({ error: expect.any(String) });
  });

  it('rejects a piece unit with no label', () => {
    expect(labelBasisFromEntry({ unit: 'other', amount: 1, carbs: 22, weight: null, label: '  ' })).toEqual({ error: expect.any(String) });
  });

  it('rejects out-of-range carbs per 100 ml and per portion', () => {
    // 1 ml of something with 2 g carbs -> 200 g / 100 ml, over the 150 max
    expect(labelBasisFromEntry({ unit: 'ml', amount: 1, carbs: 2, weight: null, label: '' })).toEqual({ error: expect.any(String) });
    expect(labelBasisFromEntry({ unit: 'other', amount: 1, carbs: 501, weight: null, label: 'cake' })).toEqual({ error: expect.any(String) });
  });
});

describe('foodBasisSummary', () => {
  it('shows the per 100 g basis', () => {
    expect(foodBasisSummary(foodData({ carbs_per_100g: 48 }), [])).toBe('48 g carbs per 100 g');
  });

  it('shows the volume basis reconstructed for the weighed portion (Calrose: 1 cup = 48 g carbs)', () => {
    const food = foodData({ carbs_per_100g: null, carbs_per_100ml: 20.2884136211058 });
    const cup = portionData({ label: 'cup', kind: 'volume', quantity: 1, grams: 158 });
    expect(foodBasisSummary(food, [cup])).toBe('48 g carbs per cup');
  });

  it('falls back to per cup when no portion was weighed', () => {
    const food = foodData({ carbs_per_100g: null, carbs_per_100ml: 20.2884136211058 });
    expect(foodBasisSummary(food, [])).toBe('48 g carbs per cup');
  });

  it('shows the piece basis', () => {
    const food = foodData({ carbs_per_100g: null });
    const bar = portionData({ label: 'bar', kind: 'count', quantity: 1, grams: null, carbs_g: 22 });
    expect(foodBasisSummary(food, [bar])).toBe('22 g carbs per bar');
  });

  it('shows a per 100 g food per serving when it has a weighed serving (Nature Valley bar: 68.57 g/100 g, 35 g serving)', () => {
    const food = foodData({ carbs_per_100g: 68.57 });
    const serving = portionData({ label: 'label serving', kind: 'serving', quantity: 1, grams: 35 });
    expect(foodBasisSummary(food, [serving])).toBe('24 g carbs per label serving (35 g)');
  });

  it('prefers a piece with its own carbs over a derived serving', () => {
    const food = foodData({ carbs_per_100g: 68.57 });
    const serving = portionData({ label: 'label serving', kind: 'serving', quantity: 1, grams: 35 });
    const bar = portionData({ label: 'bar', kind: 'count', quantity: 1, grams: 35, carbs_g: 24 });
    expect(foodBasisSummary(food, [serving, bar])).toBe('24 g carbs per bar');
  });

  it('does not derive a serving from a volume portion or an invalid per 100 g basis', () => {
    const cup = portionData({ label: 'cup', kind: 'volume', quantity: 1, grams: 158 });
    expect(foodBasisSummary(foodData({ carbs_per_100g: 28 }), [cup])).toBe('28 g carbs per 100 g');
    const slice = portionData({ label: 'slice', kind: 'count', quantity: 1, grams: 30 });
    expect(foodBasisSummary(foodData({ carbs_per_100g: 250 }), [slice])).toBeNull();
  });

  it('does not derive a serving from a row whose own carbs are invalid (it is not logged from per 100 g)', () => {
    const bad = portionData({ label: 'bar', kind: 'count', quantity: 1, grams: 35, carbs_g: 600 });
    expect(foodBasisSummary(foodData({ carbs_per_100g: 68.57 }), [bad])).toBe('68.57 g carbs per 100 g');
  });

  it('picks the lowest-id portion regardless of row order', () => {
    const food = foodData({ carbs_per_100g: 50 });
    const b = portionData({ id: 'b', label: 'roll', kind: 'count', quantity: 1, grams: 60 });
    const a = portionData({ id: 'a', label: 'slice', kind: 'count', quantity: 1, grams: 30 });
    expect(foodBasisSummary(food, [b, a])).toBe('15 g carbs per slice (30 g)');
    expect(foodBasisSummary(food, [a, b])).toBe('15 g carbs per slice (30 g)');
  });

  it('is null when there is no valid basis at all', () => {
    expect(foodBasisSummary(foodData({ carbs_per_100g: null }), [])).toBeNull();
  });
});
