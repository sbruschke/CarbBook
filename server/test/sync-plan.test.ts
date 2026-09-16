import { describe, expect, it } from 'vitest';
import { initDatabase } from '../src/init';
import { applyPush } from '../src/sync/push';
import { planEntry, planItem } from './sync-helpers';

describe('applyPush plan_entry slot uniqueness', () => {
  it('rejects a second live entry for the same date and window', () => {
    const db = initDatabase(':memory:');
    const first = applyPush(db, 'owner', [{ table: 'plan_entry', record: planEntry({ id: 'p1' }) }]);
    expect(first[0]!.status).toBe('accepted');

    const second = applyPush(db, 'owner', [{ table: 'plan_entry', record: planEntry({ id: 'p2' }) }]);
    expect(second).toEqual([
      {
        table: 'plan_entry',
        id: 'p2',
        status: 'rejected',
        reason: 'duplicate_slot',
        message: 'Another plan entry already exists for 2026-09-17 Lunch',
      },
    ]);
    expect(db.prepare('SELECT count(*) FROM plan_entry').pluck().get()).toBe(1);
  });

  it('rejects a duplicate that arrives later in the same batch', () => {
    const db = initDatabase(':memory:');
    const results = applyPush(db, 'owner', [
      { table: 'plan_entry', record: planEntry({ id: 'p1' }) },
      { table: 'plan_entry', record: planEntry({ id: 'p2' }) },
    ]);
    expect(results.map((r) => r.status)).toEqual(['accepted', 'rejected']);
  });

  it('allows a different window, a different date, and an update of the same row', () => {
    const db = initDatabase(':memory:');
    const results = applyPush(db, 'owner', [
      { table: 'plan_entry', record: planEntry({ id: 'p1' }) },
      { table: 'plan_entry', record: planEntry({ id: 'p2', window_name: 'Dinner' }) },
      { table: 'plan_entry', record: planEntry({ id: 'p3', date: '2026-09-18' }) },
      { table: 'plan_entry', record: planEntry({ id: 'p1', status: 'skipped', updated_at: 2000 }) },
    ]);
    expect(results.map((r) => r.status)).toEqual(['accepted', 'accepted', 'accepted', 'accepted']);
    expect(db.prepare('SELECT status FROM plan_entry WHERE id = ?').pluck().get('p1')).toBe('skipped');
  });

  it('frees the slot once the first entry is soft-deleted', () => {
    const db = initDatabase(':memory:');
    applyPush(db, 'owner', [{ table: 'plan_entry', record: planEntry({ id: 'p1' }) }]);
    applyPush(db, 'owner', [{ table: 'plan_entry', record: planEntry({ id: 'p1', deleted: 1, updated_at: 2000 }) }]);
    const replacement = applyPush(db, 'owner', [{ table: 'plan_entry', record: planEntry({ id: 'p2' }) }]);
    expect(replacement[0]!.status).toBe('accepted');
  });

  it('always accepts a delete, even of a row whose slot looks taken', () => {
    const db = initDatabase(':memory:');
    applyPush(db, 'owner', [{ table: 'plan_entry', record: planEntry({ id: 'p1' }) }]);
    const deletion = applyPush(db, 'owner', [
      { table: 'plan_entry', record: planEntry({ id: 'p1', deleted: 1, updated_at: 2000 }) },
    ]);
    expect(deletion[0]!.status).toBe('accepted');
  });

  it('lets a viewer write plans (spec §4: owner and viewers both edit plans)', () => {
    const db = initDatabase(':memory:');
    const results = applyPush(db, 'viewer', [
      { table: 'plan_entry', record: planEntry({ id: 'p1' }) },
      { table: 'plan_item', record: planItem('p1', { id: 'i1' }) },
    ]);
    expect(results.map((r) => r.status)).toEqual(['accepted', 'accepted']);
  });
});
