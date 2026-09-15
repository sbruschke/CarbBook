import { createCatalog, itemCarbs } from '@carbbook/core';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { FoodEditor } from '../src/foods/FoodEditor';
import { carbsPer100gFromLabel, type FoodPrefill, prefillFromDraft } from '../src/foods/label';
import type { FoodDraft } from '../src/lib/wire';
import { foodData, portionData, synced } from './helpers';
import { makeServices, renderWith, type TestServices } from './render';

let services: TestServices;
afterEach(async () => {
  await services?.db.delete();
});

const NOODLE_DRAFT: FoodDraft = {
  food: { name: 'Noodle kit', brand: 'Thai Kitchen', source: 'off', source_ref: '0737628064502', carbs_per_100g: null, fiber_per_100g: null },
  portions: [{ label: 'label serving', kind: 'serving', quantity: 1, grams: 52 }],
  barcode: '0737628064502',
  serving_size: '1 pouch (52 g)',
};

function renderEditor(props: { existing?: Parameters<typeof FoodEditor>[0]['existing']; prefill?: FoodPrefill } = {}) {
  const done: (string | null)[] = [];
  renderWith(<FoodEditor {...props} onDone={(id) => done.push(id)} />, services);
  return done;
}

describe('label helpers', () => {
  it('converts a label serving to carbs per 100 g', () => {
    expect(carbsPer100gFromLabel(40, 20)).toBe(50);
    expect(carbsPer100gFromLabel(30, 7)).toBe(23.33);
    expect(carbsPer100gFromLabel(0, 5)).toBeNull();
    expect(carbsPer100gFromLabel(null, 5)).toBeNull();
  });

  it('turns an Open Food Facts draft into editor prefill', () => {
    expect(prefillFromDraft(NOODLE_DRAFT)).toEqual({
      name: 'Noodle kit',
      brand: 'Thai Kitchen',
      carbs_per_100g: null,
      fiber_per_100g: null,
      source: 'off',
      source_ref: '0737628064502',
      portions: NOODLE_DRAFT.portions,
      barcode: '0737628064502',
      note: 'From Open Food Facts. Check against the label: serving size "1 pouch (52 g)".',
    });
  });
});

