import type { CarbBookDb } from '../db/db';
import { setMeta } from '../db/meta';
import type { Api } from '../lib/api';
import { pullAll } from './pull';
import { pushOutbox } from './push';

const SYNC_LOCK_NAME = 'carbbook-sync';

interface LockManager {
  request<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

/** In-memory fallback for browsers without the Web Locks API: a simple FIFO promise queue. */
let inMemoryQueue: Promise<unknown> = Promise.resolve();

async function withSyncLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = (globalThis as { navigator?: { locks?: LockManager } }).navigator?.locks;
  if (locks) return locks.request(SYNC_LOCK_NAME, fn);
  const previous = inMemoryQueue.catch(() => {});
  const run = previous.then(fn);
  inMemoryQueue = run.catch(() => {});
  return run;
}

/**
 * One sync pass (spec §5): push until the outbox is drained, then pull until drained. Runs under
 * a cross-tab lock (`navigator.locks`, or an in-memory mutex when unavailable) so two tabs never
 * push/pull at the same time.
 *
 * `currentUserId`, when given, is the signed-in session's user id — passed through to `pushOutbox`
 * so a different user's still-queued changes (left behind by a user switch on this device) are
 * never pushed under this session (spec: sync-integrity). It is the caller's live session id, not
 * whatever happens to be cached in `meta.user`, since those two can diverge (e.g. right after
 * "Continue as" on a login conflict, before any reload updates the cache).
 */
export async function syncOnce(db: CarbBookDb, api: Api, now: () => number = Date.now, currentUserId?: number): Promise<void> {
  await withSyncLock(async () => {
    for (;;) {
      const summary = await pushOutbox(db, api, now, currentUserId);
      if (summary.sent === 0 || (await db.outbox.count()) === 0) break;
    }
    await pullAll(db, api);
    await setMeta(db, 'last_synced_at', now());
  });
}
