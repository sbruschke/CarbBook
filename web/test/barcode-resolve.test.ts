import { afterEach, describe, expect, it } from 'vitest';
import { barcodeCandidates, resolveBarcode } from '../src/barcode/resolve';
import type { CarbBookDb } from '../src/db/db';
import { ApiError, NetworkError } from '../src/lib/api';
import { FakeApi, foodData, openTestDb, portionData, synced } from './helpers';

const noServer = () => new FakeApi();

let db: CarbBookDb | undefined;
afterEach(async () => {
  await db?.delete();
  db = undefined;
});

describe('barcodeCandidates', () => {
  it('matches UPC-A and EAN-13 spellings', () => {
    expect(barcodeCandidates('737628064502')).toEqual(['737628064502', '0737628064502']);
    expect(barcodeCandidates('0737628064502')).toEqual(['0737628064502', '737628064502']);
  });
});

describe('resolveBarcode', () => {
  it('finds a saved barcode locally without calling the server', async () => {
    db = openTestDb();
    await db.food.put(synced(foodData({ id: 'f1', name: 'Noodle kit' })));
    await db.barcode.bulkPut([
      synced({ id: 'b0', code: '737628064502', food_id: 'f1' }, { deleted: 1 }),
      synced({ id: 'b1', code: '0737628064502', food_id: 'f1' }),
    ]);
    const api = noServer();
    expect(await resolveBarcode(db, api, '737628064502')).toMatchObject({ kind: 'local', food: { id: 'f1' } });
    expect(api.calls).toEqual([]);
  });

  it('saves a food the server already knows', async () => {
    db = openTestDb();
    const food = synced(foodData({ id: 'f9', name: 'Noodle kit', source: 'off' }), { server_seq: 12 });
    const portion = synced(portionData({ id: 'p9', food_id: 'f9', label: 'label serving', kind: 'serving', grams: 52 }), { server_seq: 13 });
    const api = new FakeApi().on('GET', '/api/barcode/0737628064502', () => ({ status: 'known', food, portions: [portion] }));
    expect(await resolveBarcode(db, api, '0737628064502')).toEqual({ kind: 'known', food, portions: [portion] });
    expect(await db.food.get('f9')).toEqual(food);
    expect(await db.portion.get('p9')).toEqual(portion);
  });

  it('returns Open Food Facts drafts', async () => {
    db = openTestDb();
    const draft = {
      food: { name: 'Noodle kit', brand: 'Thai Kitchen', source: 'off', source_ref: '0737628064502', carbs_per_100g: 71.15, fiber_per_100g: null },
      portions: [{ label: 'label serving', kind: 'serving', quantity: 1, grams: 52 }],
      barcode: '0737628064502',
      serving_size: null,
    };
    const api = new FakeApi().on('GET', '/api/barcode/737628064502', () => ({ status: 'draft', draft }));
    expect(await resolveBarcode(db, api, '737628064502')).toEqual({ kind: 'draft', draft });
  });

  it('falls back to manual entry when the product is unknown or OFF is down', async () => {
    db = openTestDb();
    const api = new FakeApi().on('GET', '/api/barcode/3017624010070', () => ({ status: 'not_found', code: '3017624010070' }));
    expect(await resolveBarcode(db, api, '3017624010070')).toEqual({
      kind: 'manual',
      code: '3017624010070',
      message: 'No product found for barcode 3017624010070. Enter the food from its label.',
    });
    api.on('GET', '/api/barcode/3017624010070', () => ({ status: 'unavailable', code: '3017624010070', message: 'Open Food Facts responded 503' }));
    expect(await resolveBarcode(db, api, '3017624010070')).toEqual({
      kind: 'manual',
      code: '3017624010070',
      message: 'Open Food Facts is unavailable (Open Food Facts responded 503). Enter the food from its label.',
    });
  });

  it('queues unknown codes while offline and clears them once resolved', async () => {
    db = openTestDb();
    const api = new FakeApi().on('GET', '/api/barcode/3017624010070', () => {
      throw new NetworkError('Failed to fetch');
    });
    expect(await resolveBarcode(db, api, '3017624010070', () => 42)).toEqual({ kind: 'queued', code: '3017624010070' });
    expect(await db.pending_barcode.toArray()).toEqual([{ code: '3017624010070', created_at: 42 }]);
    api.on('GET', '/api/barcode/3017624010070', () => ({ status: 'not_found', code: '3017624010070' }));
    await resolveBarcode(db, api, '3017624010070');
    expect(await db.pending_barcode.count()).toBe(0);
  });

  it('queues the code for retry when the server returns 5xx (e.g. Cloudflare down)', async () => {
    db = openTestDb();
    const api = new FakeApi().on('GET', '/api/barcode/3017624010070', () => {
      throw new ApiError(502, 'http_error', 'HTTP 502');
    });
    expect(await resolveBarcode(db, api, '3017624010070', () => 42)).toEqual({ kind: 'queued', code: '3017624010070' });
    expect(await db.pending_barcode.toArray()).toEqual([{ code: '3017624010070', created_at: 42 }]);
  });

  it('still rethrows non-5xx ApiErrors instead of queueing', async () => {
    db = openTestDb();
    const api = new FakeApi().on('GET', '/api/barcode/3017624010070', () => {
      throw new ApiError(400, 'bad_request', 'nope');
    });
    await expect(resolveBarcode(db, api, '3017624010070')).rejects.toBeInstanceOf(ApiError);
    expect(await db.pending_barcode.count()).toBe(0);
  });

  it('also queues for retry when Open Food Facts itself is unavailable', async () => {
    db = openTestDb();
    const api = new FakeApi().on('GET', '/api/barcode/3017624010070', () => ({
      status: 'unavailable',
      code: '3017624010070',
      message: 'Open Food Facts responded 503',
    }));
    expect(await resolveBarcode(db, api, '3017624010070', () => 42)).toEqual({
      kind: 'manual',
      code: '3017624010070',
      message: 'Open Food Facts is unavailable (Open Food Facts responded 503). Enter the food from its label.',
    });
    expect(await db.pending_barcode.toArray()).toEqual([{ code: '3017624010070', created_at: 42 }]);
  });

  it('rejects malformed codes before any lookup or queueing', async () => {
    db = openTestDb();
    const api = noServer();
    expect(await resolveBarcode(db, api, 'abc')).toEqual({
      kind: 'invalid',
      code: 'abc',
      message: 'Not a valid barcode.',
    });
    expect(api.calls).toEqual([]);
    expect(await db.pending_barcode.count()).toBe(0);
  });
});
