import type { AnySyncRecord, CarbBookDb } from '../db/db';

export interface ForeignPending {
  count: number;
  ownerId: number;
  ownerUsername: string;
}

/**
 * Summarizes outbox entries not owned by `currentUserId` (spec: sync-integrity — a different
 * user's changes held on this device). `null` ownerId rows (pre-ownership legacy entries with no
 * determinable owner) are treated as the current user's own, never as foreign. When more than one
 * other owner is somehow held, only the first encountered is named; the count still covers all of
 * them, since the UI shows a single line.
 */
export async function foreignPendingSummary(db: CarbBookDb, currentUserId: number): Promise<ForeignPending | null> {
  const foreign = (await db.outbox.toArray()).filter((row) => row.ownerId !== null && row.ownerId !== currentUserId);
  if (foreign.length === 0) return null;
  const first = foreign[0]!;
  return { count: foreign.length, ownerId: first.ownerId!, ownerUsername: first.ownerUsername ?? 'another user' };
}

/**
 * Discards every outbox entry not owned by `currentUserId`: restores the last server-acknowledged
 * snapshot for a previously-synced record, or deletes it if it was never synced — the same
 * resolution a server rejection applies (`pushOutbox`) — but without recording a sync_error, since
 * nothing was rejected. Returns the number of entries discarded.
 */
export async function discardForeignPending(db: CarbBookDb, currentUserId: number): Promise<number> {
  return db.transaction('rw', [db.outbox, ...db.syncTables()], async () => {
    const foreign = (await db.outbox.toArray()).filter((row) => row.ownerId !== null && row.ownerId !== currentUserId);
    for (const entry of foreign) {
      if (entry.snapshot) await db.table(entry.table).put(entry.snapshot as AnySyncRecord);
      else await db.table(entry.table).delete(entry.id);
      await db.outbox.delete(entry.key);
    }
    return foreign.length;
  });
}
