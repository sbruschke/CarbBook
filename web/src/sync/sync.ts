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
 */
export async function syncOnce(db: CarbBookDb, api: Api, now: () => number = Date.now): Promise<void> {
  await withSyncLock(async () => {
    for (;;) {
      const summary = await pushOutbox(db, api, now);
      if (summary.sent === 0 || (await db.outbox.count()) === 0) break;
    }
    await pullAll(db, api);
    await setMeta(db, 'last_synced_at', now());
  });
}
