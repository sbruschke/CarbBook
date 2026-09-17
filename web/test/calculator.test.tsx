import type { LogEntryData } from '@carbbook/core';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { REFUSAL_MESSAGES } from '../src/dose/dose';
import { Calculator } from '../src/screens/Calculator';
import { foodData, synced } from './helpers';
import { makeServices, NOW, renderWith, seedSettings, type TestServices } from './render';

let services: TestServices;
afterEach(async () => {
  await services.db.delete();
});

async function setup() {
  services = makeServices();
  await seedSettings(services.db);
  await services.db.food.bulkPut([
    synced(foodData({ id: 'tortilla', name: 'Tortilla', carbs_per_100g: 48 })),
    synced(foodData({ id: 'mystery', name: 'Mystery stew', carbs_per_100g: null })),
  ]);
  return userEvent.setup();
}

async function addItem(user: ReturnType<typeof userEvent.setup>, query: string, name: RegExp) {
  await user.type(await screen.findByLabelText('Search foods and meals'), query);
  await user.click(await screen.findByRole('button', { name }));
}

describe('Calculator', () => {
  it('shows live carbs and the dose breakdown labelled as an estimate', async () => {
    const user = await setup();
    renderWith(<Calculator />, services);
    await addItem(user, 'tort', /Tortilla/);
    const amount = await screen.findByLabelText('Amount of Tortilla');
    await user.clear(amount);
    await user.type(amount, '150');
    expect(screen.getByLabelText('Carbs in Tortilla')).toHaveTextContent('72 g');
    await user.type(screen.getByLabelText('BG (mg/dL)'), '263');
    expect(screen.getByTestId('dose-breakdown')).toHaveTextContent('72g ÷ 8 = 9.0 + BG 263 → 2u = 11.0 → 11u');
    expect(screen.getByTestId('dose-units')).toHaveTextContent('11 u');
    expect(screen.getByText('estimate')).toBeInTheDocument();
  });

  it('logs 1 cup of an any-unit (volume-basis) food as 48 g carbs', async () => {
    services = makeServices();
    await seedSettings(services.db);
    await services.db.food.put(synced(foodData({ id: 'rice', name: 'Calrose rice', carbs_per_100g: null, carbs_per_100ml: 20.2884136211058 })));
    const user = userEvent.setup();
    renderWith(<Calculator />, services);
    await addItem(user, 'calrose', /Calrose rice/);
    await user.selectOptions(await screen.findByLabelText('Unit for Calrose rice'), 'cup');
    const amount = screen.getByLabelText('Amount of Calrose rice');
    await user.clear(amount);
    await user.type(amount, '1');
    expect(screen.getByLabelText('Carbs in Calrose rice')).toHaveTextContent('48 g');
  });

  it('shows the refusal reason and no number when carb data is missing', async () => {
    const user = await setup();
    renderWith(<Calculator />, services);
    await addItem(user, 'mystery', /Mystery stew/);
    expect(await screen.findByTestId('dose-refusal')).toHaveTextContent(REFUSAL_MESSAGES.incomplete_carbs);
    expect(screen.queryByTestId('dose-units')).not.toBeInTheDocument();
    expect(screen.getByText('missing data')).toBeInTheDocument();
    expect(screen.getByTestId('total-carbs')).toHaveTextContent('(incomplete)');
  });

  it('prefills a fresh Dexcom reading', async () => {
    const user = await setup();
    services.api.on('GET', '/api/bg', () => ({
      mgdl: 250, trend: 'Flat', arrow: '→', delta_mgdl: 0, read_at: NOW - 5 * 60_000, age_ms: 5 * 60_000, fresh: true,
    }));
    renderWith(<Calculator />, services);
    expect(await screen.findByTestId('bg-reading')).toHaveTextContent('BG 250 → · 5 min ago (Dexcom)');
    await addItem(user, 'tort', /Tortilla/);
    expect(await screen.findByTestId('dose-breakdown')).toHaveTextContent('48g ÷ 8 = 6.0 + BG 250 → 1u = 7.0 → 7u');
  });

  it('logs the entry and copies a USDA food into the synced food table', async () => {
    const user = await setup();
    await services.db.usda_food.put({ fdc_id: 324860, name: 'Peanut butter, smooth style, with salt', carbs_per_100g: 22.3, fiber_per_100g: 4.8 });
    await services.db.usda_portion.put({ id: 119207, fdc_id: 324860, label: 'tbsp', kind: 'volume', quantity: 2, grams: 32, description: 'tablespoon' });
    renderWith(<Calculator />, services);
    await addItem(user, 'peanut', /Peanut butter/);
    const name = 'Peanut butter, smooth style, with salt';
    const amount = await screen.findByLabelText(`Amount of ${name}`);
    await user.clear(amount);
    await user.type(amount, '10');
    await user.selectOptions(screen.getByLabelText(`Unit for ${name}`), 'tbsp');
    await user.type(screen.getByLabelText('BG (mg/dL)'), '120');
    expect(screen.getByTestId('dose-breakdown')).toHaveTextContent('35.7g ÷ 8 = 4.5 + BG 120 → 0u = 4.5 → 4u (rounded down: BG under 130)');
    expect(screen.getByLabelText('Taken (units)')).toHaveValue('4');
    expect(screen.getByText('Prefilled from the estimate — change it if you took a different amount')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Log it' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Logged 35.7 g carbs at 12:00.');
    const [entry] = await services.db.log_entry.toArray();
    expect(entry).toMatchObject({
      eaten_at: NOW, window_name: 'Lunch', bg_mgdl: 120, bg_source: 'manual', suggested_units: 4, taken_units: 4,
      settings_version_id: 'dose-2026-08-12', updated_by: 'device-test',
    });
    expect(entry!.total_carbs_g).toBeCloseTo(35.68, 5);
    expect(await services.db.log_item.toArray()).toEqual([
      expect.objectContaining({ log_entry_id: entry!.id, ref_type: 'food', ref_id: 'usda-324860', display_name: name, amount: 10, unit: 'tbsp' }),
    ]);
    expect(await services.db.food.get('usda-324860')).toMatchObject({ source: 'usda', source_ref: '324860' });
    expect(screen.queryAllByTestId('item-row')).toHaveLength(0);
  });

  it('warns when a dose was logged in the last 4 hours', async () => {
    const user = await setup();
    await services.db.log_entry.put(
      synced<LogEntryData>({
        id: 'earlier', eaten_at: NOW - 2 * 3_600_000, window_name: 'Breakfast', bg_mgdl: null, bg_source: 'none',
        total_carbs_g: 40, suggested_units: 5, taken_units: 5, settings_version_id: null,
      }),
    );
    renderWith(<Calculator />, services);
    await addItem(user, 'tort', /Tortilla/);
    expect(await screen.findByText(/A dose was logged at 10:00, within the last 4 hours/)).toBeInTheDocument();
  });

  it('leaves the taken dose empty and hides the prefill hint when the estimate is a refusal', async () => {
    const user = await setup();
    renderWith(<Calculator />, services);
    await addItem(user, 'mystery', /Mystery stew/);
    await screen.findByTestId('dose-refusal');
    expect(screen.getByLabelText('Taken (units)')).toHaveValue('');
    expect(screen.queryByText('Prefilled from the estimate — change it if you took a different amount')).not.toBeInTheDocument();
  });

  it('clears an unedited prefill when the estimate turns invalid', async () => {
    const user = await setup();
    renderWith(<Calculator />, services);
    await addItem(user, 'tort', /Tortilla/);
    await user.type(screen.getByLabelText('BG (mg/dL)'), '120');
    expect(await screen.findByLabelText('Taken (units)')).not.toHaveValue('');

    await addItem(user, 'mystery', /Mystery stew/);
    await screen.findByTestId('dose-refusal');
    expect(screen.getByLabelText('Taken (units)')).toHaveValue('');
  });

  it('never overwrites a user-edited taken dose when the estimate changes', async () => {
    const user = await setup();
    renderWith(<Calculator />, services);
    await addItem(user, 'tort', /Tortilla/);
    await user.type(screen.getByLabelText('BG (mg/dL)'), '120');
    const takenInput = await screen.findByLabelText('Taken (units)');
    await user.clear(takenInput);
    await user.type(takenInput, '99');

    await user.clear(screen.getByLabelText('BG (mg/dL)'));
    await user.type(screen.getByLabelText('BG (mg/dL)'), '250');
    expect(screen.getByLabelText('Taken (units)')).toHaveValue('99');
  });

  it('logs carbs only with taken_units null when the taken dose is left empty', async () => {
    const user = await setup();
    renderWith(<Calculator />, services);
    await addItem(user, 'mystery', /Mystery stew/);
    const amount = await screen.findByLabelText('Amount of Mystery stew');
    await user.clear(amount);
    await user.type(amount, '100');
    expect(screen.getByLabelText('Taken (units)')).toHaveValue('');

    await user.click(screen.getByRole('button', { name: 'Log it' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Logged');
    const [entry] = await services.db.log_entry.toArray();
    expect(entry).toMatchObject({ taken_units: null, suggested_units: null });
  });

  it('saves the current items as a meal', async () => {
    const user = await setup();
    renderWith(<Calculator />, services);
    await addItem(user, 'tort', /Tortilla/);
    await user.click(screen.getByRole('button', { name: 'Save as meal' }));
    await user.type(screen.getByLabelText('Meal name'), 'Taco night');
    const yieldInput = screen.getByLabelText('Yield (servings)');
    await user.clear(yieldInput);
    await user.type(yieldInput, '3');
    await user.click(screen.getByRole('button', { name: 'Save meal' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Saved meal "Taco night".');
    await waitFor(async () => expect(await services.db.meal_item.count()).toBe(1));
    const [meal] = await services.db.meal.toArray();
    expect(meal).toMatchObject({ name: 'Taco night', yield_servings: 3, total_weight_g: null });
    expect(await services.db.meal_item.toArray()).toEqual([
      expect.objectContaining({ meal_id: meal!.id, ref_type: 'food', ref_id: 'tortilla', amount: 100, unit: 'g', position: 0 }),
    ]);
  });

  const rejection = (rejectedUpdatedAt: number) => ({
    key: 'dose_settings:dose-2026-08-12', table: 'dose_settings', id: 'dose-2026-08-12', reason: 'append_only',
    message: 'overlaps', at: NOW, rejectedUpdatedAt, resolved: false,
  });

  it('still uses a version whose rejected edit was restored (same exclusion as selectActiveSettings)', async () => {
    const user = await setup();
    // The seeded row sits at updated_at 1000; the rejected edit was a different (later) version.
    await services.db.sync_error.put(rejection(2000));
    renderWith(<Calculator />, services);
    await addItem(user, 'tort', /Tortilla/);
    expect(await screen.findByTestId('dose-units')).toBeInTheDocument();
  });

  it('excludes a version whose failed restore left it at the rejected version', async () => {
    const user = await setup();
    await services.db.sync_error.put(rejection(1000));
    renderWith(<Calculator />, services);
    await addItem(user, 'tort', /Tortilla/);
    expect(await screen.findByText(/no dose settings apply at this time/)).toBeInTheDocument();
    expect(screen.queryByTestId('dose-units')).not.toBeInTheDocument();
  });
});

describe('quick carbs rows', () => {
  it('adds a labelled quick row, counts it in the total and dose, and logs it as a snapshot', async () => {
    const user = await setup();
    renderWith(<Calculator />, services);
    await addItem(user, 'tort', /Tortilla/); // 100 g → 48 g
    await user.click(screen.getByRole('button', { name: '+ Carbs' }));
    await user.type(screen.getByLabelText('Label for carbs row 1'), 'Ranch & salad');
    await user.type(screen.getByLabelText('Grams of carbs for carbs row 1'), '7,5');
    expect(screen.getByText('Ranch & salad — 7.5 g carbs')).toBeInTheDocument();
    expect(screen.getByTestId('total-carbs')).toHaveTextContent('55.5 g');
    expect(screen.getByTestId('dose-breakdown')).toHaveTextContent('55.5g ÷ 8');

    await user.click(screen.getByRole('button', { name: 'Log it' }));
    await screen.findByText(/Logged 55.5 g carbs/);
    const [entry] = await services.db.log_entry.toArray();
    expect(entry!.total_carbs_g).toBe(55.5);
    const quick = (await services.db.log_item.toArray()).find((i) => i.ref_type === 'quick')!;
    expect(quick).toMatchObject({ log_entry_id: entry!.id, display_name: 'Ranch & salad', amount: 7.5, unit: 'carbs', carbs_g: 7.5 });
    expect(quick.ref_id).toBe(quick.id);
  });

  it('logs a blank label as "Extra carbs"', async () => {
    const user = await setup();
    renderWith(<Calculator />, services);
    await user.click(await screen.findByRole('button', { name: '+ Carbs' }));
    await user.type(screen.getByLabelText('Grams of carbs for carbs row 1'), '12');
    await user.click(screen.getByRole('button', { name: 'Log it' }));
    await screen.findByText(/Logged 12 g carbs/);
    expect((await services.db.log_item.toArray())[0]).toMatchObject({ display_name: 'Extra carbs', carbs_g: 12 });
  });

  it.each(['', '1/2', '2001', '-3'])('refuses a dose and blocks logging for quick grams %j (fail closed)', async (text) => {
    const user = await setup();
    renderWith(<Calculator />, services);
    await addItem(user, 'tort', /Tortilla/);
    await user.click(screen.getByRole('button', { name: '+ Carbs' }));
    if (text) await user.type(screen.getByLabelText('Grams of carbs for carbs row 1'), text);
    expect(await screen.findByTestId('dose-refusal')).toHaveTextContent(REFUSAL_MESSAGES.incomplete_carbs);
    expect(screen.queryByTestId('dose-units')).not.toBeInTheDocument();
    expect(screen.getByTestId('total-carbs')).toHaveTextContent('(incomplete)');
    await user.click(screen.getByRole('button', { name: 'Log it' }));
    expect(await screen.findByText('Enter an amount for every item before logging.')).toBeInTheDocument();
    expect(await services.db.log_entry.count()).toBe(0);
  });

  it('saves quick rows into a new meal with their label', async () => {
    const user = await setup();
    renderWith(<Calculator />, services);
    await addItem(user, 'tort', /Tortilla/);
    await user.click(screen.getByRole('button', { name: '+ Carbs' }));
    await user.type(screen.getByLabelText('Label for carbs row 1'), ' Salsa ');
    await user.type(screen.getByLabelText('Grams of carbs for carbs row 1'), '6');
    await user.click(screen.getByRole('button', { name: 'Save as meal' }));
    await user.type(screen.getByLabelText('Meal name'), 'Taco plate');
    await user.click(screen.getByRole('button', { name: 'Save meal' }));
    await screen.findByText('Saved meal "Taco plate".');
    const quick = (await services.db.meal_item.toArray()).find((i) => i.ref_type === 'quick')!;
    expect(quick).toMatchObject({ amount: 6, unit: 'carbs', label: 'Salsa', position: 1 });
    expect(quick.ref_id).toBe(quick.id);
  });
});
