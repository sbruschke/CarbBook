import { describe, expect, it } from 'vitest';
import { currentServerSeq } from '../src/db';
import { initDatabase } from '../src/init';
import { applyPush } from '../src/sync/push';
import { pullChanges } from '../src/sync/pull';
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

  it('rejects a near-duplicate window name that differs only in case', () => {
    const db = initDatabase(':memory:');
    const first = applyPush(db, 'owner', [
      { table: 'plan_entry', record: planEntry({ id: 'p1', window_name: 'Lunch' }) },
    ]);
    expect(first[0]!.status).toBe('accepted');

    const second = applyPush(db, 'owner', [
      { table: 'plan_entry', record: planEntry({ id: 'p2', window_name: 'lunch' }) },
    ]);
    expect(second).toEqual([
      {
        table: 'plan_entry',
        id: 'p2',
        status: 'rejected',
        reason: 'duplicate_slot',
        message: 'Another plan entry already exists for 2026-09-17 lunch',
      },
    ]);
    expect(db.prepare('SELECT count(*) FROM plan_entry').pluck().get()).toBe(1);
  });

  it('stores window_name trimmed of surrounding whitespace', () => {
    const db = initDatabase(':memory:');
    applyPush(db, 'owner', [{ table: 'plan_entry', record: planEntry({ id: 'p1', window_name: 'Lunch ' }) }]);
    expect(db.prepare('SELECT window_name FROM plan_entry WHERE id = ?').pluck().get('p1')).toBe('Lunch');
  });

  it('rejects same-batch window-name-case variants for the same slot', () => {
    const db = initDatabase(':memory:');
    const results = applyPush(db, 'owner', [
      { table: 'plan_entry', record: planEntry({ id: 'p1', window_name: 'Lunch' }) },
      { table: 'plan_entry', record: planEntry({ id: 'p2', window_name: 'LUNCH' }) },
    ]);
    expect(results.map((r) => r.status)).toEqual(['accepted', 'rejected']);
  });

  it('still rejects undeleting into a slot already taken by a differently-cased window name', () => {
    const db = initDatabase(':memory:');
    applyPush(db, 'owner', [{ table: 'plan_entry', record: planEntry({ id: 'p1', window_name: 'Lunch' }) }]);
    applyPush(db, 'owner', [
      { table: 'plan_entry', record: planEntry({ id: 'p2', window_name: 'lunch', deleted: 1, updated_at: 500 }) },
    ]);
    const undelete = applyPush(db, 'owner', [
      { table: 'plan_entry', record: planEntry({ id: 'p2', window_name: 'lunch', deleted: 0, updated_at: 2000 }) },
    ]);
    expect(undelete[0]!.status).toBe('rejected');
    expect((undelete[0] as { reason: string }).reason).toBe('duplicate_slot');
  });
});

const logEntry = (id: string, fields: Record<string, unknown> = {}) => ({
  id,
  eaten_at: Date.parse('2026-09-17T17:00:00Z'),
  window_name: 'Lunch',
  bg_mgdl: null,
  bg_source: 'none',
  bg_trend: null,
  total_carbs_g: 60,
  suggested_units: null,
  taken_units: null,
  settings_version_id: null,
  notes: null,
  updated_at: 1000,
  updated_by: 'phone',
  deleted: 0,
  ...fields,
});

