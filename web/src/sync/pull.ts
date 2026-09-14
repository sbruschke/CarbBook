import { isNewer } from '@carbbook/core';
import type { AnySyncRecord, CarbBookDb } from '../db/db';
import { isSyncTable, outboxKey } from '../db/db';
import { getMeta, setMeta } from '../db/meta';
import type { Api } from '../lib/api';
import type { PullPage } from '../lib/wire';

export const PULL_PAGE_SIZE = 500;

/**
 * Pulls pages until drained. Each page and its cursor commit together in one transaction, so an
 * interrupted pull resumes where it stopped. Every pulled row goes through last-write-wins
 * (`isNewer`) against whatever is stored locally, pending edit or not, so a stale/reordered page
 * can never clobber a newer local row. A pending local edit that is newer than the pulled record
 * is kept (it will be pushed); otherwise the server record wins and the pending entry is dropped.
 * The cursor only ever moves forward, even if a stale page is applied after a newer one.
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
        const local = (await db.table(change.table).get(incoming.id)) as AnySyncRecord | undefined;
        if (!isNewer(incoming, local)) continue;
        const key = outboxKey(change.table, incoming.id);
        if (await db.outbox.get(key)) await db.outbox.delete(key);
        await db.table(change.table).put(incoming);
        applied++;
      }
      const current = (await getMeta(db, 'last_pull_seq')) ?? 0;
      await setMeta(db, 'last_pull_seq', Math.max(current, page.next_since));
    });
    if (!page.has_more) return { applied, pages };
  }
}
