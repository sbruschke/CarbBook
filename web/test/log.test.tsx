import type { LogEntryData, LogItemData } from '@carbbook/core';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { REFUSAL_MESSAGES } from '../src/dose/dose';
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
    expect(screen.getByTestId('dose-refusal')).toHaveTextContent(REFUSAL_MESSAGES.incomplete_carbs);
    expect(screen.queryByTestId('dose-units')).not.toBeInTheDocument();
  });

  it('refuses a dose for an item that no longer resolves, and saving notes keeps the stored suggestion', async () => {
    const user = await setup();
    await services.db.food.put(synced(foodData({ id: 'tortilla', name: 'Tortilla', carbs_per_100g: null }), { updated_at: 2000 }));
    renderWith(<Log />, services);
    await user.click(await screen.findByRole('button', { name: /11:00 Lunch/ }));
    expect(await screen.findByTestId('dose-refusal')).toHaveTextContent(REFUSAL_MESSAGES.incomplete_carbs);
    expect(screen.queryByTestId('dose-units')).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('Notes'), 'felt fine');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(async () => expect((await services.db.log_entry.get('today'))?.notes).toBe('felt fine'));
    expect(await services.db.log_entry.get('today')).toMatchObject({ suggested_units: 4, taken_units: 4, total_carbs_g: 30 });
  });

  it('keeps the stored suggestion when only notes change on a complete entry', async () => {
    const user = await setup();
    await services.db.log_entry.update('today', { suggested_units: 7 });
    renderWith(<Log />, services);
    await user.click(await screen.findByRole('button', { name: /11:00 Lunch/ }));
    await user.type(await screen.findByLabelText('Notes'), 'note');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(async () => expect((await services.db.log_entry.get('today'))?.notes).toBe('note'));
    expect(await services.db.log_entry.get('today')).toMatchObject({ suggested_units: 7, taken_units: 4 });
  });

  it('refuses a dose for an invalid BG instead of dropping the correction', async () => {
    const user = await setup();
    renderWith(<Log />, services);
    await user.click(await screen.findByRole('button', { name: /11:00 Lunch/ }));
    await user.type(await screen.findByLabelText('BG (mg/dL)'), '26O');
    expect(screen.getByTestId('dose-refusal')).toHaveTextContent(REFUSAL_MESSAGES.invalid_input);
    expect(screen.queryByTestId('dose-units')).not.toBeInTheDocument();
  });

  it('warns about another dose logged in the last 4 hours, ignoring the entry being edited', async () => {
    const user = await setup();
    renderWith(<Log />, services);
    await user.click(await screen.findByRole('button', { name: /11:00 Lunch/ }));
    await screen.findByTestId('entry-carbs');
    expect(screen.queryByText(/within the last 4 hours/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await services.db.log_entry.put(entry({ id: 'earlier', eaten_at: NOW - 2 * HOUR, taken_units: 2 }));
    await user.click(await screen.findByRole('button', { name: /11:00 Lunch/ }));
    expect(await screen.findByText(/A dose was logged at 10:00, within the last 4 hours/)).toBeInTheDocument();
  });
});

import { LogEntryEditor } from '../src/log/LogEntryEditor';

describe('Log goal colours', () => {
  it('shows each entry carbs against its window goal', async () => {
    const user = await setup();
    const current = (await services.db.dose_settings.toArray())[0]!;
    await services.db.dose_settings.put({
      ...current,
      id: 'dose-goals',
      windows: current.windows.map((w) => (w.name === 'Lunch' ? { ...w, carb_goal: { min: 50, max: 80 } } : { ...w, carb_goal: null })),
    });
    await services.db.log_entry.put(
      synced({
        id: 'log-1',
        eaten_at: NOW,
        window_name: 'Lunch',
        bg_mgdl: null,
        bg_source: 'none',
        bg_trend: null,
        total_carbs_g: 72,
        suggested_units: null,
        taken_units: null,
        settings_version_id: 'dose-goals',
        notes: null,
      }),
    );
    renderWith(<Log />, services);
    expect(await screen.findByLabelText('72 g, goal 50 to 80, on target')).toHaveClass('goal-in');
    expect(user).toBeDefined();
  });
});

describe('deleting a logged entry', () => {
  it('returns the slot it came from to planned and clears the link', async () => {
    const user = await setup();
    await services.db.log_entry.put(
      synced({
        id: 'log-1',
        eaten_at: NOW,
        window_name: 'Lunch',
        bg_mgdl: null,
        bg_source: 'none',
        bg_trend: null,
        total_carbs_g: 72,
        suggested_units: null,
        taken_units: null,
        settings_version_id: null,
        notes: null,
      }),
    );
    await services.db.plan_entry.put(
      synced({ id: 'p1', date: '2026-09-14', window_name: 'Lunch', status: 'logged', note: null, log_entry_id: 'log-1' }),
    );
    renderWith(<LogEntryEditor entryId="log-1" onDone={() => {}} />, services);
    await user.click(await screen.findByRole('button', { name: 'Delete entry' }));
    await user.click(screen.getByRole('button', { name: 'Tap again to delete' }));

    const slot = (await services.db.plan_entry.get('p1'))!;
    expect(slot.status).toBe('planned');
    expect(slot.log_entry_id).toBeNull();
  });
});

describe('quick carbs rows in the log', () => {
  it('shows "label · N g carbs" and keeps the label and carbs through a recalculation', async () => {
    const user = await setup();
    await services.db.log_item.put(
      item({ id: 'li-quick', log_entry_id: 'today', ref_type: 'quick', ref_id: 'li-quick', display_name: 'Ranch & salad', amount: 7, unit: 'carbs', carbs_g: 7 }),
    );
    renderWith(<Log />, services);
    await user.click(await screen.findByRole('button', { name: /11:00 Lunch/ }));
    expect(await screen.findByText('Ranch & salad · 7 g carbs')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Recalculate from current meal' }));
    expect(screen.getByTestId('entry-carbs')).toHaveTextContent('Total 55 g carbs');
    expect(screen.getByRole('status')).toHaveTextContent('Recalculated from current foods and meals.');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(async () => expect((await services.db.log_entry.get('today'))?.total_carbs_g).toBe(55));
    expect(await services.db.log_item.get('li-quick')).toMatchObject({ display_name: 'Ranch & salad', amount: 7, carbs_g: 7 });
  });
});
