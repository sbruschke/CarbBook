import { uuidv7 } from '../lib/ids';
import type { User } from '../lib/wire';
import type { CarbBookDb } from './db';

export interface MetaValues {
  device_id: string;
  /** `next_since` from the last applied pull page. */
  last_pull_seq: number;
  last_synced_at: number;
  usda_version: string;
  /** Last signed-in user, so the app opens offline. */
  user: User;
}

export type MetaKey = keyof MetaValues;

export async function getMeta<K extends MetaKey>(db: CarbBookDb, key: K): Promise<MetaValues[K] | undefined> {
  const row = await db.meta.get(key);
  return row?.value as MetaValues[K] | undefined;
}

export async function setMeta<K extends MetaKey>(db: CarbBookDb, key: K, value: MetaValues[K]): Promise<void> {
  await db.meta.put({ key, value });
}

export async function deleteMeta(db: CarbBookDb, key: MetaKey): Promise<void> {
  await db.meta.delete(key);
}

/** This browser's `updated_by`, created once and kept in IndexedDB. */
export function getDeviceId(db: CarbBookDb, makeId: () => string = () => uuidv7()): Promise<string> {
  return db.transaction('rw', db.meta, async () => {
    const existing = await getMeta(db, 'device_id');
    if (existing) return existing;
    const id = makeId();
    await setMeta(db, 'device_id', id);
    return id;
  });
}