describe('applyPush plan_entry log_entry_id', () => {
  it('accepts a slot whose log_entry_id points at a known log entry', () => {
    const db = initDatabase(':memory:');
    const results = applyPush(db, 'owner', [
      { table: 'log_entry', record: logEntry('l1') },
      { table: 'plan_entry', record: planEntry({ id: 'p1', status: 'logged', log_entry_id: 'l1' }) },
    ]);
    expect(results.map((r) => r.status)).toEqual(['accepted', 'accepted']);
  });

  it('rejects a slot whose log_entry_id is unknown', () => {
    const db = initDatabase(':memory:');
    const results = applyPush(db, 'owner', [
      { table: 'plan_entry', record: planEntry({ id: 'p1', status: 'logged', log_entry_id: 'nope' }) },
    ]);
    expect(results).toEqual([
      {
        table: 'plan_entry',
        id: 'p1',
        status: 'rejected',
        reason: 'invalid',
        message: 'log_entry_id "nope" does not reference a known log entry',
      },
    ]);
    expect(db.prepare('SELECT count(*) FROM plan_entry').pluck().get()).toBe(0);
  });

  it('accepts a null log_entry_id', () => {
    const db = initDatabase(':memory:');
    expect(applyPush(db, 'owner', [{ table: 'plan_entry', record: planEntry({ id: 'p1' }) }])[0]!.status).toBe('accepted');
  });

  it('rejects a link to a log entry that is already soft-deleted', () => {
    const db = initDatabase(':memory:');
    applyPush(db, 'owner', [{ table: 'log_entry', record: logEntry('l1', { deleted: 1 }) }]);
    // The row exists but is soft-deleted; a re-pushed delete is never seen by the Task 13 revert
    // rule (LWW ignores it), so the reference check itself must exclude deleted rows.
    const results = applyPush(db, 'owner', [
      { table: 'plan_entry', record: planEntry({ id: 'p1', status: 'logged', log_entry_id: 'l1' }) },
    ]);
    expect(results).toEqual([
      {
        table: 'plan_entry',
        id: 'p1',
        status: 'rejected',
        reason: 'invalid',
        message: 'log_entry_id "l1" does not reference a known log entry',
      },
    ]);
    expect(db.prepare('SELECT count(*) FROM plan_entry').pluck().get()).toBe(0);
  });

  it('rejects an offline device pushing a logged slot after another device deleted the log entry', () => {
    const db = initDatabase(':memory:');
    // Device A creates log l1 (and, in reality, a plan entry referencing it) before going offline.
    applyPush(db, 'owner', [{ table: 'log_entry', record: logEntry('l1', { updated_by: 'phone' }) }]);
    // Device B deletes l1 while device A is offline.
    applyPush(db, 'owner', [
      { table: 'log_entry', record: logEntry('l1', { deleted: 1, updated_at: 2000, updated_by: 'laptop' }) },
    ]);
    // Device A comes back online and pushes p1, still claiming the now-deleted log entry.
    const results = applyPush(db, 'owner', [
      { table: 'plan_entry', record: planEntry({ id: 'p1', status: 'logged', log_entry_id: 'l1', updated_by: 'phone' }) },
    ]);
    expect(results).toEqual([
      {
        table: 'plan_entry',
        id: 'p1',
        status: 'rejected',
        reason: 'invalid',
        message: 'log_entry_id "l1" does not reference a known log entry',
      },
    ]);
    expect(db.prepare('SELECT count(*) FROM plan_entry').pluck().get()).toBe(0);
  });
});

describe('deleting a log entry returns its plan slot to planned', () => {
  function plannedAndLogged() {
    const db = initDatabase(':memory:');
    applyPush(db, 'owner', [
      { table: 'log_entry', record: logEntry('l1') },
      { table: 'plan_entry', record: planEntry({ id: 'p1', status: 'logged', log_entry_id: 'l1', updated_at: 1500 }) },
    ]);
    return db;
  }

  it('clears the link and the logged status when the log entry is soft-deleted', () => {
    const db = plannedAndLogged();
    const before = db.prepare('SELECT server_seq FROM plan_entry WHERE id = ?').pluck().get('p1') as number;

    applyPush(db, 'owner', [{ table: 'log_entry', record: logEntry('l1', { deleted: 1, updated_at: 3000, updated_by: 'laptop' }) }]);

    const after = db.prepare('SELECT * FROM plan_entry WHERE id = ?').get('p1') as Record<string, unknown>;
    expect(after).toMatchObject({ status: 'planned', log_entry_id: null, deleted: 0, updated_by: 'laptop' });
    expect(after.server_seq as number).toBeGreaterThan(before);
    expect(after.updated_at as number).toBeGreaterThan(1500);
  });

  it('makes the reverted slot visible to a pulling client', () => {
    const db = plannedAndLogged();
    const since = currentServerSeq(db);
    applyPush(db, 'owner', [{ table: 'log_entry', record: logEntry('l1', { deleted: 1, updated_at: 3000 }) }]);
    const page = pullChanges(db, since, 50);
    const planChange = page.changes.find((c) => c.table === 'plan_entry');
    expect(planChange?.record).toMatchObject({ id: 'p1', status: 'planned', log_entry_id: null });
  });

  it('reverts every slot pointing at the deleted entry and leaves other slots alone', () => {
    const db = initDatabase(':memory:');
    applyPush(db, 'owner', [
      { table: 'log_entry', record: logEntry('l1') },
      { table: 'log_entry', record: logEntry('l2') },
      { table: 'plan_entry', record: planEntry({ id: 'p1', status: 'logged', log_entry_id: 'l1' }) },
      { table: 'plan_entry', record: planEntry({ id: 'p2', window_name: 'Dinner', status: 'logged', log_entry_id: 'l2' }) },
      { table: 'plan_entry', record: planEntry({ id: 'p3', date: '2026-09-18', status: 'skipped' }) },
    ]);

    applyPush(db, 'owner', [{ table: 'log_entry', record: logEntry('l1', { deleted: 1, updated_at: 3000 }) }]);

    const rows = db.prepare('SELECT id, status, log_entry_id FROM plan_entry ORDER BY id').all();
    expect(rows).toEqual([
      { id: 'p1', status: 'planned', log_entry_id: null },
      { id: 'p2', status: 'logged', log_entry_id: 'l2' },
      { id: 'p3', status: 'skipped', log_entry_id: null },
    ]);
  });

  it('does nothing when the log entry is merely updated', () => {
    const db = plannedAndLogged();
    applyPush(db, 'owner', [{ table: 'log_entry', record: logEntry('l1', { total_carbs_g: 70, updated_at: 3000 }) }]);
    expect(db.prepare('SELECT status, log_entry_id FROM plan_entry WHERE id = ?').get('p1')).toEqual({
      status: 'logged',
      log_entry_id: 'l1',
    });
  });

  it('does nothing when a stale delete is ignored by last-write-wins', () => {
    const db = plannedAndLogged();
    applyPush(db, 'owner', [{ table: 'log_entry', record: logEntry('l1', { total_carbs_g: 70, updated_at: 5000 }) }]);
    const stale = applyPush(db, 'owner', [{ table: 'log_entry', record: logEntry('l1', { deleted: 1, updated_at: 4000 }) }]);
    expect(stale[0]!.status).toBe('ignored');
    expect(db.prepare('SELECT status FROM plan_entry WHERE id = ?').pluck().get('p1')).toBe('logged');
  });

  it('leaves a soft-deleted plan entry alone', () => {
    const db = plannedAndLogged();
    applyPush(db, 'owner', [
      { table: 'plan_entry', record: planEntry({ id: 'p1', status: 'logged', log_entry_id: 'l1', deleted: 1, updated_at: 2000 }) },
    ]);
    applyPush(db, 'owner', [{ table: 'log_entry', record: logEntry('l1', { deleted: 1, updated_at: 3000 }) }]);
    expect(db.prepare('SELECT status, deleted FROM plan_entry WHERE id = ?').get('p1')).toEqual({
      status: 'logged',
      deleted: 1,
    });
  });
});

