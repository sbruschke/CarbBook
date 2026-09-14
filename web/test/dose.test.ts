import { afterEach, describe, expect, it } from 'vitest';
import type { CarbBookDb } from '../src/db/db';
import { selectActiveSettings } from '../src/db/dose';
import { doseSettingsData, openTestDb, synced } from './helpers';

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

  it('excludes a version with a recorded rejection even if it was never removed locally', async () => {
    db = openTestDb();
    await db.dose_settings.bulkPut([
      synced(doseSettingsData({ id: 'ds-1', effective_from: 0 })),
      synced(doseSettingsData({ id: 'ds-2', effective_from: 1000 })),
    ]);
    await db.sync_error.put({ key: 'dose_settings:ds-2', table: 'dose_settings', id: 'ds-2', reason: 'append_only', message: 'overlaps', at: 1 });
    expect((await selectActiveSettings(db, () => 2000))?.id).toBe('ds-1');
  });

  it('returns null when there is no eligible version', async () => {
    db = openTestDb();
    expect(await selectActiveSettings(db, () => 2000)).toBeNull();
  });
});
