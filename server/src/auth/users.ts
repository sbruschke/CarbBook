import type { Db } from '../db';
import { hashPassword } from './passwords';

export type Role = 'owner' | 'viewer';

export interface User {
  id: number;
  username: string;
  role: Role;
}

export interface StoredUser extends User {
  password_hash: string;
}

export class UserError extends Error {}

const USERNAME_RE = /^[A-Za-z0-9_.-]{2,32}$/;
/** User decision 2026-09-14: allow short passwords (login rate limit is the main guard). */
export const MIN_PASSWORD_LENGTH = 6;

export async function createUser(
  db: Db,
  input: { username: string; password: string; role: Role },
  now: number,
): Promise<User> {
  if (!USERNAME_RE.test(input.username)) {
    throw new UserError('Username must be 2-32 characters: letters, digits, "_", "." or "-"');
  }
  if (input.password.length < MIN_PASSWORD_LENGTH) {
    throw new UserError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (input.role !== 'owner' && input.role !== 'viewer') {
    throw new UserError('Role must be "owner" or "viewer"');
  }
  if (findUserByUsername(db, input.username)) {
    throw new UserError(`User "${input.username}" already exists`);
  }
  const passwordHash = await hashPassword(input.password);
  const result = db
    .prepare('INSERT INTO user (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)')
    .run(input.username, passwordHash, input.role, now);
  return { id: Number(result.lastInsertRowid), username: input.username, role: input.role };
}

export function findUserByUsername(db: Db, username: string): StoredUser | undefined {
  return db
    .prepare('SELECT id, username, role, password_hash FROM user WHERE username = ?')
    .get(username) as StoredUser | undefined;
}

export function getUser(db: Db, id: number): User | undefined {
  return db.prepare('SELECT id, username, role FROM user WHERE id = ?').get(id) as User | undefined;
}
