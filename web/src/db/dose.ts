import { activeSettings, type DoseSettingsData, type Synced } from '@carbbook/core';
import type { CarbBookDb, SyncErrorRow, SyncRecords } from './db';
import { isLive } from './db';

/**
 * The dose_settings versions eligible to drive dosing: live, and not held back by a recorded
 * server rejection. This is the ONE exclusion rule, shared by `selectActiveSettings` and the
 * reactive `useEligibleDoseVersions` hook — never re-derive it ad hoc.
 *
 * It is belt-and-braces on top of `pushOutbox`'s rejection restore: an id with an unresolved
 * recorded rejection is excluded ONLY while the local row still sits at the rejected version —
 * i.e. the restore (or delete) itself failed. Once the restore succeeds the row's `updated_at` no
 * longer matches the rejection record, so the restored (valid, server-acknowledged) version is
 * eligible again. A pull that later applies a server row for the same key marks the rejection
 * resolved (see `pullAll`), which also lifts the exclusion regardless of `updated_at`.
 */
export function eligibleDoseVersions<T extends Synced<DoseSettingsData>>(
  versions: T[],
  syncErrors: Pick<SyncErrorRow, 'table' | 'id' | 'rejectedUpdatedAt' | 'resolved'>[],
): T[] {
  const rejectionById = new Map(syncErrors.filter((e) => e.table === 'dose_settings').map((e) => [e.id, e]));
  return versions.filter((v) => {
    if (!isLive(v)) return false;
    const rejection = rejectionById.get(v.id);
    if (!rejection || rejection.resolved) return true;
    return v.updated_at !== rejection.rejectedUpdatedAt;
  });
}

/**
 * The dose_settings version that should drive dosing right now. The ONLY sanctioned way to pick
 * active dose settings outside React (dose calculator, log recalculation, or any future call site);
 * eligibility is `eligibleDoseVersions`.
 */
export async function selectActiveSettings(
  db: CarbBookDb,
  now: () => number = Date.now,
): Promise<SyncRecords['dose_settings'] | null> {
  const [versions, syncErrors] = await Promise.all([db.dose_settings.toArray(), db.sync_error.toArray()]);
  return activeSettings(eligibleDoseVersions(versions, syncErrors), now());
}
