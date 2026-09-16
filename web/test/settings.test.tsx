import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { setMeta } from '../src/db/meta';
import { ApiError } from '../src/lib/api';
import { Settings } from '../src/screens/Settings';
import { makeServices, NOW, renderWith, SEED_SETTINGS, seedSettings, type TestServices, VIEWER } from './render';

let services: TestServices;
afterEach(async () => {
  await services.db.delete();
});

describe('Settings', () => {
  it('saves edited dose settings as a new version', async () => {
    services = makeServices();
    await seedSettings(services.db);
    const user = userEvent.setup();
    renderWith(<Settings />, services);
    await user.click(await screen.findByRole('button', { name: 'Edit dose settings' }));
    const ratio = screen.getByLabelText('Window 3 carb ratio (g per unit)');
    await user.clear(ratio);
    await user.type(ratio, '9');
    await user.click(screen.getByRole('button', { name: 'Save as new version' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Saved a new dose settings version.');
    await waitFor(async () => expect(await services.db.dose_settings.count()).toBe(2));
    const created = (await services.db.dose_settings.toArray()).find((v) => v.id !== SEED_SETTINGS.id)!;
    expect(created.effective_from).toBe(NOW);
    expect(created.windows.find((w) => w.name === 'Lunch')?.ratio_g_per_unit).toBe(9);
    expect(await services.db.dose_settings.get(SEED_SETTINGS.id)).toMatchObject({ updated_by: 'server' });
    expect(await screen.findAllByTestId('settings-version')).toHaveLength(2);
  });

  it('shows validation errors and saves nothing', async () => {
    services = makeServices();
    await seedSettings(services.db);
    const user = userEvent.setup();
    renderWith(<Settings />, services);
    await user.click(await screen.findByRole('button', { name: 'Edit dose settings' }));
    const step = screen.getByLabelText('Step (mg/dL)');
    await user.clear(step);
    await user.type(step, '0');
    await user.click(screen.getByRole('button', { name: 'Save as new version' }));
    expect(screen.getByRole('alert')).toHaveTextContent('correction step (> 0)');
    expect(await services.db.dose_settings.count()).toBe(1);
  });

  async function editField(label: string, text: string) {
    services = makeServices();
    await seedSettings(services.db);
    const user = userEvent.setup();
    renderWith(<Settings />, services);
    await user.click(await screen.findByRole('button', { name: 'Edit dose settings' }));
    const field = screen.getByLabelText(label);
    await user.clear(field);
    if (text !== '') await user.type(field, text);
    await user.click(screen.getByRole('button', { name: 'Save as new version' }));
    return field;
  }

  it.each([
    ['Window 3 carb ratio (g per unit)', '0x10'],
    ['Window 3 carb ratio (g per unit)', '1e1'],
    ['Window 3 carb ratio (g per unit)', ''],
    ['Units per step', '0x10'],
    ['Units per step', '1e1'],
    ['Units per step', ''],
    ['Round to increment (u)', '1e1'],
    ['Threshold (mg/dL)', '0x10'],
    ['Threshold (mg/dL)', '1e1'],
    ['Threshold (mg/dL)', ''],
    ['Threshold (mg/dL)', '12,5'],
    ['Step (mg/dL)', '1e1'],
    ['Step (mg/dL)', '12,5'],
    ['Round down when BG is below (mg/dL, optional)', '0x10'],
    ['Round down when BG is below (mg/dL, optional)', '12,5'],
  ])('rejects %s = "%s" with a field error and saves nothing', async (label, text) => {
    const field = await editField(label, text);
    expect(screen.getByRole('alert')).toHaveTextContent(label.replace(/ \(.*$/, ''));
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(await services.db.dose_settings.count()).toBe(1);
  });

  it('accepts a comma decimal in a carb ratio as a decimal', async () => {
    await editField('Window 3 carb ratio (g per unit)', '12,5');
    await waitFor(async () => expect(await services.db.dose_settings.count()).toBe(2));
    const created = (await services.db.dose_settings.toArray()).find((v) => v.id !== SEED_SETTINGS.id)!;
    expect(created.windows.find((w) => w.name === 'Lunch')?.ratio_g_per_unit).toBe(12.5);
  });

  it('allows an empty optional round-down BG', async () => {
    await editField('Round down when BG is below (mg/dL, optional)', '');
    await waitFor(async () => expect(await services.db.dose_settings.count()).toBe(2));
    const created = (await services.db.dose_settings.toArray()).find((v) => v.id !== SEED_SETTINGS.id)!;
    expect(created.rounding.round_down_below_bg).toBeNull();
  });

  it('is read-only for viewers', async () => {
    services = makeServices({ user: VIEWER });
    await seedSettings(services.db);
    renderWith(<Settings />, services);
    expect(await screen.findByText('Only the owner can change dose settings.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit dose settings' })).not.toBeInTheDocument();
    expect(await screen.findAllByTestId('settings-version')).toHaveLength(1);
  });

  it('shows pending count, last sync and server rejections', async () => {
    services = makeServices();
    await services.db.outbox.bulkPut([
      { key: 'food:f1', table: 'food', id: 'f1', updated_at: 1, snapshot: null, ownerId: null, ownerUsername: null },
      { key: 'meal:m1', table: 'meal', id: 'm1', updated_at: 1, snapshot: null, ownerId: null, ownerUsername: null },
    ]);
    await setMeta(services.db, 'last_synced_at', NOW);
    await services.db.sync_error.put({ key: 'food:f2', table: 'food', id: 'f2', reason: 'invalid', message: 'carbs_per_100g must be >= 0', at: NOW, rejectedUpdatedAt: 1, resolved: false });
    const user = userEvent.setup();
    renderWith(<Settings />, services);
    // Live queries resolve after the first render, so wait for the values rather than the elements.
    expect(await screen.findByText('2 pending changes')).toHaveAttribute('data-testid', 'pending-count');
    expect(await screen.findByText('Last synced: 2026-09-14 12:00')).toHaveAttribute('data-testid', 'last-synced');
    expect(await screen.findByText('food f2: carbs_per_100g must be >= 0')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(async () => expect(await services.db.sync_error.count()).toBe(0));
  });

  it('shows another user’s held changes and discards them on confirm', async () => {
    services = makeServices();
    await services.db.outbox.put({
      key: 'food:f1',
      table: 'food',
      id: 'f1',
      updated_at: 1,
      snapshot: null,
      ownerId: 99,
      ownerUsername: 'dana',
    });
    await services.db.food.put({
      id: 'f1',
      name: 'Dana’s food',
      brand: null,
      source: 'custom',
      source_ref: null,
      derived_from: null,
      carbs_per_100g: 10,
      fiber_per_100g: null,
      density_g_per_ml: null,
      notes: null,
      updated_at: 1,
      updated_by: 'device-dana',
      deleted: 0,
    });
    const user = userEvent.setup();
    renderWith(<Settings />, services);

    expect(await screen.findByText(/1 unsynced change from dana is held on this device/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Discard held changes' }));
    expect(screen.getByText(/Discard 1 change from dana\?/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Discard held changes' }));

    await waitFor(async () => expect(await services.db.outbox.count()).toBe(0));
    expect(await services.db.food.get('f1')).toBeUndefined();
    await waitFor(() => expect(screen.queryByText(/held on this device/)).not.toBeInTheDocument());
  });

  it('reports when the server has no USDA library', async () => {
    services = makeServices();
    services.api.on('GET', '/api/usda/manifest', () => {
      throw new ApiError(404, 'usda_not_imported', 'Run `carbbook import-usda` on the server first');
    });
    const user = userEvent.setup();
    renderWith(<Settings />, services);
    await user.click(await screen.findByRole('button', { name: 'Check for USDA update' }));
    expect(await screen.findByText('The server has no USDA library yet.')).toBeInTheDocument();
  });

  it('warns about unsynced changes before signing out', async () => {
    services = makeServices();
    await services.db.outbox.put({ key: 'food:f1', table: 'food', id: 'f1', updated_at: 1, snapshot: null, ownerId: null, ownerUsername: null });
    const user = userEvent.setup();
    renderWith(<Settings />, services);
    await screen.findByText('1 pending change');
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(screen.getByRole('alert')).toHaveTextContent('1 pending change will stay on this device');
    expect(services.signOuts).toBe(0);
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(services.signOuts).toBe(1);
  });
});

describe('carb goals in the dose settings editor', () => {
  it('prefills, carries forward and saves an edited goal on a new version', async () => {
    services = makeServices();
    await seedSettings(services.db);
    const user = userEvent.setup();
    const current = (await services.db.dose_settings.toArray())[0]!;
    await services.db.dose_settings.put({
      ...current,
      windows: current.windows.map((w) => (w.name === 'Lunch' ? { ...w, carb_goal: { min: 50, max: 80 } } : { ...w, carb_goal: null })),
    });
    renderWith(<Settings />, services);
    await user.click(await screen.findByRole('button', { name: 'Edit dose settings' }));

    expect(screen.getByLabelText('Window 3 carb goal minimum (g)')).toHaveValue('50');
    expect(screen.getByLabelText('Window 3 carb goal maximum (g)')).toHaveValue('80');

    const max = screen.getByLabelText('Window 3 carb goal maximum (g)');
    await user.clear(max);
    await user.type(max, '90');
    await user.click(screen.getByRole('button', { name: 'Save as new version' }));

    const versions = await services.db.dose_settings.toArray();
    const saved = versions.find((v) => v.id !== current.id)!;
    expect(saved.windows.find((w) => w.name === 'Lunch')!.carb_goal).toEqual({ min: 50, max: 90 });
    expect(saved.windows.find((w) => w.name === 'Breakfast')!.carb_goal).toBeNull();
  });

  it('rejects a goal whose minimum is above its maximum', async () => {
    services = makeServices();
    await seedSettings(services.db);
    const user = userEvent.setup();
    renderWith(<Settings />, services);
    await user.click(await screen.findByRole('button', { name: 'Edit dose settings' }));
    // SEED_SETTINGS mirrors the live server's deployed goals (Task 10 adaptation), so Window 3
    // (Lunch) is prefilled with an existing goal — clear it before typing the invalid one.
    const min = screen.getByLabelText('Window 3 carb goal minimum (g)');
    const max = screen.getByLabelText('Window 3 carb goal maximum (g)');
    await user.clear(min);
    await user.type(min, '90');
    await user.clear(max);
    await user.type(max, '50');
    await user.click(screen.getByRole('button', { name: 'Save as new version' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Window 3 carb goal minimum must not be above its maximum.');
  });
});
