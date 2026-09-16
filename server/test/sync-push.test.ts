import { describe, expect, it } from 'vitest';
import { initDatabase } from '../src/init';
import { applyPush } from '../src/sync/push';
import { doseSettings, food, meal, portion } from './sync-helpers';

const SEEDED_SEQ = 2; // two seed dose_settings rows

describe('applyPush last-write-wins', () => {
  it('accepts new records and assigns increasing server_seq', () => {
    const db = initDatabase(':memory:');
    const a = food({ id: 'f1' });
    const b = meal({ id: 'm1' });
    expect(applyPush(db, 'owner', [{ table: 'food', record: a }, { table: 'meal', record: b }])).toEqual([
      { table: 'food', id: 'f1', status: 'accepted', server_seq: SEEDED_SEQ + 1 },
      { table: 'meal', id: 'm1', status: 'accepted', server_seq: SEEDED_SEQ + 2 },
    ]);
    expect(db.prepare('SELECT name, server_seq FROM food WHERE id = ?').get('f1')).toEqual({ name: 'Tortilla', server_seq: 3 });
  });

  it('overwrites only with a newer updated_at, and breaks ties by higher updated_by', () => {
    const db = initDatabase(':memory:');
    applyPush(db, 'owner', [{ table: 'food', record: food({ id: 'f1', name: 'v1', updated_at: 2000, updated_by: 'laptop' }) }]);

    const older = applyPush(db, 'owner', [{ table: 'food', record: food({ id: 'f1', name: 'old', updated_at: 1999, updated_by: 'zz' }) }]);
    expect(older).toEqual([{ table: 'food', id: 'f1', status: 'ignored', server_seq: 3 }]);

    const tieLower = applyPush(db, 'owner', [{ table: 'food', record: food({ id: 'f1', name: 'tie-low', updated_at: 2000, updated_by: 'ipad' }) }]);
    expect(tieLower[0]!.status).toBe('ignored');

    const tieHigher = applyPush(db, 'owner', [{ table: 'food', record: food({ id: 'f1', name: 'tie-high', updated_at: 2000, updated_by: 'phone' }) }]);
    expect(tieHigher).toEqual([{ table: 'food', id: 'f1', status: 'accepted', server_seq: 4 }]);

    const newer = applyPush(db, 'owner', [{ table: 'food', record: food({ id: 'f1', name: 'v2', updated_at: 2001, updated_by: 'aaa' }) }]);
    expect(newer[0]!.status).toBe('accepted');
    expect(db.prepare('SELECT name FROM food WHERE id = ?').pluck().get('f1')).toBe('v2');
  });

  it('keeps soft deletes as rows', () => {
    const db = initDatabase(':memory:');
    applyPush(db, 'owner', [{ table: 'food', record: food({ id: 'f1', updated_at: 1 }) }]);
    applyPush(db, 'owner', [{ table: 'food', record: food({ id: 'f1', updated_at: 2, deleted: 1 }) }]);
    expect(db.prepare('SELECT deleted FROM food WHERE id = ?').pluck().get('f1')).toBe(1);
  });

  it('reports unknown tables and invalid records per record without blocking the rest', () => {
    const db = initDatabase(':memory:');
    const results = applyPush(db, 'owner', [
      { table: 'user', record: { id: 'u1' } },
      { table: 'food', record: { ...food({ id: 'bad' }), source: 'mystery' } },
      { table: 'food', record: food({ id: 'good' }) },
    ]);
    expect(results).toEqual([
      { table: 'user', id: 'u1', status: 'rejected', reason: 'unknown_table', message: 'Unknown table "user"' },
      { table: 'food', id: 'bad', status: 'rejected', reason: 'invalid', message: 'source must be one of usda, off, custom' },
      { table: 'food', id: 'good', status: 'accepted', server_seq: 3 },
    ]);
  });
});

