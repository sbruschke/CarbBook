import type { AnySyncRecord, CarbBookDb, SyncRecords, SyncTable } from './db';
import { outboxKey } from './db';

type MetaField = 'updated_at' | 'updated_by' | 'deleted' | 'server_seq';

/** A record's own fields; the store adds sync metadata. Pass the complete record. */
export type RecordData<T extends SyncTable> = Omit<SyncRecords[T], MetaField>;

export type Change = { [T in SyncTable]: { table: T; data: RecordData<T> } }[SyncTable];

/** A stored record without its sync metadata, ready to edit and save again. */
export function dataOf<T extends SyncTable>(record: SyncRecords[T]): RecordData<T> {
  const { updated_at: _updatedAt, updated_by: _updatedBy, deleted: _deleted, server_seq: _serverSeq, ...data } =
    record as AnySyncRecord;
  return data as unknown as RecordData<T>;
}

export interface Store {
  readonly db: CarbBookDb;
  readonly deviceId: string;
  save<T extends SyncTable>(table: T, data: RecordData<T>): Promise<SyncRecords[T]>;
  /** Saves several records in one transaction (e.g. a meal and its items). */
  saveMany(changes: Change[]): Promise<void>;
  /** Soft delete (spec §5). Unknown ids are ignored. */
  remove(table: SyncTable, id: string): Promise<void>;
}

export interface StoreOptions {
  now?: () => number;
  /** Called after every committed write; the sync engine debounces a push from it. */
  onWrite?: () => void;
}

export function createStore(db: CarbBookDb, deviceId: string, options: StoreOptions = {}): Store {
  const now = options.now ?? Date.now;
  const tables = () => [...db.syncTables(), db.outbox];

  async function stamp(table: SyncTable, id: string, fields: object, deleted: 0 | 1): Promise<AnySyncRecord> {
    const existing = (await db.table(table).get(id)) as AnySyncRecord | undefined;
    // Never go backwards: a local edit must beat the version it replaces even if this clock is behind.
    const updatedAt = Math.max(now(), existing ? existing.updated_at + 1 : 0);
    const record = { ...existing, ...fields, id, updated_at: updatedAt, updated_by: deviceId, deleted } as AnySyncRecord;
    await db.table(table).put(record);
    // Keep the snapshot from the outbox row already queued for this record (the last
    // server-acknowledged copy); only capture a fresh one when nothing is queued yet, since an
    // outbox row exists exactly when there's an unsynced edit.
    const key = outboxKey(table, id);
    const queued = await db.outbox.get(key);
    const snapshot = queued ? queued.snapshot : (existing ?? null);
    await db.outbox.put({ key, table, id, updated_at: updatedAt, snapshot });
    return record;
  }

  return {
    db,
    deviceId,
    async save<T extends SyncTable>(table: T, data: RecordData<T>): Promise<SyncRecords[T]> {
      const id = (data as { id: string }).id;
      const record = await db.transaction('rw', tables(), () => stamp(table, id, data, 0));
      options.onWrite?.();
      return record as SyncRecords[T];
    },
    async saveMany(changes: Change[]): Promise<void> {
      if (changes.length === 0) return;
      await db.transaction('rw', tables(), async () => {
        for (const change of changes) await stamp(change.table, change.data.id, change.data, 0);
      });
      options.onWrite?.();
    },
    async remove(table: SyncTable, id: string): Promise<void> {
      const removed = await db.transaction('rw', tables(), async () => {
        if (!(await db.table(table).get(id))) return false;
        await stamp(table, id, {}, 1);
        return true;
      });
      if (removed) options.onWrite?.();
    },
  };
}
