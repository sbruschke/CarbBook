import { describe, expect, it } from 'vitest';
import { initDatabase } from '../src/init';
import { pullChanges } from '../src/sync/pull';
import { applyPush } from '../src/sync/push';
import { food, meal } from './sync-helpers';

describe('pullChanges', () => {
  it('returns seeded dose settings from since=0 with JSON decoded', () => {
    const db = initDatabase(':memory:');
    const page = pullChanges(db, 0, 500);
    expect(page.has_more).toBe(false);
    expect(page.next_since).toBe(1);
    expect(page.changes.map((c) => c.table)).toEqual(['dose_settings']);
    expect(Array.isArray(page.changes[0]!.record.windows)).toBe(true);
    expect(page.changes[0]!.record.correction).toEqual({ threshold: 200, step: 50, units_per_step: 1, mode: 'started' });
  });

  it('pages across tables in server_seq order', () => {
    const db = initDatabase(':memory:');
    applyPush(db, 'owner', [
      { table: 'meal', record: meal({ id: 'm1' }) },
      { table: 'food', record: food({ id: 'f1' }) },
      { table: 'meal', record: meal({ id: 'm2' }) },
    ]);
    const first = pullChanges(db, 1, 2);
    expect(first.changes.map((c) => [c.table, c.record.id, c.record.server_seq])).toEqual([
      ['meal', 'm1', 2],
      ['food', 'f1', 3],
    ]);
    expect(first).toMatchObject({ next_since: 3, has_more: true });
    const second = pullChanges(db, first.next_since, 2);
    expect(second.changes.map((c) => c.record.id)).toEqual(['m2']);
    expect(second).toMatchObject({ next_since: 4, has_more: false });
    expect(pullChanges(db, 4, 2)).toEqual({ changes: [], next_since: 4, has_more: false });
  });

  it('includes soft-deleted records so clients learn about deletes', () => {
    const db = initDatabase(':memory:');
    applyPush(db, 'owner', [{ table: 'food', record: food({ id: 'f1', updated_at: 1 }) }]);
    applyPush(db, 'owner', [{ table: 'food', record: food({ id: 'f1', updated_at: 2, deleted: 1 }) }]);
    const page = pullChanges(db, 1, 10);
    expect(page.changes).toHaveLength(1);
    expect(page.changes[0]!.record).toMatchObject({ id: 'f1', deleted: 1, server_seq: 3 });
  });
});
