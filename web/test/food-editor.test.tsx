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
    await user.click(screen.getByLabelText('From label'));
    await user.type(screen.getByLabelText('Serving size (g)'), '40');
    await user.type(screen.getByLabelText('Carbs per serving (g)'), '20');
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
