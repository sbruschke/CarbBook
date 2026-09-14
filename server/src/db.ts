import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Db = Database.Database;

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

export function openDb(path: string): Db {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

/** Applies `NNN_name.sql` files newer than `PRAGMA user_version`, each in its own transaction. */
export function migrate(db: Db, dir: string = MIGRATIONS_DIR): number {
  const files = readdirSync(dir)
    .filter((file) => /^\d{3}_[\w-]+\.sql$/.test(file))
    .sort();
  let version = db.pragma('user_version', { simple: true }) as number;
  for (const file of files) {
    const target = Number(file.slice(0, 3));
    if (target <= version) continue;
    const sql = readFileSync(join(dir, file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${target}`);
    })();
    version = target;
  }
  return version;
}

/** Next global sync sequence number. Call inside the transaction that writes the row. */
export function nextServerSeq(db: Db): number {
  const row = db.prepare('UPDATE seq_counter SET value = value + 1 WHERE id = 1 RETURNING value').get() as {
    value: number;
  };
  return row.value;
}

export function currentServerSeq(db: Db): number {
  return (db.prepare('SELECT value FROM seq_counter WHERE id = 1').get() as { value: number }).value;
}
