import type { Db } from '../db';
import { SYNC_TABLES, type SyncTable, TABLE_SPECS } from './tables';
import { decodeRow } from './validate';

export interface PullChange {
  table: SyncTable;
  record: Record<string, unknown> & { server_seq: number };
}

export interface PullPage {
  changes: PullChange[];
  /** Pass as `since` on the next pull. */
  next_since: number;
  has_more: boolean;
}

/** Records from every synced table with server_seq > since, in server_seq order. */
export function pullChanges(db: Db, since: number, limit: number): PullPage {
  const collected: PullChange[] = [];
  for (const table of SYNC_TABLES) {
    const rows = db
      .prepare(`SELECT * FROM ${table} WHERE server_seq > ? ORDER BY server_seq LIMIT ?`)
      .all(since, limit + 1) as Record<string, unknown>[];
    for (const row of rows) {
      collected.push({ table, record: decodeRow(TABLE_SPECS[table], row) as PullChange['record'] });
    }
  }
  collected.sort((a, b) => a.record.server_seq - b.record.server_seq);
  const changes = collected.slice(0, limit);
  const last = changes.at(-1);
  return { changes, next_since: last ? last.record.server_seq : since, has_more: collected.length > limit };
}