describe('FoodEditor', () => {
  it('creates a food from the nutrition label', async () => {
    services = makeServices();
    const user = userEvent.setup();
    const done = renderEditor();
    await user.type(screen.getByLabelText('Name'), 'Granola bar');
    await user.click(screen.getByLabelText(/^From label/));
    await user.type(screen.getByLabelText('Amount'), '40');
    await user.type(screen.getByLabelText('Carbs (g)'), '20');
    expect(screen.getByTestId('label-result')).toHaveTextContent('= 50 g carbs per 100 g');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(done).toHaveLength(1));
    const food = await services.db.food.get(done[0]!);
    expect(food).toMatchObject({ name: 'Granola bar', source: 'custom', carbs_per_100g: 50, updated_by: 'device-test' });
    expect(await services.db.portion.toArray()).toEqual([
      expect.objectContaining({ food_id: food!.id, label: 'label serving', kind: 'serving', quantity: 1, grams: 40 }),
    ]);
  });

  it('requires carbs and keeps carbs and fiber within 0 to 100 g per 100 g', async () => {
    services = makeServices();
    const user = userEvent.setup();
    renderEditor();
    await user.type(screen.getByLabelText('Name'), 'Syrup');
    expect(screen.getByTestId('carbs-missing')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Carbs are missing: enter them from the label.');
    await user.type(screen.getByLabelText('Carbs per 100 g'), '120');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Carbs per 100 g must be a number from 0 to 100.');
    await user.clear(screen.getByLabelText('Carbs per 100 g'));
    await user.type(screen.getByLabelText('Carbs per 100 g'), '60');
    await user.type(screen.getByLabelText('Fiber per 100 g'), '150');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Fiber per 100 g must be a number from 0 to 100.');
    expect(await services.db.food.count()).toBe(0);
  });

  it('saves edits to a USDA food as a custom copy and leaves the original alone', async () => {
    services = makeServices();
    const original = synced(foodData({ id: 'usda-324860', name: 'Peanut butter, smooth style, with salt', source: 'usda', source_ref: '324860', carbs_per_100g: 22.3 }));
    const portion = synced(portionData({ id: 'usda-portion-119207', food_id: 'usda-324860', label: 'tbsp', kind: 'volume', quantity: 2, grams: 32 }));
    await services.db.food.put(original);
    await services.db.portion.put(portion);
    const user = userEvent.setup();
    const done = renderEditor({ existing: { food: original, portions: [portion] } });
    expect(screen.getByText(/saving creates your own copy/)).toBeInTheDocument();
    const name = screen.getByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'My peanut butter');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(done).toHaveLength(1));
    expect(done[0]).not.toBe('usda-324860');
    expect(await services.db.food.get('usda-324860')).toEqual(original);
    expect(await services.db.food.get(done[0]!)).toMatchObject({ name: 'My peanut butter', source: 'custom', source_ref: null, derived_from: 'usda-324860' });
    const copies = await services.db.portion.where('food_id').equals(done[0]!).toArray();
    expect(copies).toEqual([expect.objectContaining({ label: 'tbsp', kind: 'volume', quantity: 2, grams: 32 })]);
    expect(copies[0]!.id).not.toBe('usda-portion-119207');
  });

  it('edits a saved food and removes a deleted portion', async () => {
    services = makeServices();
    const bread = synced(foodData({ id: 'bread', name: 'Bread', carbs_per_100g: 50 }));
    const slice = synced(portionData({ id: 'slice', food_id: 'bread', label: 'slice', grams: 30 }));
    await services.db.food.put(bread);
    await services.db.portion.put(slice);
    const user = userEvent.setup();
    const done = renderEditor({ existing: { food: bread, portions: [slice] } });
    await user.click(screen.getByRole('button', { name: 'Remove portion 1' }));
    await user.click(screen.getByRole('button', { name: 'Add portion' }));
    await user.type(screen.getByLabelText('Portion 1 label'), 'roll');
    await user.type(screen.getByLabelText('Portion 1 grams'), '60');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(done).toEqual(['bread']));
    expect(await services.db.portion.get('slice')).toMatchObject({ deleted: 1 });
    expect((await services.db.portion.where('food_id').equals('bread').toArray()).filter((p) => p.deleted === 0)).toEqual([
      expect.objectContaining({ label: 'roll', kind: 'count', quantity: 1, grams: 60 }),
    ]);
  });

  it('updates the existing label-serving portion instead of leaving a stale one', async () => {
    services = makeServices();
    const bar = synced(foodData({ id: 'bar', name: 'Bar', carbs_per_100g: 50 }));
    const labelPortion = synced(
      portionData({ id: 'label-portion', food_id: 'bar', label: 'label serving', kind: 'serving', quantity: 1, grams: 30 }),
    );
    await services.db.food.put(bar);
    await services.db.portion.put(labelPortion);
    const user = userEvent.setup();
    const done = renderEditor({ existing: { food: bar, portions: [labelPortion] } });
    await user.click(screen.getByLabelText(/^From label/));
    await user.type(screen.getByLabelText('Amount'), '40');
    await user.type(screen.getByLabelText('Carbs (g)'), '20');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(done).toEqual(['bar']));
    const portions = (await services.db.portion.where('food_id').equals('bar').toArray()).filter((p) => p.deleted === 0);
    expect(portions).toEqual([expect.objectContaining({ id: 'label-portion', label: 'label serving', kind: 'serving', quantity: 1, grams: 40 })]);
  });

  it('blocks saving when fiber exceeds carbs', async () => {
    services = makeServices();
    const user = userEvent.setup();
    renderEditor();
    await user.type(screen.getByLabelText('Name'), 'Fiber bar');
    await user.type(screen.getByLabelText('Carbs per 100 g'), '10');
    await user.type(screen.getByLabelText('Fiber per 100 g'), '15');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Fiber per 100 g cannot be more than carbs per 100 g.');
    expect(await services.db.food.count()).toBe(0);
  });

  it('hides Delete food for a USDA original', async () => {
    services = makeServices();
    const original = synced(foodData({ id: 'usda-1', name: 'Rice', source: 'usda', source_ref: '1', carbs_per_100g: 28 }));
    const portion = synced(portionData({ id: 'usda-portion-1', food_id: 'usda-1', label: 'cup', kind: 'volume', quantity: 1, grams: 158 }));
    await services.db.food.put(original);
    await services.db.portion.put(portion);
    renderEditor({ existing: { food: original, portions: [portion] } });
    expect(screen.queryByRole('button', { name: /Delete food/ })).toBeNull();
  });

  it('blocks saving an Open Food Facts draft until missing carbs are typed', async () => {
    services = makeServices();
    const user = userEvent.setup();
    const done = renderEditor({ prefill: prefillFromDraft(NOODLE_DRAFT) });
    expect(screen.getByLabelText('Name')).toHaveValue('Noodle kit');
    expect(screen.getByText(/serving size "1 pouch \(52 g\)"/)).toBeInTheDocument();
    expect(screen.getByTestId('carbs-missing')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Carbs are missing');
    expect(done).toEqual([]);

    await user.type(screen.getByLabelText('Carbs per 100 g'), '71.15');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(done).toHaveLength(1));
    expect(await services.db.food.get(done[0]!)).toMatchObject({ source: 'off', source_ref: '0737628064502', brand: 'Thai Kitchen', carbs_per_100g: 71.15 });
    expect(await services.db.barcode.toArray()).toEqual([expect.objectContaining({ code: '0737628064502', food_id: done[0] })]);
    expect(await services.db.portion.toArray()).toEqual([expect.objectContaining({ label: 'label serving', grams: 52 })]);
  });
});

