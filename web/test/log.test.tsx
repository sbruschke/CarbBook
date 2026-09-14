import type { LogEntryData, LogItemData } from '@carbbook/core';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { Log } from '../src/screens/Log';
import { foodData, synced } from './helpers';
import { makeServices, NOW, renderWith, SEED_SETTINGS, seedSettings, type TestServices } from './render';

let services: TestServices;
afterEach(async () => {
  await services.db.delete();
});

const HOUR = 3_600_000;
const entry = (fields: Partial<LogEntryData> & { id: string; eaten_at: number }) =>
  synced<LogEntryData>({
    window_name: 'Lunch', bg_mgdl: null, bg_source: 'none', total_carbs_g: 0, suggested_units: null, taken_units: null,
    settings_version_id: SEED_SETTINGS.id, notes: null, ...fields,
  });
const item = (fields: Partial<LogItemData> & { id: string; log_entry_id: string }) =>
  synced<LogItemData>({ ref_type: 'food', ref_id: 'tortilla', display_name: 'Tortilla', amount: 100, unit: 'g', carbs_g: 0, ...fields });

async function setup() {
  services = makeServices();
  await seedSettings(services.db);
  await services.db.food.put(synced(foodData({ id: 'tortilla', name: 'Tortilla', carbs_per_100g: 48 })));
  await services.db.log_entry.bulkPut([
    entry({ id: 'today', eaten_at: NOW - HOUR, total_carbs_g: 30, suggested_units: 4, taken_units: 4 }),
    entry({ id: 'yesterday', eaten_at: NOW - 24 * HOUR, total_carbs_g: 10 }),
  ]);
  await services.db.log_item.bulkPut([
    item({ id: 'li-today', log_entry_id: 'today', display_name: 'Old tortilla', carbs_g: 30 }),
    item({ id: 'li-yesterday', log_entry_id: 'yesterday', carbs_g: 10 }),
  ]);
  return userEvent.setup();
}

describe('Log', () => {
  it('lists the day with totals and moves between days', async () => {
    const user = await setup();
    renderWith(<Log />, services);
    expect(await screen.findByTestId('day-totals')).toHaveTextContent('30 g carbs · 4 u taken');
    expect(screen.getByRole('button', { name: /11:00 Lunch/ })).toHaveTextContent('Old tortilla');
    await user.click(screen.getByRole('button', { name: 'Previous day' }));
    expect(screen.getByTestId('day-totals')).toHaveTextContent('10 g carbs · 0 u taken');
  });

  it('recalculates an entry from current food data and saves the new snapshot', async () => {
    const user = await setup();
    renderWith(<Log />, services);
    await user.click(await screen.findByRole('button', { name: /11:00 Lunch/ }));
    await user.click(await screen.findByRole('button', { name: 'Recalculate from current meal' }));
    expect(screen.getByTestId('entry-carbs')).toHaveTextContent('Total 48 g carbs');
    expect(screen.getByRole('status')).toHaveTextContent('Recalculated from current foods and meals.');
    expect(screen.getByTestId('dose-breakdown')).toHaveTextContent('48g ÷ 8 = 6.0 → 6u');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(async () => expect((await services.db.log_item.get('li-today'))?.carbs_g).toBe(48));
    expect(await services.db.log_item.get('li-today')).toMatchObject({ display_name: 'Tortilla', updated_by: 'device-test' });
    expect(await services.db.log_entry.get('today')).toMatchObject({ total_carbs_g: 48, suggested_units: 6, taken_units: 4 });
  });

  it('keeps the logged carbs of an item whose food has no data now', async () => {
    const user = await setup();
    await services.db.food.put(synced(foodData({ id: 'tortilla', name: 'Tortilla', carbs_per_100g: null }), { updated_at: 2000 }));
    renderWith(<Log />, services);
    await user.click(await screen.findByRole('button', { name: /11:00 Lunch/ }));
    await user.click(await screen.findByRole('button', { name: 'Recalculate from current meal' }));
    expect(screen.getByRole('status')).toHaveTextContent('Kept the logged carbs for Old tortilla');
    expect(screen.getByTestId('entry-carbs')).toHaveTextContent('Total 30 g carbs');
  });
});
