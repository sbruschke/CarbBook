import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Calculator } from '../src/screens/Calculator';
import { foodData, synced } from './helpers';
import { makeServices, renderWith, seedSettings, type TestServices } from './render';

let services: TestServices;
afterEach(async () => {
  await services.db.delete();
});
beforeEach(() => localStorage.clear());

/** NOW is local noon on 2026-09-14 → the Lunch window of SEED_SETTINGS. */
async function setup(status: 'planned' | 'skipped' = 'planned') {
  services = makeServices();
  await seedSettings(services.db);
  await services.db.food.put(synced(foodData({ id: 'tortilla', name: 'Tortilla', carbs_per_100g: 48 })));
  await services.db.plan_entry.put(
    synced({ id: 'p1', date: '2026-09-14', window_name: 'Lunch', status, note: null, log_entry_id: null }),
  );
  await services.db.plan_item.put(
    synced({ id: 'i1', plan_entry_id: 'p1', ref_type: 'food', ref_id: 'tortilla', amount: 150, unit: 'g', position: 0 }),
  );
  return userEvent.setup();
}

describe('Calculator plan suggestion', () => {
  it('shows the planned slot with its items and carbs', async () => {
    await setup();
    renderWith(<Calculator />, services);
    const line = await screen.findByTestId('plan-suggestion');
    expect(line).toHaveTextContent('Planned: Tortilla · 72 g');
    expect(screen.getByRole('button', { name: 'Load' })).toBeInTheDocument();
  });

  it('shows nothing when the slot is already skipped', async () => {
    await setup('skipped');
    renderWith(<Calculator />, services);
    await screen.findByRole('heading', { name: 'Calculator' });
    expect(screen.queryByTestId('plan-suggestion')).not.toBeInTheDocument();
  });

  it('Load appends editable rows and hides the line', async () => {
    const user = await setup();
    renderWith(<Calculator />, services);
    await user.click(await screen.findByRole('button', { name: 'Load' }));

    expect(screen.getByLabelText('Amount of Tortilla')).toHaveValue('150');
    expect(screen.getByLabelText('Carbs in Tortilla')).toHaveTextContent('72 g');
    expect(screen.queryByTestId('plan-suggestion')).not.toBeInTheDocument();

    const amount = screen.getByLabelText('Amount of Tortilla');
    await user.clear(amount);
    await user.type(amount, '1/2');
    expect(screen.getByLabelText('Carbs in Tortilla')).toHaveTextContent('0.2 g');
  });
});