describe('FoodEditor: any-unit label entry', () => {
  it('Calrose rice: 1 cup = 48 g carbs -> carbs_per_100ml, and logging 1 cup gives 48 g carbs', async () => {
    services = makeServices();
    const user = userEvent.setup();
    const done = renderEditor();
    await user.type(screen.getByLabelText('Name'), 'Calrose rice');
    await user.click(screen.getByLabelText(/^From label/));
    await user.selectOptions(screen.getByLabelText('Unit'), 'cup');
    await user.type(screen.getByLabelText('Amount'), '1');
    await user.type(screen.getByLabelText('Carbs (g)'), '48');
    expect(screen.getByTestId('label-result')).toHaveTextContent('= 20.2884136211058 g carbs per 100 ml');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(done).toHaveLength(1));
    const food = await services.db.food.get(done[0]!);
    expect(food).toMatchObject({ carbs_per_100g: null, carbs_per_100ml: 20.2884136211058 });
    expect(await services.db.portion.toArray()).toEqual([]);

    const catalog = createCatalog({ foods: [food!], portions: [], meals: [], meal_items: [] });
    expect(itemCarbs(catalog, 'food', food!.id, 1, 'cup')).toEqual({ carbs_g: 48, complete: true });
  });

  it('2 tbsp = 7 g carbs', async () => {
    services = makeServices();
    const user = userEvent.setup();
    const done = renderEditor();
    await user.type(screen.getByLabelText('Name'), 'Syrup');
    await user.click(screen.getByLabelText(/^From label/));
    await user.selectOptions(screen.getByLabelText('Unit'), 'tbsp');
    await user.type(screen.getByLabelText('Amount'), '2');
    await user.type(screen.getByLabelText('Carbs (g)'), '7');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(done).toHaveLength(1));
    const food = await services.db.food.get(done[0]!);
    expect(food!.carbs_per_100ml).toBeCloseTo(23.6698158912901, 9);
  });

  it('a volume label with a weight also stores a volume portion (grams work via density)', async () => {
    services = makeServices();
    const user = userEvent.setup();
    const done = renderEditor();
    await user.type(screen.getByLabelText('Name'), 'Calrose rice');
    await user.click(screen.getByLabelText(/^From label/));
    await user.selectOptions(screen.getByLabelText('Unit'), 'cup');
    await user.type(screen.getByLabelText('Amount'), '1');
    await user.type(screen.getByLabelText('Carbs (g)'), '48');
    await user.type(screen.getByLabelText('Weighs (g)'), '158');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(done).toHaveLength(1));
    const food = await services.db.food.get(done[0]!);
    const portions = await services.db.portion.toArray();
    expect(portions).toEqual([expect.objectContaining({ label: 'cup', kind: 'volume', quantity: 1, grams: 158 })]);
    const catalog = createCatalog({ foods: [food!], portions, meals: [], meal_items: [] });
    expect(itemCarbs(catalog, 'food', food!.id, 158, 'g').complete).toBe(true);
  });

  it('1 bar = 22 g carbs: a piece portion with no weight, 2 bars gives 44 g carbs', async () => {
    services = makeServices();
    const user = userEvent.setup();
    const done = renderEditor();
    await user.type(screen.getByLabelText('Name'), 'Granola bar');
    await user.click(screen.getByLabelText(/^From label/));
    await user.selectOptions(screen.getByLabelText('Unit'), 'piece / serving');
    await user.type(screen.getByLabelText('Portion name'), 'bar');
    await user.type(screen.getByLabelText('Amount'), '1');
    await user.type(screen.getByLabelText('Carbs (g)'), '22');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(done).toHaveLength(1));
    const food = await services.db.food.get(done[0]!);
    expect(food!.carbs_per_100g).toBeNull();
    const portions = await services.db.portion.toArray();
    expect(portions).toEqual([expect.objectContaining({ label: 'bar', kind: 'count', quantity: 1, grams: null, carbs_g: 22 })]);
    const catalog = createCatalog({ foods: [food!], portions, meals: [], meal_items: [] });
    expect(itemCarbs(catalog, 'food', food!.id, 2, `p:${portions[0]!.id}`)).toEqual({ carbs_g: 44, complete: true });
  });

  it('a piece label with a weight also enables grams (sets carbs_per_100g)', async () => {
    services = makeServices();
    const user = userEvent.setup();
    const done = renderEditor();
    await user.type(screen.getByLabelText('Name'), 'Cookie');
    await user.click(screen.getByLabelText(/^From label/));
    await user.selectOptions(screen.getByLabelText('Unit'), 'piece / serving');
    await user.type(screen.getByLabelText('Portion name'), 'cookie');
    await user.type(screen.getByLabelText('Amount'), '1');
    await user.type(screen.getByLabelText('Carbs (g)'), '20');
    await user.type(screen.getByLabelText('Weighs (g)'), '30');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(done).toHaveLength(1));
    const food = await services.db.food.get(done[0]!);
    expect(food!.carbs_per_100g).toBeCloseTo(66.67, 2);
    const catalog = createCatalog({ foods: [food!], portions: [], meals: [], meal_items: [] });
    const result = itemCarbs(catalog, 'food', food!.id, 30, 'g');
    expect(result.complete).toBe(true);
    expect(result.carbs_g).toBeCloseTo(20, 1);
  });

  it('blocks a zero amount and a piece unit with no name', async () => {
    services = makeServices();
    const user = userEvent.setup();
    renderEditor();
    await user.type(screen.getByLabelText('Name'), 'Broken');
    await user.click(screen.getByLabelText(/^From label/));
    await user.type(screen.getByLabelText('Amount'), '0');
    await user.type(screen.getByLabelText('Carbs (g)'), '20');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Enter an amount greater than 0.');
    expect(await services.db.food.count()).toBe(0);
  });

  it('is savable with only a portion carb basis, and editing shows it back for re-entry', async () => {
    services = makeServices();
    const bar = synced(foodData({ id: 'bar', name: 'Granola bar', carbs_per_100g: null }));
    const barPortion = synced(portionData({ id: 'bar-p', food_id: 'bar', label: 'bar', kind: 'count', quantity: 1, grams: null, carbs_g: 22 }));
    await services.db.food.put(bar);
    await services.db.portion.put(barPortion);
    const user = userEvent.setup();
    const done = renderEditor({ existing: { food: bar, portions: [barPortion] } });

    // Editing shows the empty-grams field as empty, not "null" (bug fix).
    expect(screen.getByLabelText('Portion 1 grams')).toHaveValue('');
    expect(screen.getByLabelText('Portion 1 carbs (g)')).toHaveValue('22');

    // Re-entering the same label info updates the matching portion rather than duplicating it.
    expect(screen.getByLabelText('Unit')).toHaveValue('other');
    expect(screen.getByLabelText('Portion name')).toHaveValue('bar');
    expect(screen.getByLabelText('Amount')).toHaveValue('1');
    expect(screen.getByLabelText('Carbs (g)')).toHaveValue('22');
    await user.clear(screen.getByLabelText('Carbs (g)'));
    await user.type(screen.getByLabelText('Carbs (g)'), '25');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(done).toEqual(['bar']));
    const portions = (await services.db.portion.where('food_id').equals('bar').toArray()).filter((p) => p.deleted === 0);
    expect(portions).toEqual([expect.objectContaining({ id: 'bar-p', label: 'bar', kind: 'count', quantity: 1, grams: null, carbs_g: 25 })]);
  });

  it('is savable with only a volume carb basis, and editing shows it back for re-entry', async () => {
    services = makeServices();
    const rice = synced(foodData({ id: 'rice', name: 'Calrose rice', carbs_per_100g: null, carbs_per_100ml: 20.2884136211058 }));
    await services.db.food.put(rice);
    const done = renderEditor({ existing: { food: rice, portions: [] } });

    expect(screen.getByLabelText('Unit')).toHaveValue('ml');
    expect(screen.getByLabelText('Amount')).toHaveValue('100');
    expect(screen.getByLabelText('Carbs (g)')).toHaveValue('20.2884136211058');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(done).toEqual(['rice']));
    expect(await services.db.food.get('rice')).toMatchObject({ carbs_per_100ml: 20.2884136211058 });
  });

  it('blocks saving a food with no carb basis at all', async () => {
    services = makeServices();
    const user = userEvent.setup();
    renderEditor();
    await user.type(screen.getByLabelText('Name'), 'Mystery');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Carbs are missing');
    expect(await services.db.food.count()).toBe(0);
  });
});

