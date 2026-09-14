import { isNewer } from '@carbbook/core';
import type { AnySyncRecord, CarbBookDb } from '../db/db';
import { isSyncTable, outboxKey } from '../db/db';
import { getMeta, setMeta } from '../db/meta';
import type { Api } from '../lib/api';
import type { PullPage } from '../lib/wire';

export const PULL_PAGE_SIZE = 500;

/**
 * Pulls pages until drained. Each page and its cursor commit together, so an interrupted pull
 * resumes where it stopped. A pending local edit that is newer than the pulled record is kept
 * (it will be pushed); otherwise the server record wins and the pending entry is dropped.
 */
export async function pullAll(
  db: CarbBookDb,
  api: Api,
  pageSize: number = PULL_PAGE_SIZE,
): Promise<{ applied: number; pages: number }> {
  let applied = 0;
  let pages = 0;
  for (;;) {
    const since = (await getMeta(db, 'last_pull_seq')) ?? 0;
    const page = await api.get<PullPage>(`/api/sync/pull?since=${since}&limit=${pageSize}`);
    pages++;
    await db.transaction('rw', [db.outbox, db.meta, ...db.syncTables()], async () => {
      for (const change of page.changes) {
        if (!isSyncTable(change.table)) continue;
        const incoming = change.record;
        const key = outboxKey(change.table, incoming.id);
        const pending = await db.outbox.get(key);
        if (pending) {
          const local = (await db.table(change.table).get(incoming.id)) as AnySyncRecord | undefined;
          if (local && !isNewer(incoming, local)) continue;
          await db.outbox.delete(key);
        }
        await db.table(change.table).put(incoming);
        applied++;
      }
      await setMeta(db, 'last_pull_seq', page.next_since);
    });
    if (!page.has_more) return { applied, pages };
  }
}
