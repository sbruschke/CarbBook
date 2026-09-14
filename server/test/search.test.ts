import { describe, expect, it } from 'vitest';
import { initDatabase } from '../src/init';
import { search, toFtsQuery } from '../src/search/search';
import { applyPush } from '../src/sync/push';
import { importUsda } from '../src/usda/import';
import { USDA_FIXTURES } from './fixtures';
import { addUser, loginCookie, makeTestApp } from './helpers';
import { food, meal } from './sync-helpers';

const logEntry = (id: string, eatenAt: number) => ({
  id, eaten_at: eatenAt, window_name: 'Lunch', bg_mgdl: null, bg_source: 'none', bg_trend: null, total_carbs_g: 20,
  suggested_units: null, taken_units: null, settings_version_id: null, notes: null, updated_at: 1, updated_by: 'phone', deleted: 0,
});
const logItem = (id: string, entryId: string, refId: string) => ({
  id, log_entry_id: entryId, ref_type: 'food', ref_id: refId, display_name: 'x', amount: 1, unit: 'g', carbs_g: 1,
  updated_at: 1, updated_by: 'phone', deleted: 0,
});

async function seededDb() {
  const db = initDatabase(':memory:');
  await importUsda(db, USDA_FIXTURES);
  applyPush(db, 'owner', [
    { table: 'food', record: food({ id: 'off-old', name: 'Peanut butter crunchy', source: 'off', brand: 'Jif' }) },
    { table: 'food', record: food({ id: 'off-recent', name: 'Peanut butter cups', source: 'off', brand: "Reese's" }) },
    { table: 'food', record: food({ id: 'custom-pb', name: 'Peanut butter cookies', source: 'custom' }) },
    { table: 'meal', record: meal({ id: 'meal-pb', name: 'PB toast with peanut butter' }) },
    { table: 'food', record: food({ id: 'gone', name: 'Peanut brittle', source: 'custom', deleted: 1 }) },
    { table: 'food', record: food({ id: 'creme', name: 'Crème fraîche', source: 'custom' }) },
    { table: 'log_entry', record: logEntry('e1', 5000) },
    { table: 'log_item', record: logItem('i1', 'e1', 'off-recent') },
  ]);
  return db;
}

describe('toFtsQuery', () => {
  it('builds prefix queries and ignores punctuation', () => {
    expect(toFtsQuery('Peanut  but')).toBe('"peanut"* "but"*');
    expect(toFtsQuery(`"); DROP TABLE food; --`)).toBe('"drop"* "table"* "food"*');
    expect(toFtsQuery('  !! ')).toBeNull();
  });
});

describe('search', () => {
  it('ranks meals + custom foods, then recently logged saved foods, then other saved foods, then USDA', async () => {
    const db = await seededDb();
    const hits = search(db, 'peanut butter', 20);
    expect(hits).toHaveLength(5);
    expect(new Set(hits.slice(0, 2).map((h) => h.id))).toEqual(new Set(['meal-pb', 'custom-pb']));
    expect(hits.slice(2).map((h) => h.id)).toEqual(['off-recent', 'off-old', 'usda:324860']);
    expect(hits[4]).toEqual({ kind: 'usda', id: 'usda:324860', name: 'Peanut butter, smooth style, with salt', brand: null, source: 'usda', carbs_per_100g: 22.3 });
    expect(hits.find((h) => h.id === 'off-old')).toMatchObject({ kind: 'food', brand: 'Jif', source: 'off' });
  });

  it('excludes deleted records, matches prefixes and ignores diacritics', async () => {
    const db = await seededDb();
    expect(search(db, 'brittle', 10)).toEqual([]);
    expect(search(db, 'creme fra', 10).map((h) => h.id)).toEqual(['creme']);
    expect(search(db, 'nugg', 10).map((h) => h.id)).toEqual(['usda:2706093']);
  });

  it('reflects renames and deletes pushed later', async () => {
    const db = await seededDb();
    applyPush(db, 'owner', [{ table: 'food', record: food({ id: 'custom-pb', name: 'Oatmeal cookies', source: 'custom', updated_at: 2000 }) }]);
    expect(search(db, 'oatmeal', 10).map((h) => h.id)).toEqual(['custom-pb']);
    expect(search(db, 'peanut', 10).map((h) => h.id)).not.toContain('custom-pb');
  });

  it('honours the limit across tiers', async () => {
    const db = await seededDb();
    expect(search(db, 'peanut', 3)).toHaveLength(3);
  });
});

describe('GET /api/search', () => {
  it('returns results for an authenticated user and validates q', async () => {
    const { app, db } = await makeTestApp();
    await importUsda(db, USDA_FIXTURES);
    await addUser(db, 'kim', 'viewer');
    const cookie = await loginCookie(app, 'kim');
    const response = await app.inject({ url: '/api/search?q=kale', headers: { cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json().results.map((h: { id: string }) => h.id)).toEqual(['usda:323505']);
    expect((await app.inject({ url: '/api/search', headers: { cookie } })).statusCode).toBe(400);
  });
});
