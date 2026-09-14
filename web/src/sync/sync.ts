import type { CarbBookDb } from '../db/db';
import { setMeta } from '../db/meta';
import type { Api } from '../lib/api';
import { pullAll } from './pull';
import { pushOutbox } from './push';

/** One sync pass (spec §5): push until the outbox is drained, then pull until drained. */
export async function syncOnce(db: CarbBookDb, api: Api, now: () => number = Date.now): Promise<void> {
  for (;;) {
    const summary = await pushOutbox(db, api, now);
    if (summary.sent === 0 || (await db.outbox.count()) === 0) break;
  }
  await pullAll(db, api);
  await setMeta(db, 'last_synced_at', now());
}
