import { describe, expect, it } from 'vitest';
import { initDatabase } from '../src/init';
import { applyPush } from '../src/sync/push';
import { food, meal } from './sync-helpers';

const SEEDED_SEQ = 1; // one seed dose_settings row

describe('applyPush last-write-wins', () => {
  it('accepts new records and assigns increasing server_seq', () => {
    const db = initDatabase(':memory:');
    const a = food({ id: 'f1' });
    const b = meal({ id: 'm1' });
    expect(applyPush(db, 'owner', [{ table: 'food', record: a }, { table: 'meal', record: b }])).toEqual([
      { table: 'food', id: 'f1', status: 'accepted', server_seq: SEEDED_SEQ + 1 },
      { table: 'meal', id: 'm1', status: 'accepted', server_seq: SEEDED_SEQ + 2 },
    ]);
    expect(db.prepare('SELECT name, server_seq FROM food WHERE id = ?').get('f1')).toEqual({ name: 'Tortilla', server_seq: 2 });
  });

  it('overwrites only with a newer updated_at, and breaks ties by higher updated_by', () => {
    const db = initDatabase(':memory:');
    applyPush(db, 'owner', [{ table: 'food', record: food({ id: 'f1', name: 'v1', updated_at: 2000, updated_by: 'laptop' }) }]);

    const older = applyPush(db, 'owner', [{ table: 'food', record: food({ id: 'f1', name: 'old', updated_at: 1999, updated_by: 'zz' }) }]);
    expect(older).toEqual([{ table: 'food', id: 'f1', status: 'ignored', server_seq: 2 }]);

    const tieLower = applyPush(db, 'owner', [{ table: 'food', record: food({ id: 'f1', name: 'tie-low', updated_at: 2000, updated_by: 'ipad' }) }]);
    expect(tieLower[0]!.status).toBe('ignored');

    const tieHigher = applyPush(db, 'owner', [{ table: 'food', record: food({ id: 'f1', name: 'tie-high', updated_at: 2000, updated_by: 'phone' }) }]);
    expect(tieHigher).toEqual([{ table: 'food', id: 'f1', status: 'accepted', server_seq: 3 }]);

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
      { table: 'food', id: 'good', status: 'accepted', server_seq: 2 },
    ]);
  });
});
