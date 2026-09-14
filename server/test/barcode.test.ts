import { describe, expect, it } from 'vitest';
import { OffUnavailableError, type OffClient } from '../src/off/client';
import { applyPush } from '../src/sync/push';
import { addUser, loginCookie, makeTestApp } from './helpers';
import { food } from './sync-helpers';

async function appWithOff(off: OffClient) {
  const t = await makeTestApp({ deps: { off } });
  await addUser(t.db, 'brett', 'owner');
  const cookie = await loginCookie(t.app, 'brett');
  const get = (code: string) => t.app.inject({ url: `/api/barcode/${code}`, headers: { cookie } });
  return { ...t, get };
}

const neverCalled: OffClient = { lookup: () => Promise.reject(new Error('OFF must not be called for known barcodes')) };

describe('GET /api/barcode/:code', () => {
  it('resolves a locally saved barcode (either UPC-A or EAN-13 spelling) without calling OFF', async () => {
    const { db, get } = await appWithOff(neverCalled);
    applyPush(db, 'owner', [
      { table: 'food', record: food({ id: 'f1', name: 'Thai peanut noodle kit', source: 'off', source_ref: '0737628064502' }) },
      { table: 'portion', record: { id: 'p1', food_id: 'f1', label: 'label serving', kind: 'serving', quantity: 1, grams: 52, updated_at: 1, updated_by: 'phone', deleted: 0 } },
      { table: 'barcode', record: { id: 'b1', code: '0737628064502', food_id: 'f1', updated_at: 1, updated_by: 'phone', deleted: 0 } },
    ]);
    const response = await get('737628064502');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'known',
      food: { id: 'f1', name: 'Thai peanut noodle kit' },
      portions: [{ id: 'p1', grams: 52 }],
    });
  });

  it('ignores deleted barcodes and returns an OFF draft', async () => {
    const off: OffClient = {
      lookup: async (code) => ({ code: `0${code}`, product_name: 'Noodle kit', brands: 'Thai Kitchen', serving_quantity: 52, nutriments: { carbohydrates_100g: 71.15 } }),
    };
    const { db, get } = await appWithOff(off);
    applyPush(db, 'owner', [
      { table: 'food', record: food({ id: 'f1' }) },
      { table: 'barcode', record: { id: 'b1', code: '737628064502', food_id: 'f1', updated_at: 1, updated_by: 'phone', deleted: 1 } },
    ]);
    const response = await get('737628064502');
    expect(response.json()).toEqual({
      status: 'draft',
      draft: {
        food: { name: 'Noodle kit', brand: 'Thai Kitchen', source: 'off', source_ref: '0737628064502', carbs_per_100g: 71.15, carbs_per_100ml: null, fiber_per_100g: null },
        portions: [{ label: 'label serving', kind: 'serving', quantity: 1, grams: 52, carbs_g: null }],
        barcode: '0737628064502',
        serving_size: null,
      },
    });
  });

  it('reports not_found and unavailable so the client can prefill manual entry', async () => {
    const missing = await appWithOff({ lookup: async () => null });
    expect((await missing.get('3017624010070')).json()).toEqual({ status: 'not_found', code: '3017624010070' });

    const down = await appWithOff({ lookup: () => Promise.reject(new OffUnavailableError('Open Food Facts responded 503')) });
    const response = await down.get('3017624010070');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'unavailable', code: '3017624010070', message: 'Open Food Facts responded 503' });
  });

  it('rejects malformed codes', async () => {
    const { get } = await appWithOff(neverCalled);
    expect((await get('abc')).statusCode).toBe(400);
    expect((await get('12345')).statusCode).toBe(400);
  });
});
