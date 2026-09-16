import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { loadCatalogData } from '../src/db/catalog';
import { SlotEditor } from '../src/plan/SlotEditor';
import { foodData, synced } from './helpers';
import { makeServices, renderWith, seedSettings, type TestServices } from './render';

let services: TestServices;
afterEach(async () => {
  await services.db.delete();
});

async function setup() {
  services = makeServices();
  await seedSettings(services.db);
  await services.db.food.put(synced(foodData({ id: 'tortilla', name: 'Tortilla', carbs_per_100g: 48 })));
  return { user: userEvent.setup(), data: await loadCatalogData(services.db) };
}

describe('SlotEditor', () => {
  it('adds an item with a fraction amount and saves the slot as planned', async () => {
    const { user, data } = await setup();
    renderWith(<SlotEditor date="2026-09-16" windowName="Lunch" slot={null} data={data} onDone={() => {}} />, services);

    await user.type(screen.getByLabelText('Add to this slot'), 'tort');
    await user.click(await screen.findByRole('button', { name: /Tortilla/ }));
    const amount = screen.getByLabelText('Amount of Tortilla');
    await user.clear(amount);
    await user.type(amount, '2/3');
    await user.click(screen.getByRole('button', { name: 'Save slot' }));

    const [entry] = await services.db.plan_entry.toArray();
    expect(entry).toMatchObject({ date: '2026-09-16', window_name: 'Lunch', status: 'planned', log_entry_id: null });
    const [item] = await services.db.plan_item.toArray();
    expect(item).toMatchObject({ plan_entry_id: entry!.id, ref_id: 'tortilla', amount: 2 / 3, position: 0 });
  });

  it('refuses to save an item with an unparseable amount', async () => {
    const { user, data } = await setup();
    renderWith(<SlotEditor date="2026-09-16" windowName="Lunch" slot={null} data={data} onDone={() => {}} />, services);
    await user.type(screen.getByLabelText('Add to this slot'), 'tort');
    await user.click(await screen.findByRole('button', { name: /Tortilla/ }));
    const amount = screen.getByLabelText('Amount of Tortilla');
    await user.clear(amount);
    await user.type(amount, '11/2');
    await user.click(screen.getByRole('button', { name: 'Save slot' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Every item needs an amount.');
    expect(await services.db.plan_entry.count()).toBe(0);
  });
});

import { Plan } from '../src/screens/Plan';

describe('Plan screen', () => {
  it('shows the Monday-first week containing today, with every window of each day', async () => {
    await setup();
    renderWith(<Plan />, services);
    expect(await screen.findByLabelText('Week starting')).toHaveValue('2026-09-14');
    expect(screen.getByRole('heading', { name: 'Mon 14 Sep' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Sun 20 Sep' })).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { name: 'Lunch' })).toHaveLength(7);
  });

  it('navigates to the previous and next week, including past weeks', async () => {
    const { user } = await setup();
    renderWith(<Plan />, services);
    await user.click(await screen.findByRole('button', { name: 'Previous week' }));
    expect(screen.getByLabelText('Week starting')).toHaveValue('2026-09-07');
    await user.click(screen.getByRole('button', { name: 'Next week' }));
    await user.click(screen.getByRole('button', { name: 'Next week' }));
    expect(screen.getByLabelText('Week starting')).toHaveValue('2026-09-21');
  });

  it('snaps a typed date back to that week Monday', async () => {
    const { user } = await setup();
    renderWith(<Plan />, services);
    const input = await screen.findByLabelText('Week starting');
    await user.clear(input);
    await user.type(input, '2026-09-17');
    expect(input).toHaveValue('2026-09-14');
  });
});

import { within } from '@testing-library/react';
import { synced as sync } from './helpers';

async function seedLunch(date = '2026-09-16', grams = 150) {
  await services.db.plan_entry.put(
    sync({ id: `p-${date}`, date, window_name: 'Lunch', status: 'planned', note: null, log_entry_id: null }),
  );
  await services.db.plan_item.put(
    sync({ id: `i-${date}`, plan_entry_id: `p-${date}`, ref_type: 'food', ref_id: 'tortilla', amount: grams, unit: 'g', position: 0 }),
  );
}

describe('Plan cells', () => {
  it('shows the items, the carbs with the goal and an accessible label, and the status', async () => {
    await setup();
    await seedLunch(); // 150 g tortilla = 72 g carbs, Lunch goal 50-80 → in
    renderWith(<Plan />, services);
    const cell = await screen.findByTestId('plan-cell-2026-09-16-Lunch');
    expect(cell).toHaveTextContent('Tortilla');
    expect(cell).toHaveTextContent('72 g · goal 50–80');
    expect(cell).toHaveTextContent('on target');
    expect(cell).toHaveTextContent('planned');
    expect(within(cell).getByLabelText('72 g, goal 50 to 80, on target')).toHaveClass('goal-in');
  });

  it('colours a slot that is far outside its goal red, still with the numbers in text', async () => {
    await setup();
    await seedLunch('2026-09-16', 300); // 144 g carbs vs 50-80 → out
    renderWith(<Plan />, services);
    const cell = await screen.findByTestId('plan-cell-2026-09-16-Lunch');
    expect(within(cell).getByLabelText('144 g, goal 50 to 80, far outside')).toHaveClass('goal-out');
  });

  it('shows a day total against the summed day goal', async () => {
    await setup();
    await seedLunch();
    renderWith(<Plan />, services);
    const total = await screen.findByTestId('plan-day-total-2026-09-16');
    expect(total).toHaveTextContent('72 g · goal');
  });

  it('shows "missing data" and no number when an item does not resolve', async () => {
    await setup();
    await seedLunch();
    await services.db.plan_item.update('i-2026-09-16', { ref_id: 'not-synced-yet' });
    renderWith(<Plan />, services);
    const cell = await screen.findByTestId('plan-cell-2026-09-16-Lunch');
    expect(cell).toHaveTextContent('missing data');
  });
});
