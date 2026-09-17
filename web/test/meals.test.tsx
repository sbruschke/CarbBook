import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { Meals } from '../src/screens/Meals';
import { foodData, mealData, mealItemData, synced } from './helpers';
import { makeServices, renderWith, type TestServices } from './render';

let services: TestServices;
afterEach(async () => {
  await services.db.delete();
});

async function setup() {
  services = makeServices();
  await services.db.food.bulkPut([
    synced(foodData({ id: 'tortilla', name: 'Tortilla', carbs_per_100g: 48 })),
    synced(foodData({ id: 'beans', name: 'Beans', carbs_per_100g: 20 })),
  ]);
  return userEvent.setup();
}

describe('Meals', () => {
  it('builds a meal with live per-serving carbs', async () => {
    const user = await setup();
    renderWith(<Meals />, services);
    await user.click(await screen.findByRole('button', { name: 'New meal' }));
    await user.type(screen.getByLabelText('Name'), 'Burritos');
    const yieldInput = screen.getByLabelText('Yield (servings)');
    await user.clear(yieldInput);
    await user.type(yieldInput, '2');
    const search = screen.getByLabelText('Add a component');
    await user.type(search, 'tort');
    await user.click(await screen.findByRole('button', { name: /Tortilla/ }));
    await user.type(search, 'bea');
    await user.click(await screen.findByRole('button', { name: /Beans/ }));
    expect(screen.getByTestId('meal-carbs')).toHaveTextContent('34 g carbs per serving');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('button', { name: /Burritos/ })).toHaveTextContent('34 g per serving');
    const items = (await services.db.meal_item.toArray()).sort((a, b) => a.position - b.position);
    expect(items.map((i) => [i.ref_id, i.amount, i.unit, i.position])).toEqual([
      ['tortilla', 100, 'g', 0],
      ['beans', 100, 'g', 1],
    ]);
  });

  it('reorders and removes components', async () => {
    const user = await setup();
    await services.db.meal.put(synced(mealData({ id: 'chili', name: 'Chili' })));
    await services.db.meal_item.bulkPut([
      synced(mealItemData({ id: 'i-tortilla', meal_id: 'chili', ref_id: 'tortilla', position: 0 })),
      synced(mealItemData({ id: 'i-beans', meal_id: 'chili', ref_id: 'beans', position: 1 })),
    ]);
    renderWith(<Meals />, services);
    await user.click(await screen.findByRole('button', { name: /Chili/ }));
    await user.click(await screen.findByRole('button', { name: 'Move Beans up' }));
    await user.click(screen.getByRole('button', { name: 'Remove Tortilla' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(async () => expect((await services.db.meal_item.get('i-tortilla'))?.deleted).toBe(1));
    expect(await services.db.meal_item.get('i-beans')).toMatchObject({ position: 0, deleted: 0 });
  });

  it('refuses to add a meal that already contains this meal', async () => {
    const user = await setup();
    await services.db.meal.bulkPut([synced(mealData({ id: 'outer', name: 'Outer' })), synced(mealData({ id: 'inner', name: 'Inner' }))]);
    await services.db.meal_item.bulkPut([
      synced(mealItemData({ id: 'o1', meal_id: 'outer', ref_type: 'meal', ref_id: 'inner', amount: 1, unit: 'serving' })),
      synced(mealItemData({ id: 'n1', meal_id: 'inner', ref_id: 'tortilla' })),
    ]);
    renderWith(<Meals />, services);
    await user.click(await screen.findByRole('button', { name: /Inner/ }));
    await user.type(screen.getByLabelText('Add a component'), 'outer');
    await user.click(await screen.findByRole('button', { name: /Outer/ }));
    expect(screen.getByRole('alert')).toHaveTextContent("Can't add Outer: it already contains this meal.");
    expect(screen.getAllByTestId('item-row')).toHaveLength(1);
  });
});

describe('quick carbs components', () => {
  it('adds a labelled quick component and counts it per serving', async () => {
    const user = await setup();
    renderWith(<Meals />, services);
    await user.click(await screen.findByRole('button', { name: 'New meal' }));
    await user.type(screen.getByLabelText('Name'), 'Taco night');
    await user.type(screen.getByLabelText('Add a component'), 'tort');
    await user.click(await screen.findByRole('button', { name: /Tortilla/ }));
    await user.click(screen.getByRole('button', { name: '+ Carbs' }));
    await user.type(screen.getByLabelText('Label for carbs row 1'), 'Salsa');
    await user.type(screen.getByLabelText('Grams of carbs for carbs row 1'), '6');
    expect(screen.getByTestId('meal-carbs')).toHaveTextContent('54 g carbs per serving');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await screen.findByRole('button', { name: /Taco night/ });
    const quick = (await services.db.meal_item.toArray()).find((i) => i.ref_type === 'quick')!;
    expect(quick).toMatchObject({ amount: 6, unit: 'carbs', label: 'Salsa', position: 1 });
    expect(quick.ref_id).toBe(quick.id);
    const food = (await services.db.meal_item.toArray()).find((i) => i.ref_type === 'food')!;
    expect(food.label).toBeNull();
  });

  it('refuses to save a meal whose quick component has no valid grams', async () => {
    const user = await setup();
    renderWith(<Meals />, services);
    await user.click(await screen.findByRole('button', { name: 'New meal' }));
    await user.type(screen.getByLabelText('Name'), 'Mystery');
    await user.click(screen.getByRole('button', { name: '+ Carbs' }));
    await user.type(screen.getByLabelText('Grams of carbs for carbs row 1'), '2001');
    expect(screen.getByTestId('meal-carbs')).toHaveTextContent('Incomplete carb data');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Every component needs an amount.');
    expect(await services.db.meal.count()).toBe(0);
  });

  it('edits an existing quick component', async () => {
    const user = await setup();
    await services.db.meal.put(synced(mealData({ id: 'salsa-plate', name: 'Salsa plate' })));
    await services.db.meal_item.bulkPut([
      synced(mealItemData({ id: 'i-tortilla', meal_id: 'salsa-plate', ref_id: 'tortilla', position: 0 })),
      synced(mealItemData({ id: 'i-salsa', meal_id: 'salsa-plate', ref_type: 'quick', ref_id: 'i-salsa', amount: 6, unit: 'carbs', label: 'Salsa', position: 1 })),
    ]);
    renderWith(<Meals />, services);
    await user.click(await screen.findByRole('button', { name: /Salsa plate/ }));
    expect(screen.getByLabelText('Label for carbs row 1')).toHaveValue('Salsa');
    const grams = screen.getByLabelText('Grams of carbs for carbs row 1');
    await user.clear(grams);
    await user.type(grams, '8');
    expect(screen.getByTestId('meal-carbs')).toHaveTextContent('56 g carbs per serving');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(async () => expect((await services.db.meal_item.get('i-salsa'))?.amount).toBe(8));
    expect(await services.db.meal_item.get('i-salsa')).toMatchObject({ label: 'Salsa', ref_id: 'i-salsa', unit: 'carbs' });
  });
});
