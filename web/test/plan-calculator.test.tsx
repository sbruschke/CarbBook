import type { PlanItemData } from '@carbbook/core';
import { screen, waitFor } from '@testing-library/react';
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

import { DISMISSED_KEY } from '../src/plan/dismissed';

describe('Skip and Dismiss', () => {
  it('Skip sets the slot to skipped and queues it for sync', async () => {
    const user = await setup();
    renderWith(<Calculator />, services);
    await user.click(await screen.findByRole('button', { name: 'Skip' }));

    expect((await services.db.plan_entry.get('p1'))!.status).toBe('skipped');
    expect(await services.db.outbox.get('plan_entry:p1')).toBeDefined();
    // usePlanData's live query re-renders one tick after Dexie's own commit notification, so the
    // suggestion line's disappearance is awaited rather than checked synchronously after click().
    await waitFor(() => expect(screen.queryByTestId('plan-suggestion')).not.toBeInTheDocument());
  });

  it('Dismiss hides it on this device only and never touches the record', async () => {
    const user = await setup();
    renderWith(<Calculator />, services);
    await user.click(await screen.findByRole('button', { name: 'Dismiss' }));

    expect(screen.queryByTestId('plan-suggestion')).not.toBeInTheDocument();
    expect((await services.db.plan_entry.get('p1'))!.status).toBe('planned');
    expect(await services.db.outbox.count()).toBe(0);
    // slotKey normalizes (trim + lowercase) to match the server's case-insensitive window_name
    // comparison — see plan/slots.ts — so the stored dismissal key is lowercased too.
    expect(JSON.parse(localStorage.getItem(DISMISSED_KEY)!)).toEqual(['2026-09-14|lunch']);
  });
});

describe('logging a loaded slot', () => {
  it('marks the slot logged and links the log entry', async () => {
    const user = await setup();
    renderWith(<Calculator />, services);
    await user.click(await screen.findByRole('button', { name: 'Load' }));
    await user.click(screen.getByRole('button', { name: 'Log it' }));
    await screen.findByText(/Logged/);

    const slot = (await services.db.plan_entry.get('p1'))!;
    const [logEntry] = await services.db.log_entry.toArray();
    expect(slot.status).toBe('logged');
    expect(slot.log_entry_id).toBe(logEntry!.id);
  });

  it('leaves the plan alone when logging without loading', async () => {
    const user = await setup();
    renderWith(<Calculator />, services);
    await user.type(await screen.findByLabelText('Search foods and meals'), 'tort');
    await user.click(await screen.findByRole('button', { name: /Tortilla/ }));
    await user.click(screen.getByRole('button', { name: 'Log it' }));
    await screen.findByText(/Logged/);

    expect((await services.db.plan_entry.get('p1'))!.status).toBe('planned');
    expect((await services.db.plan_entry.get('p1'))!.log_entry_id).toBeNull();
  });
});

describe('Calculator total against the window goal', () => {
  it('shows the running total with the current window goal and an accessible label', async () => {
    const user = await setup();
    // Give Lunch a goal of 50-80 on a NEW settings version (append-only).
    const current = (await services.db.dose_settings.toArray())[0]!;
    await services.db.dose_settings.put({
      ...current,
      id: 'dose-goals',
      windows: current.windows.map((w) => (w.name === 'Lunch' ? { ...w, carb_goal: { min: 50, max: 80 } } : { ...w, carb_goal: null })),
    });
    renderWith(<Calculator />, services);
    await user.click(await screen.findByRole('button', { name: 'Load' }));

    const total = await screen.findByTestId('total-carbs');
    expect(total).toHaveTextContent('72 g · goal 50–80');
    expect(total).toHaveTextContent('on target');
    expect(screen.getByLabelText('72 g, goal 50 to 80, on target')).toHaveClass('goal-in');
  });

  it('shows the plain total when the current window has no goal', async () => {
    const user = await setup();
    // SEED_SETTINGS mirrors the live server's deployed goals, where every window has one (Task 10
    // adaptation) — so this case needs an explicit settings version with Lunch's goal cleared,
    // rather than relying on a naturally goal-less window.
    const current = (await services.db.dose_settings.toArray())[0]!;
    await services.db.dose_settings.put({
      ...current,
      id: 'dose-no-goal',
      windows: current.windows.map((w) => ({ ...w, carb_goal: null })),
    });
    renderWith(<Calculator />, services);
    await user.click(await screen.findByRole('button', { name: 'Load' }));
    const total = await screen.findByTestId('total-carbs');
    expect(total).toHaveTextContent('72 g');
    expect(total).not.toHaveTextContent('goal');
  });
});

describe('loading a slot with a quick carbs row', () => {
  it('brings the label and grams along, and logging snapshots them', async () => {
    const user = await setup();
    await services.db.plan_item.put(
      synced<PlanItemData>({ id: 'i2', plan_entry_id: 'p1', ref_type: 'quick', ref_id: 'i2', amount: 7, unit: 'carbs', position: 1, label: 'Ranch & salad' }),
    );
    renderWith(<Calculator />, services);
    expect(await screen.findByTestId('plan-suggestion')).toHaveTextContent('Planned: Tortilla, Ranch & salad · 79 g');
    await user.click(screen.getByRole('button', { name: 'Load' }));
    expect(screen.getByLabelText('Label for carbs row 1')).toHaveValue('Ranch & salad');
    expect(screen.getByLabelText('Grams of carbs for carbs row 1')).toHaveValue('7');
    expect(screen.getByTestId('total-carbs')).toHaveTextContent('79 g');

    await user.click(screen.getByRole('button', { name: 'Log it' }));
    await screen.findByText(/Logged 79 g carbs/);
    const quick = (await services.db.log_item.toArray()).find((i) => i.ref_type === 'quick')!;
    expect(quick).toMatchObject({ display_name: 'Ranch & salad', amount: 7, unit: 'carbs', carbs_g: 7 });
    expect(quick.id).not.toBe('i2');
    expect(quick.ref_id).toBe(quick.id);
    expect((await services.db.plan_entry.get('p1'))!.status).toBe('logged');
  });
});
