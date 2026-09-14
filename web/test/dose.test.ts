import { afterEach, describe, expect, it } from 'vitest';
import type { CarbBookDb } from '../src/db/db';
import { selectActiveSettings } from '../src/db/dose';
import { createStore } from '../src/db/store';
import { pullAll } from '../src/sync/pull';
import { pushOutbox } from '../src/sync/push';
import { doseSettingsData, FakeApi, openTestDb, synced } from './helpers';

let db: CarbBookDb;
afterEach(async () => {
  await db.delete();
});

describe('selectActiveSettings', () => {
  it('returns the newest effective version at the given time', async () => {
    db = openTestDb();
    await db.dose_settings.bulkPut([
      synced(doseSettingsData({ id: 'ds-1', effective_from: 0 })),
      synced(doseSettingsData({ id: 'ds-2', effective_from: 1000 })),
    ]);
    expect((await selectActiveSettings(db, () => 2000))?.id).toBe('ds-2');
    expect((await selectActiveSettings(db, () => 500))?.id).toBe('ds-1');
  });

  it('excludes a rejected version only when the failed restore left it at the rejected version (backstop)', async () => {
    db = openTestDb();
    await db.dose_settings.bulkPut([
      synced(doseSettingsData({ id: 'ds-1', effective_from: 0 })),
      synced(doseSettingsData({ id: 'ds-2', effective_from: 1000 })),
    ]);
    // rejectedUpdatedAt matches ds-2's current updated_at (1000, from synced()) — the restore never happened.
    await db.sync_error.put({
      key: 'dose_settings:ds-2',
      table: 'dose_settings',
      id: 'ds-2',
      reason: 'append_only',
      message: 'overlaps',
      at: 1,
      rejectedUpdatedAt: 1000,
      resolved: false,
    });
    expect((await selectActiveSettings(db, () => 2000))?.id).toBe('ds-1');
  });

  it('returns null when there is no eligible version', async () => {
    db = openTestDb();
    expect(await selectActiveSettings(db, () => 2000)).toBeNull();
  });

  it('keeps a rejected-edit version active once its snapshot is restored by the push', async () => {
    db = openTestDb();
    const store = createStore(db, 'device-a', { now: () => 1000 });
    await store.save('dose_settings', doseSettingsData({ id: 'ds-1', effective_from: 0 }));
    await pushOutbox(db, new FakeApi().on('POST', '/api/sync/push', (body) => ({
      results: (body as { changes: { table: string; record: { id: string } }[] }).changes.map((c) => ({
        table: c.table,
        id: c.record.id,
        status: 'accepted',
        server_seq: 1,
      })),
      server_seq: 1,
    })));

    // Edit the already-synced version; the server rejects the edit (append_only).
    const clock2 = 2000;
    await createStore(db, 'device-a', { now: () => clock2 }).save(
      'dose_settings',
      doseSettingsData({ id: 'ds-1', effective_from: 0, correction: { threshold: 999, step: 50, units_per_step: 1, mode: 'proportional' } }),
    );
    await pushOutbox(
      db,
      new FakeApi().on('POST', '/api/sync/push', () => ({
        results: [{ table: 'dose_settings', id: 'ds-1', status: 'rejected', reason: 'append_only', message: 'overlaps' }],
        server_seq: 1,
      })),
    );

    // The restore succeeded (row is back at the server-acknowledged updated_at), so it's still eligible.
    expect((await db.dose_settings.get('ds-1'))?.updated_at).toBe(1000);
    expect((await selectActiveSettings(db, () => 3000))?.id).toBe('ds-1');
  });

  it('stops excluding a rejected id once a pull applies a server row for that key', async () => {
    db = openTestDb();
    await db.dose_settings.put(synced(doseSettingsData({ id: 'ds-1', effective_from: 0 }), { updated_at: 1000 }));
    await db.sync_error.put({
      key: 'dose_settings:ds-1',
      table: 'dose_settings',
      id: 'ds-1',
      reason: 'append_only',
      message: 'overlaps',
      at: 1,
      rejectedUpdatedAt: 1000,
      resolved: false,
    });
    // Sanity: still excluded before the pull.
    expect(await selectActiveSettings(db, () => 2000)).toBeNull();

    const api = new FakeApi().on('GET', '/api/sync/pull', () => ({
      changes: [{ table: 'dose_settings', record: synced(doseSettingsData({ id: 'ds-1', effective_from: 0 }), { updated_at: 5000 }) }],
      next_since: 1,
      has_more: false,
    }));
    await pullAll(db, api);

    expect((await selectActiveSettings(db, () => 6000))?.id).toBe('ds-1');
    expect((await db.sync_error.get('dose_settings:ds-1'))?.resolved).toBe(true);
  });
});
