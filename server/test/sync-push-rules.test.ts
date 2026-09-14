import { describe, expect, it } from 'vitest';
import { initDatabase } from '../src/init';
import { applyPush } from '../src/sync/push';
import { doseSettings, food, meal, mealItem } from './sync-helpers';

describe('applyPush permissions', () => {
  it('rejects dose_settings from a viewer but accepts their foods, meals and logs', () => {
    const db = initDatabase(':memory:');
    const results = applyPush(db, 'viewer', [
      { table: 'dose_settings', record: doseSettings({ id: 'd-viewer' }) },
      { table: 'food', record: food({ id: 'f1' }) },
      {
        table: 'log_entry',
        record: {
          id: 'l1', eaten_at: 1, window_name: 'Lunch', bg_mgdl: 140, bg_source: 'manual', bg_trend: null, total_carbs_g: 40,
          suggested_units: 5, taken_units: 5, settings_version_id: null, notes: null, updated_at: 1, updated_by: 'kim', deleted: 0,
        },
      },
    ]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'accepted', 'accepted']);
    expect(results[0]).toEqual({
      table: 'dose_settings', id: 'd-viewer', status: 'rejected', reason: 'forbidden', message: 'Only the owner can change dose_settings',
    });
    expect(db.prepare('SELECT count(*) FROM dose_settings WHERE id = ?').pluck().get('d-viewer')).toBe(0);
  });

  it('lets the owner save a new dose_settings version', () => {
    const db = initDatabase(':memory:');
    expect(applyPush(db, 'owner', [{ table: 'dose_settings', record: doseSettings({ id: 'd-owner' }) }])[0]!.status).toBe('accepted');
  });
});

describe('applyPush dose_settings append-only rule', () => {
  it('rejects an owner push that soft-deletes an existing dose_settings row', () => {
    const db = initDatabase(':memory:');
    const seeded = db.prepare('SELECT id FROM dose_settings LIMIT 1').get() as { id: string };
    const results = applyPush(db, 'owner', [
      { table: 'dose_settings', record: doseSettings({ id: seeded.id, updated_at: 2000, deleted: 1 }) },
    ]);
    expect(results).toEqual([
      {
        table: 'dose_settings', id: seeded.id, status: 'rejected', reason: 'append_only',
        message: 'dose_settings rows are append-only: cannot delete an existing version',
      },
    ]);
    expect(db.prepare('SELECT deleted FROM dose_settings WHERE id = ?').pluck().get(seeded.id)).toBe(0);
  });

  it('rejects an owner push that edits an existing dose_settings row\'s effective_from, windows, correction or rounding', () => {
    const db = initDatabase(':memory:');
    const created = doseSettings({ id: 'd-owner' });
    applyPush(db, 'owner', [{ table: 'dose_settings', record: created }]);

    const edits = [
      { ...created, updated_at: 2000, effective_from: created.effective_from + 1 },
      { ...created, updated_at: 2000, windows: [{ name: 'Only', start: '00:00', ratio_g_per_unit: 9 }] },
      { ...created, updated_at: 2000, correction: { ...created.correction, threshold: 999 } },
      { ...created, updated_at: 2000, rounding: { ...created.rounding, increment: 2 } },
    ];
    for (const record of edits) {
      const [result] = applyPush(db, 'owner', [{ table: 'dose_settings', record }]);
      expect(result).toEqual({
        table: 'dose_settings', id: 'd-owner', status: 'rejected', reason: 'append_only',
        message: 'dose_settings rows are append-only: cannot edit an existing version, push a new one instead',
      });
    }
    expect(db.prepare('SELECT effective_from FROM dose_settings WHERE id = ?').pluck().get('d-owner')).toBe(created.effective_from);
  });

  it('still accepts a metadata-only republish of the same version (same content, newer updated_at)', () => {
    const db = initDatabase(':memory:');
    const created = doseSettings({ id: 'd-owner' });
    applyPush(db, 'owner', [{ table: 'dose_settings', record: created }]);
    const republish = applyPush(db, 'owner', [{ table: 'dose_settings', record: { ...created, updated_at: 2000 } }]);
    expect(republish[0]!.status).toBe('accepted');
  });
});

describe('applyPush meal cycles', () => {
  it('rejects a meal_item that makes a meal contain itself, directly or transitively', () => {
    const db = initDatabase(':memory:');
    applyPush(db, 'owner', [
      { table: 'meal', record: meal({ id: 'A' }) },
      { table: 'meal', record: meal({ id: 'B' }) },
      { table: 'meal', record: meal({ id: 'C' }) },
      { table: 'meal_item', record: mealItem('A', 'meal', 'B') },
      { table: 'meal_item', record: mealItem('B', 'meal', 'C') },
    ]);
    const results = applyPush(db, 'owner', [
      { table: 'meal_item', record: mealItem('C', 'meal', 'A', { position: 1 }) },
      { table: 'meal_item', record: mealItem('A', 'meal', 'A', { position: 2 }) },
      { table: 'meal_item', record: mealItem('C', 'food', 'f1', { position: 3 }) },
    ]);
    expect(results.map((r) => (r.status === 'rejected' ? r.reason : r.status))).toEqual(['cycle', 'cycle', 'accepted']);
  });

  it('ignores deleted items when checking, including earlier records in the same push', () => {
    const db = initDatabase(':memory:');
    const aToB = mealItem('A', 'meal', 'B', { updated_at: 1 });
    applyPush(db, 'owner', [{ table: 'meal_item', record: aToB }]);
    const results = applyPush(db, 'owner', [
      { table: 'meal_item', record: { ...aToB, updated_at: 2, deleted: 1 } },
      { table: 'meal_item', record: mealItem('B', 'meal', 'A', { updated_at: 2 }) },
    ]);
    expect(results.map((r) => r.status)).toEqual(['accepted', 'accepted']);
  });
});
