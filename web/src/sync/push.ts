import type { AnySyncRecord, CarbBookDb, OutboxRow } from '../db/db';
import type { Api } from '../lib/api';
import type { PushResponse } from '../lib/wire';

/** Server limit per request (server-data plan: MAX_PUSH_CHANGES). */
export const PUSH_BATCH_SIZE = 500;

export interface PushSummary {
  sent: number;
  accepted: number;
  ignored: number;
  rejected: number;
}

/**
 * Pushes one batch of pending changes. The outbox entry is removed only if the record was not
 * edited again while the request was in flight. Rejected records are stored as sync errors and
 * not retried until edited again; if no newer edit is queued behind the rejected one, the local
 * table row is restored to the last server-acknowledged snapshot (or deleted if it was never
 * synced), so a refused edit never lingers in local data.
 */
export async function pushOutbox(db: CarbBookDb, api: Api, now: () => number = Date.now): Promise<PushSummary> {
  const summary: PushSummary = { sent: 0, accepted: 0, ignored: 0, rejected: 0 };
  const batch: { entry: OutboxRow; record: AnySyncRecord }[] = [];
  for (const entry of await db.outbox.limit(PUSH_BATCH_SIZE).toArray()) {
    const record = (await db.table(entry.table).get(entry.id)) as AnySyncRecord | undefined;
    if (record) batch.push({ entry, record });
    else await db.outbox.delete(entry.key);
  }
  if (batch.length === 0) return summary;

  const response = await api.post<PushResponse>('/api/sync/push', {
    changes: batch.map(({ entry, record }) => ({ table: entry.table, record })),
  });

  await db.transaction('rw', [db.outbox, db.sync_error, ...db.syncTables()], async () => {
    for (const [index, { entry, record }] of batch.entries()) {
      const result = response.results[index];
      if (!result) continue;
      summary.sent++;
      const pending = await db.outbox.get(entry.key);
      const unchanged = pending !== undefined && pending.updated_at === record.updated_at;
      if (result.status === 'rejected') {
        summary.rejected++;
        await db.sync_error.put({
          key: entry.key,
          table: entry.table,
          id: entry.id,
          reason: result.reason,
          message: result.message,
          at: now(),
        });
        // Only restore when no newer local edit is queued behind this one — that edit will be
        // pushed on the next pass and must not be clobbered by the rejected version's snapshot.
        if (unchanged) {
          if (entry.snapshot) await db.table(entry.table).put(entry.snapshot);
          else await db.table(entry.table).delete(entry.id);
        }
      } else {
        await db.sync_error.delete(entry.key);
        if (result.status === 'accepted') {
          summary.accepted++;
          if (unchanged) await db.table(entry.table).update(entry.id, { server_seq: result.server_seq });
        } else {
          summary.ignored++;
        }
      }
      if (unchanged) await db.outbox.delete(entry.key);
    }
  });
  return summary;
}