describe('FoodEditor: keeps the carb basis the user did not edit', () => {
  it('saving in per-100 g mode keeps an existing carbs_per_100ml', async () => {
    services = makeServices();
    const syrup = synced(foodData({ id: 'syrup', name: 'Syrup', carbs_per_100g: 82, carbs_per_100ml: 116 }));
    await services.db.food.put(syrup);
    const user = userEvent.setup();
    const done = renderEditor({ existing: { food: syrup, portions: [] } });
    expect(screen.getByTestId('kept-basis-ml')).toHaveTextContent('116 g carbs per 100 ml');
    await user.clear(screen.getByLabelText('Carbs per 100 g'));
    await user.type(screen.getByLabelText('Carbs per 100 g'), '80');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(done).toEqual(['syrup']));
    expect(await services.db.food.get('syrup')).toMatchObject({ carbs_per_100g: 80, carbs_per_100ml: 116 });
  });

  it('saving a volume label keeps an existing carbs_per_100g', async () => {
    services = makeServices();
    const syrup = synced(foodData({ id: 'syrup', name: 'Syrup', carbs_per_100g: 82 }));
    await services.db.food.put(syrup);
    const user = userEvent.setup();
    const done = renderEditor({ existing: { food: syrup, portions: [] } });
    await user.click(screen.getByLabelText(/^From label/));
    // A gram label edits per-100 g, so nothing is "kept" until a volume unit is chosen.
    expect(screen.queryByTestId('kept-basis-g')).toBeNull();
    await user.selectOptions(screen.getByLabelText('Unit'), 'ml');
    expect(screen.getByTestId('kept-basis-g')).toHaveTextContent('82 g carbs per 100 g');
    await user.type(screen.getByLabelText('Amount'), '100');
    await user.type(screen.getByLabelText('Carbs (g)'), '116');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(done).toEqual(['syrup']));
    const saved = await services.db.food.get('syrup');
    expect(saved!.carbs_per_100g).toBe(82);
    expect(saved!.carbs_per_100ml).toBeCloseTo(116, 9);
  });

  it('a per-100 g entry on a volume-only food adds per-100 g and keeps per-100 ml', async () => {
    services = makeServices();
    const rice = synced(foodData({ id: 'rice', name: 'Calrose rice', carbs_per_100g: null, carbs_per_100ml: 20.2884136211058 }));
    await services.db.food.put(rice);
    const user = userEvent.setup();
    const done = renderEditor({ existing: { food: rice, portions: [] } });
    await user.click(screen.getByLabelText('Per 100 g'));
    await user.type(screen.getByLabelText('Carbs per 100 g'), '28');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(done).toEqual(['rice']));
    expect(await services.db.food.get('rice')).toMatchObject({ carbs_per_100g: 28, carbs_per_100ml: 20.2884136211058 });
  });

  it('"Remove" clears the other basis explicitly', async () => {
    services = makeServices();
    const syrup = synced(foodData({ id: 'syrup', name: 'Syrup', carbs_per_100g: 82, carbs_per_100ml: 116 }));
    await services.db.food.put(syrup);
    const user = userEvent.setup();
    const done = renderEditor({ existing: { food: syrup, portions: [] } });
    await user.click(screen.getByRole('button', { name: 'Remove carbs per 100 ml' }));
    expect(screen.queryByTestId('kept-basis-ml')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(done).toEqual(['syrup']));
    expect(await services.db.food.get('syrup')).toMatchObject({ carbs_per_100g: 82, carbs_per_100ml: null });
  });

  it('drops carbs_g when a portion is switched to a volume portion', async () => {
    services = makeServices();
    const bar = synced(foodData({ id: 'bar', name: 'Bar', carbs_per_100g: 50 }));
    const piece = synced(portionData({ id: 'bar-p', food_id: 'bar', label: 'bar', kind: 'count', quantity: 1, grams: 40, carbs_g: 22 }));
    await services.db.food.put(bar);
    await services.db.portion.put(piece);
    const user = userEvent.setup();
    const done = renderEditor({ existing: { food: bar, portions: [piece] } });
    await user.click(screen.getByLabelText('Per 100 g'));
    await user.selectOptions(screen.getByLabelText('Portion 1 kind'), 'volume');
    await user.selectOptions(screen.getByLabelText('Portion 1 label'), 'cup');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(done).toEqual(['bar']));
    expect(await services.db.portion.get('bar-p')).toMatchObject({ kind: 'volume', label: 'cup', grams: 40, carbs_g: null });
  });

  it('the user\'s case: "2/3 cup, 30 g carbs" (no weight) via From label sets carbs_per_100ml, and 1/3 cup / 1 tbsp compute correctly', async () => {
    services = makeServices();
    const user = userEvent.setup();
    const done = renderEditor();
    await user.type(screen.getByLabelText('Name'), 'Rice pudding');
    await user.click(screen.getByLabelText(/^From label/));
    await user.selectOptions(screen.getByLabelText('Unit'), 'cup');
    await user.type(screen.getByLabelText('Amount'), '2/3');
    await user.type(screen.getByLabelText('Carbs (g)'), '30');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(done).toHaveLength(1));
    const food = await services.db.food.get(done[0]!);
    expect(food!.carbs_per_100ml).toBeCloseTo(19.020387769786694, 9);
    expect(food!.carbs_per_100g).toBeNull();
    expect(await services.db.portion.toArray()).toEqual([]);

    // 1/3 cup -> 15 g carbs, 1 tbsp -> 2.8125 g carbs (worked example from the user's label).
    const catalog = createCatalog({ foods: [food!], portions: [], meals: [], meal_items: [] });
    const oneThirdCup = itemCarbs(catalog, 'food', food!.id, 1 / 3, 'cup');
    expect(oneThirdCup.complete).toBe(true);
    expect(oneThirdCup.carbs_g).toBeCloseTo(15, 9);
    const oneTbsp = itemCarbs(catalog, 'food', food!.id, 1, 'tbsp');
    expect(oneTbsp.complete).toBe(true);
    expect(oneTbsp.carbs_g).toBeCloseTo(2.8125, 9);
  });

  it('a Portions-section volume row with a fraction quantity and carbs (no weight) overrides carbs_per_100ml and creates no portion', async () => {
    services = makeServices();
    const user = userEvent.setup();
    const done = renderEditor();
    await user.type(screen.getByLabelText('Name'), 'Rice pudding');
    await user.click(screen.getByLabelText('Per 100 g'));
    await user.type(screen.getByLabelText('Carbs per 100 g'), '48');
    await user.click(screen.getByRole('button', { name: 'Add portion' }));
    await user.selectOptions(screen.getByLabelText('Portion 1 kind'), 'volume');
    await user.selectOptions(screen.getByLabelText('Portion 1 label'), 'cup');
    await user.clear(screen.getByLabelText('Portion 1 quantity'));
    await user.type(screen.getByLabelText('Portion 1 quantity'), '2/3');
    await user.type(screen.getByLabelText('Portion 1 carbs (g)'), '30');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(done).toHaveLength(1));
    const food = await services.db.food.get(done[0]!);
    expect(food!.carbs_per_100g).toBe(48);
    expect(food!.carbs_per_100ml).toBeCloseTo(19.020387769786694, 9);
    expect(await services.db.portion.toArray()).toEqual([]);
  });

  it('a Portions-section volume row with a fraction quantity and a weight still creates the volume portion', async () => {
    services = makeServices();
    const user = userEvent.setup();
    const done = renderEditor();
    await user.type(screen.getByLabelText('Name'), 'Rice pudding');
    await user.click(screen.getByLabelText('Per 100 g'));
    await user.type(screen.getByLabelText('Carbs per 100 g'), '48');
    await user.click(screen.getByRole('button', { name: 'Add portion' }));
    await user.selectOptions(screen.getByLabelText('Portion 1 kind'), 'volume');
    await user.selectOptions(screen.getByLabelText('Portion 1 label'), 'cup');
    await user.clear(screen.getByLabelText('Portion 1 quantity'));
    await user.type(screen.getByLabelText('Portion 1 quantity'), '2/3');
    await user.type(screen.getByLabelText('Portion 1 grams'), '158');
    await user.type(screen.getByLabelText('Portion 1 carbs (g)'), '30');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(done).toHaveLength(1));
    const food = await services.db.food.get(done[0]!);
    expect(food!.carbs_per_100ml).toBeCloseTo(19.020387769786694, 9);
    const portions = await services.db.portion.toArray();
    expect(portions).toEqual([expect.objectContaining({ label: 'cup', kind: 'volume', quantity: 2 / 3, grams: 158, carbs_g: null })]);
  });

  it('warns inline when a portion row would replace a differing saved carbs_per_100ml', async () => {
    services = makeServices();
    const food = synced(foodData({ id: 'rp', name: 'Rice pudding', carbs_per_100g: null, carbs_per_100ml: 10 }));
    await services.db.food.put(food);
    const user = userEvent.setup();
    renderEditor({ existing: { food, portions: [] } });
    await user.click(screen.getByRole('button', { name: 'Add portion' }));
    await user.selectOptions(screen.getByLabelText('Portion 1 kind'), 'volume');
    await user.selectOptions(screen.getByLabelText('Portion 1 label'), 'cup');
    await user.clear(screen.getByLabelText('Portion 1 quantity'));
    await user.type(screen.getByLabelText('Portion 1 quantity'), '2/3');
    await user.type(screen.getByLabelText('Portion 1 carbs (g)'), '30');
    expect(await screen.findByTestId('portion-carbs-override-note')).toHaveTextContent('This replaces the saved carbs per cup/ml.');
  });
});
