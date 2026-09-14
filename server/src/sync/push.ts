import { isNewer } from '@carbbook/core';
import type { Role } from '../auth/users';
import { type Db, nextServerSeq } from '../db';
import { columnsOf, isSyncTable, type TableSpec, TABLE_SPECS } from './tables';
import { type SqlRow, validateRecord } from './validate';

export interface PushChange {
  table: string;
  record: unknown;
}

export type RejectReason = 'unknown_table' | 'invalid' | 'forbidden' | 'cycle';

export type PushResult =
  | { table: string; id: string; status: 'accepted'; server_seq: number }
  /** The stored row is newer (or identical); the client picks up the winner on pull. */
  | { table: string; id: string; status: 'ignored'; server_seq: number }
  | { table: string; id: string | null; status: 'rejected'; reason: RejectReason; message: string };

function recordId(record: unknown): string | null {
  const id = (record as { id?: unknown } | null)?.id;
  return typeof id === 'string' ? id : null;
}

function upsert(db: Db, spec: TableSpec, row: SqlRow): void {
  const columns = columnsOf(spec);
  const updates = columns
    .filter((c) => c !== 'id')
    .map((c) => `${c} = excluded.${c}`)
    .join(', ');
  db.prepare(
    `INSERT INTO ${spec.name} (${columns.join(', ')}) VALUES (${columns.map((c) => `@${c}`).join(', ')})
     ON CONFLICT (id) DO UPDATE SET ${updates}`,
  ).run(row);
}

function applyOne(db: Db, _role: Role, change: PushChange): PushResult {
  const id = recordId(change.record);
  const table = String(change.table);
  if (!isSyncTable(change.table)) {
    return { table, id, status: 'rejected', reason: 'unknown_table', message: `Unknown table "${table}"` };
  }
  const spec = TABLE_SPECS[change.table];
  const validation = validateRecord(spec, change.record);
  if (!validation.ok) return { table, id, status: 'rejected', reason: 'invalid', message: validation.message };
  const row = validation.row;
  const rowId = row.id as string;

  const stored = db
    .prepare(`SELECT updated_at, updated_by, server_seq FROM ${spec.name} WHERE id = ?`)
    .get(rowId) as { updated_at: number; updated_by: string; server_seq: number } | undefined;
  const incoming = { updated_at: row.updated_at as number, updated_by: row.updated_by as string };
  if (stored && !isNewer(incoming, stored)) {
    return { table, id: rowId, status: 'ignored', server_seq: stored.server_seq };
  }

  const serverSeq = nextServerSeq(db);
  upsert(db, spec, { ...row, server_seq: serverSeq });
  return { table, id: rowId, status: 'accepted', server_seq: serverSeq };
}

/** Applies pushed records in order inside one transaction; each record gets its own result. */
export function applyPush(db: Db, role: Role, changes: PushChange[]): PushResult[] {
  return db.transaction(() => changes.map((change) => applyOne(db, role, change)))();
}
