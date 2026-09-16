import { describe, expect, it } from 'vitest';
import { currentServerSeq } from '../src/db';
import { initDatabase } from '../src/init';
import { pullChanges } from '../src/sync/pull';
import { applyPush } from '../src/sync/push';
import { meal, mealItem, planEntry, planItem } from './sync-helpers';

const meta = (updated_at = 1000) => ({ updated_at, updated_by: 'phone', deleted: 0 });
const quickMealItem = (fields: Record<string, unknown> = {}) => ({
  id: 'q1', meal_id: 'm1', ref_type: 'quick', ref_id: 'q1', amount: 7, unit: 'carbs', position: 1, label: 'Salsa', ...meta(), ...fields,
});

describe('quick carbs through applyPush', () => {
  it('accepts quick rows in every item table as the owner and as a viewer', () => {
    const db = initDatabase(':memory:');
    const owner = applyPush(db, 'owner', [
      { table: 'meal', record: meal({ id: 'm1' }) },
      { table: 'meal_item', record: quickMealItem() },
      { table: 'log_item', record: { id: 'l1', log_entry_id: 'e1', ref_type: 'quick', ref_id: 'l1', display_name: 'Ranch & salad', amount: 7, unit: 'carbs', carbs_g: 7, ...meta() } },
      { table: 'plan_entry', record: planEntry({ id: 'p1' }) },
    ]);
    expect(owner.map((r) => r.status)).toEqual(['accepted', 'accepted', 'accepted', 'accepted']);
    const viewer = applyPush(db, 'viewer', [
      { table: 'plan_item', record: planItem('p1', { id: 'qp', ref_type: 'quick', ref_id: 'qp', amount: 7, unit: 'carbs', label: 'Ranch & salad' }) },
    ]);
    expect(viewer.map((r) => r.status)).toEqual(['accepted']);
  });

  it('rejects a bad quick row on its own without failing the rest of the batch', () => {
    const db = initDatabase(':memory:');
    const results = applyPush(db, 'owner', [
      { table: 'meal_item', record: quickMealItem({ id: 'bad', ref_id: 'bad', amount: 2001 }) },
      { table: 'meal_item', record: quickMealItem({ id: 'good', ref_id: 'good' }) },
    ]);
    expect(results).toEqual([
      { table: 'meal_item', id: 'bad', status: 'rejected', reason: 'invalid', message: 'quick carbs amount must be 0-2000 g' },
      expect.objectContaining({ id: 'good', status: 'accepted' }),
    ]);
    expect(db.prepare('SELECT id FROM meal_item').pluck().all()).toEqual(['good']);
  });

  it('keeps a stored label when an older client pushes the row without the label key', () => {
    const db = initDatabase(':memory:');
    applyPush(db, 'owner', [{ table: 'meal_item', record: quickMealItem() }]);
    const { label: _label, ...olderClient } = quickMealItem({ amount: 8, ...meta(2000) });
    expect(applyPush(db, 'owner', [{ table: 'meal_item', record: olderClient }])[0]!.status).toBe('accepted');
    expect(db.prepare('SELECT amount, label FROM meal_item WHERE id = ?').get('q1')).toEqual({ amount: 8, label: 'Salsa' });
  });

  it('clears a label only on an explicit null', () => {
    const db = initDatabase(':memory:');
    applyPush(db, 'owner', [{ table: 'meal_item', record: quickMealItem() }]);
    applyPush(db, 'owner', [{ table: 'meal_item', record: quickMealItem({ label: null, ...meta(2000) }) }]);
    expect(db.prepare('SELECT label FROM meal_item WHERE id = ?').pluck().get('q1')).toBeNull();
  });

  it('pulls quick rows with their label, and food rows with label null', () => {
    const db = initDatabase(':memory:');
    const since = currentServerSeq(db);
    applyPush(db, 'owner', [
      { table: 'meal_item', record: mealItem('m1', 'food', 'f1', { position: 0 }) },
      { table: 'meal_item', record: quickMealItem() },
    ]);
    const records = pullChanges(db, since, 50).changes.map((c) => c.record);
    expect(records[0]).toMatchObject({ ref_type: 'food', label: null });
    expect(records[1]).toMatchObject({ ref_type: 'quick', ref_id: 'q1', amount: 7, unit: 'carbs', label: 'Salsa' });
  });

  it('does not treat a quick row as a meal reference in the cycle check', () => {
    const db = initDatabase(':memory:');
    const results = applyPush(db, 'owner', [
      { table: 'meal', record: meal({ id: 'm1' }) },
      // ref_id equal to the meal's own id would be a cycle for a meal row; for a quick row it means nothing.
      { table: 'meal_item', record: quickMealItem({ ref_id: 'm1' }) },
    ]);
    expect(results.map((r) => r.status)).toEqual(['accepted', 'accepted']);
  });
});
