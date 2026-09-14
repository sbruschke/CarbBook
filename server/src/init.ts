import { type Db, migrate, openDb } from './db';
import { seedDoseSettings } from './seed';

/** Open, migrate and seed. Use ':memory:' in tests. */
export function initDatabase(path: string): Db {
  const db = openDb(path);
  migrate(db);
  seedDoseSettings(db);
  return db;
}