describe('applyPush: missing keys keep stored values (old clients)', () => {
  const foodRow = (db: ReturnType<typeof initDatabase>, id: string) =>
    db.prepare('SELECT * FROM food WHERE id = ?').get(id) as Record<string, unknown>;
  const portionRow = (db: ReturnType<typeof initDatabase>, id: string) =>
    db.prepare('SELECT * FROM portion WHERE id = ?').get(id) as Record<string, unknown>;
  /** A portion as a pre-addendum client sends it: no carbs_g key at all. */
  const oldShapePortion = (foodId: string, fields: Parameters<typeof portion>[1]) => {
    const { carbs_g: _omit, ...rest } = portion(foodId, fields);
    return rest;
  };

  it('an old-shape food update (no carbs_per_100ml key) keeps the stored carbs_per_100ml', () => {
    const db = initDatabase(':memory:');
    applyPush(db, 'owner', [{ table: 'food', record: { ...food({ id: 'f1', updated_at: 1000 }), carbs_per_100g: null, carbs_per_100ml: 20.5 } }]);
    const oldShape = food({ id: 'f1', name: 'Renamed', carbs_per_100g: null, updated_at: 2000 });
    expect('carbs_per_100ml' in oldShape).toBe(false);
    expect(applyPush(db, 'owner', [{ table: 'food', record: oldShape }])[0]!.status).toBe('accepted');
    expect(foodRow(db, 'f1')).toMatchObject({ name: 'Renamed', carbs_per_100ml: 20.5, updated_at: 2000 });
  });

  it('an explicit null clears carbs_per_100ml', () => {
    const db = initDatabase(':memory:');
    applyPush(db, 'owner', [{ table: 'food', record: { ...food({ id: 'f1', updated_at: 1000 }), carbs_per_100ml: 20.5 } }]);
    applyPush(db, 'owner', [{ table: 'food', record: { ...food({ id: 'f1', updated_at: 2000 }), carbs_per_100ml: null } }]);
    expect(foodRow(db, 'f1').carbs_per_100ml).toBeNull();
  });

  it('a missing key on insert defaults to null, and a missing required key on insert is still rejected', () => {
    const db = initDatabase(':memory:');
    expect(applyPush(db, 'owner', [{ table: 'food', record: food({ id: 'f1' }) }])[0]!.status).toBe('accepted');
    expect(foodRow(db, 'f1').carbs_per_100ml).toBeNull();
    const { name: _omit, ...noName } = food({ id: 'f2' });
    expect(applyPush(db, 'owner', [{ table: 'food', record: noName }])[0]).toMatchObject({ status: 'rejected', message: 'name is required' });
  });

  it('a missing required key on update keeps the stored value', () => {
    const db = initDatabase(':memory:');
    applyPush(db, 'owner', [{ table: 'food', record: food({ id: 'f1', name: 'Kept', updated_at: 1000 }) }]);
    const { name: _omit, ...noName } = food({ id: 'f1', carbs_per_100g: 12, updated_at: 2000 });
    expect(applyPush(db, 'owner', [{ table: 'food', record: noName }])[0]!.status).toBe('accepted');
    expect(foodRow(db, 'f1')).toMatchObject({ name: 'Kept', carbs_per_100g: 12 });
  });

  it('an old-shape portion update (no carbs_g key) keeps the stored carbs_g', () => {
    const db = initDatabase(':memory:');
    applyPush(db, 'owner', [{ table: 'portion', record: portion('f1', { id: 'p1', label: 'bar', grams: 40, carbs_g: 22, updated_at: 1000 }) }]);
    const oldShape = oldShapePortion('f1', { id: 'p1', label: 'granola bar', grams: 40, updated_at: 2000 });
    expect(applyPush(db, 'owner', [{ table: 'portion', record: oldShape }])[0]!.status).toBe('accepted');
    expect(portionRow(db, 'p1')).toMatchObject({ label: 'granola bar', grams: 40, carbs_g: 22 });
  });

  it('runs cross-field validation on the merged record', () => {
    const db = initDatabase(':memory:');
    applyPush(db, 'owner', [{ table: 'portion', record: portion('f1', { id: 'p1', label: 'bar', grams: null, carbs_g: 22, updated_at: 1000 }) }]);
    // grams null + missing carbs_g: valid only because the stored carbs_g is kept.
    const merged = oldShapePortion('f1', { id: 'p1', label: 'bar', grams: null, updated_at: 2000 });
    expect(applyPush(db, 'owner', [{ table: 'portion', record: merged }])[0]!.status).toBe('accepted');
    expect(portionRow(db, 'p1')).toMatchObject({ grams: null, carbs_g: 22, updated_at: 2000 });
    // Turning it into a volume portion without mentioning carbs_g: the kept carbs_g makes it invalid.
    const toVolume = oldShapePortion('f1', { id: 'p1', label: 'cup', kind: 'volume', grams: 158, updated_at: 3000 });
    expect(applyPush(db, 'owner', [{ table: 'portion', record: toVolume }])[0]).toMatchObject({
      status: 'rejected', reason: 'invalid', message: 'volume portions cannot have carbs_g',
    });
    // An explicit null that leaves neither grams nor carbs_g is rejected.
    const cleared = portion('f1', { id: 'p1', label: 'bar', grams: null, carbs_g: null, updated_at: 3000 });
    expect(applyPush(db, 'owner', [{ table: 'portion', record: cleared }])[0]).toMatchObject({
      status: 'rejected', message: 'portion must have grams or carbs_g',
    });
    expect(portionRow(db, 'p1')).toMatchObject({ kind: 'count', grams: null, carbs_g: 22, updated_at: 2000 });
  });

  it('keeps LWW and idempotency with merged records: stale and replayed old-shape pushes are ignored', () => {
    const db = initDatabase(':memory:');
    applyPush(db, 'owner', [{ table: 'food', record: { ...food({ id: 'f1', name: 'v2', updated_at: 2000 }), carbs_per_100ml: 30 } }]);
    const stale = food({ id: 'f1', name: 'old', updated_at: 1000 });
    expect(applyPush(db, 'owner', [{ table: 'food', record: stale }])[0]).toEqual({ table: 'food', id: 'f1', status: 'ignored', server_seq: 3 });
    const newer = food({ id: 'f1', name: 'v3', updated_at: 3000 });
    expect(applyPush(db, 'owner', [{ table: 'food', record: newer }])[0]!.status).toBe('accepted');
    expect(applyPush(db, 'owner', [{ table: 'food', record: newer }])[0]).toEqual({ table: 'food', id: 'f1', status: 'ignored', server_seq: 4 });
    expect(foodRow(db, 'f1')).toMatchObject({ name: 'v3', carbs_per_100ml: 30, server_seq: 4 });
  });

  it('keeps dose_settings append-only with merged records', () => {
    const db = initDatabase(':memory:');
    const created = doseSettings({ id: 'd1' });
    applyPush(db, 'owner', [{ table: 'dose_settings', record: created }]);
    const { rounding: _omit, ...noRounding } = created;
    // Omitted field + identical content: a metadata republish, not an edit.
    expect(applyPush(db, 'owner', [{ table: 'dose_settings', record: { ...noRounding, updated_at: 2000 } }])[0]!.status).toBe('accepted');
    // Omitted field + a changed field: still an edit.
    const edit = { ...noRounding, updated_at: 3000, correction: { ...created.correction, threshold: 999 } };
    expect(applyPush(db, 'owner', [{ table: 'dose_settings', record: edit }])[0]).toMatchObject({ status: 'rejected', reason: 'append_only' });
  });
});
