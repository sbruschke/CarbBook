import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { StartScanner } from '../src/barcode/scanner';
import { NetworkError } from '../src/lib/api';
import { Foods } from '../src/screens/Foods';
import { foodData, synced } from './helpers';
import { makeServices, renderWith, type TestServices } from './render';

let services: TestServices;
afterEach(async () => {
  await services.db.delete();
});

const scannerThatReads =
  (code: string): StartScanner =>
  async (_video, onCode) => {
    setTimeout(() => onCode(code), 0);
    return { stop() {} };
  };

describe('Foods screen', () => {
  it('lists and filters saved foods and opens one for editing', async () => {
    services = makeServices();
    await services.db.food.bulkPut([
      synced(foodData({ id: 'bread', name: 'Bread', carbs_per_100g: 50 })),
      synced(foodData({ id: 'brie', name: 'Brie', source: 'off', brand: 'Président', carbs_per_100g: 0.5 })),
      synced(foodData({ id: 'gone', name: 'Brittle' }), { deleted: 1 }),
    ]);
    const user = userEvent.setup();
    renderWith(<Foods />, services);
    expect(await screen.findByRole('button', { name: /Bread/ })).toHaveTextContent('My food · 50 g carbs / 100 g');
    await user.type(screen.getByLabelText('Filter foods'), 'bri');
    expect(screen.queryByRole('button', { name: /Bread/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Brittle/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: /Brie/ }));
    expect(await screen.findByRole('heading', { name: 'Edit food' })).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('Brie');
  });

  it('shows the volume or portion basis the user entered for any-unit foods', async () => {
    services = makeServices();
    await services.db.food.bulkPut([
      synced(foodData({ id: 'rice', name: 'Calrose rice', carbs_per_100g: null, carbs_per_100ml: 20.2884136211058 })),
      synced(foodData({ id: 'bar', name: 'Granola bar', carbs_per_100g: null })),
    ]);
    await services.db.portion.put(synced({ id: 'bar-p', food_id: 'bar', label: 'bar', kind: 'count', quantity: 1, grams: null, carbs_g: 22 }));
    renderWith(<Foods />, services);
    expect(await screen.findByRole('button', { name: /Calrose rice/ })).toHaveTextContent('48 g carbs / cup');
    expect(await screen.findByRole('button', { name: /Granola bar/ })).toHaveTextContent('22 g carbs / bar');
  });

  it('opens a scanned Open Food Facts product as a prefilled new food', async () => {
    services = makeServices({ startScanner: scannerThatReads('0737628064502') });
    services.api.on('GET', '/api/barcode/0737628064502', () => ({
      status: 'draft',
      draft: {
        food: { name: 'Noodle kit', brand: 'Thai Kitchen', source: 'off', source_ref: '0737628064502', carbs_per_100g: 71.15, fiber_per_100g: null },
        portions: [{ label: 'label serving', kind: 'serving', quantity: 1, grams: 52 }],
        barcode: '0737628064502',
        serving_size: null,
      },
    }));
    const user = userEvent.setup();
    renderWith(<Foods />, services);
    await user.click(await screen.findByRole('button', { name: 'Scan barcode' }));
    expect(await screen.findByRole('heading', { name: 'New food' })).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('Noodle kit');
    expect(screen.getByLabelText('Carbs per 100 g')).toHaveValue('71.15');
    expect(screen.getByText('0737628064502')).toBeInTheDocument();
  });

  it('opens the saved food when a known barcode is scanned, without calling the server', async () => {
    services = makeServices({ startScanner: scannerThatReads('737628064502') });
    await services.db.food.put(synced(foodData({ id: 'noodles', name: 'Noodle kit', source: 'off' })));
    await services.db.barcode.put(synced({ id: 'b1', code: '0737628064502', food_id: 'noodles' }));
    const user = userEvent.setup();
    renderWith(<Foods />, services);
    await user.click(await screen.findByRole('button', { name: 'Scan barcode' }));
    expect(await screen.findByRole('heading', { name: 'Edit food' })).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('Noodle kit');
    expect(services.api.calls).toEqual([]);
  });

  it('keeps a barcode scanned offline and falls back to manual entry when looked up later', async () => {
    services = makeServices({ startScanner: scannerThatReads('3017624010070') });
    services.api.on('GET', '/api/barcode/3017624010070', () => {
      throw new NetworkError('Failed to fetch');
    });
    const user = userEvent.setup();
    renderWith(<Foods />, services);
    await user.click(await screen.findByRole('button', { name: 'Scan barcode' }));
    expect(await screen.findByRole('status')).toHaveTextContent("No connection. Barcode 3017624010070 is saved to look up when you're back online.");
    expect(await screen.findByRole('region', { name: 'Barcodes to look up' })).toHaveTextContent('3017624010070');

    services.api.on('GET', '/api/barcode/3017624010070', () => ({ status: 'unavailable', code: '3017624010070', message: 'Open Food Facts responded 503' }));
    await user.click(screen.getByRole('button', { name: 'Look up' }));
    expect(await screen.findByRole('heading', { name: 'New food' })).toBeInTheDocument();
    expect(screen.getByText('Open Food Facts is unavailable (Open Food Facts responded 503). Enter the food from its label.')).toBeInTheDocument();
    expect(screen.getByText('3017624010070')).toBeInTheDocument();
    // resolveBarcode re-queues on 'unavailable' too (current data layer), so a background retry
    // can still pick it up even though manual entry is offered right away.
    expect(await services.db.pending_barcode.count()).toBe(1);
  });
});
