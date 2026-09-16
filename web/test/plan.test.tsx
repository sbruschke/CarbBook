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