describe('plan push/pull round trip', () => {
  it('returns a pushed plan entry and its items in server_seq order', () => {
    const db = initDatabase(':memory:');
    const since = currentServerSeq(db);
    const results = applyPush(db, 'owner', [
      { table: 'plan_entry', record: planEntry({ id: 'p1', note: 'prep the night before' }) },
      { table: 'plan_item', record: planItem('p1', { id: 'i1', ref_id: 'rice', unit: 'g', amount: 150, position: 0 }) },
      { table: 'plan_item', record: planItem('p1', { id: 'i2', ref_type: 'meal', ref_id: 'm1', unit: 'serving', amount: 1, position: 1 }) },
    ]);
    expect(results.map((r) => r.status)).toEqual(['accepted', 'accepted', 'accepted']);

    const page = pullChanges(db, since, 50);
    expect(page.changes.map((c) => [c.table, c.record.id])).toEqual([
      ['plan_entry', 'p1'],
      ['plan_item', 'i1'],
      ['plan_item', 'i2'],
    ]);
    expect(page.changes[0]!.record).toMatchObject({
      date: '2026-09-17',
      window_name: 'Lunch',
      status: 'planned',
      note: 'prep the night before',
      log_entry_id: null,
      deleted: 0,
    });
    expect(page.changes[2]!.record).toMatchObject({
      plan_entry_id: 'p1',
      ref_type: 'meal',
      ref_id: 'm1',
      amount: 1,
      unit: 'serving',
      position: 1,
    });
    expect(page.has_more).toBe(false);
  });

  it('propagates a skip and a soft-deleted item', () => {
    const db = initDatabase(':memory:');
    applyPush(db, 'owner', [
      { table: 'plan_entry', record: planEntry({ id: 'p1' }) },
      { table: 'plan_item', record: planItem('p1', { id: 'i1' }) },
    ]);
    const since = currentServerSeq(db);
    applyPush(db, 'owner', [
      { table: 'plan_entry', record: planEntry({ id: 'p1', status: 'skipped', updated_at: 2000 }) },
      { table: 'plan_item', record: planItem('p1', { id: 'i1', deleted: 1, updated_at: 2000 }) },
    ]);
    const page = pullChanges(db, since, 50);
    expect(page.changes.map((c) => [c.table, c.record.id, c.record.status ?? c.record.deleted])).toEqual([
      ['plan_entry', 'p1', 'skipped'],
      ['plan_item', 'i1', 1],
    ]);
  });

  it('ignores a stale plan push under last-write-wins', () => {
    const db = initDatabase(':memory:');
    applyPush(db, 'owner', [{ table: 'plan_entry', record: planEntry({ id: 'p1', status: 'skipped', updated_at: 5000 }) }]);
    const stale = applyPush(db, 'owner', [
      { table: 'plan_entry', record: planEntry({ id: 'p1', status: 'planned', updated_at: 4000 }) },
    ]);
    expect(stale[0]!.status).toBe('ignored');
    expect(db.prepare('SELECT status FROM plan_entry WHERE id = ?').pluck().get('p1')).toBe('skipped');
  });
});
