import { activeSettings } from '@carbbook/core';
import type { CarbBookDb, SyncRecords } from './db';
import { isLive } from './db';

/**
 * The dose_settings version that should drive dosing right now. This is the ONLY sanctioned way
 * to pick active dose settings anywhere in the app (dose calculator, log recalculation, or any
 * future call site) — never re-derive it ad hoc from `db.dose_settings`. It is belt-and-braces on
 * top of `pushOutbox`'s rejection restore: any id with a recorded rejection is excluded here too,
 * so a refused version can never drive a dose even if the local restore/delete somehow failed.
 */
export async function selectActiveSettings(
  db: CarbBookDb,
  now: () => number = Date.now,
): Promise<SyncRecords['dose_settings'] | null> {
  const [versions, syncErrors] = await Promise.all([db.dose_settings.toArray(), db.sync_error.toArray()]);
  const rejectedIds = new Set(syncErrors.filter((e) => e.table === 'dose_settings').map((e) => e.id));
  const eligible = versions.filter((v) => isLive(v) && !rejectedIds.has(v.id));
  return activeSettings(eligible, now());
}
