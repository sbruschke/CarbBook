import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '../db';
import type { User } from './users';

export type SessionKind = 'cookie' | 'bearer';

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Sliding expiry is refreshed at most once per hour to avoid a write on every request. */
export const SESSION_SLIDE_INTERVAL_MS = 60 * 60 * 1000;

export interface SessionRow {
  id: string;
  user_id: number;
  kind: SessionKind;
  label: string | null;
  created_at: number;
  last_used_at: number;
  expires_at: number | null;
}

export interface ResolvedSession {
  session: SessionRow;
  user: User;
  /** True when the expiry was pushed forward; cookie sessions should re-send the cookie. */
  renewed: boolean;
}

export function sessionIdForToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createSession(
  db: Db,
  input: { userId: number; kind: SessionKind; label: string | null },
  now: number,
): { token: string; id: string } {
  const token = randomBytes(32).toString('base64url');
  const id = sessionIdForToken(token);
  const expiresAt = input.kind === 'cookie' ? now + SESSION_TTL_MS : null;
  db.prepare(
    'INSERT INTO auth_session (id, user_id, kind, label, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, input.userId, input.kind, input.label, now, now, expiresAt);
  return { token, id };
}

export function resolveSession(db: Db, token: string, now: number): ResolvedSession | null {
  const row = db
    .prepare(
      `SELECT s.id, s.user_id, s.kind, s.label, s.created_at, s.last_used_at, s.expires_at,
              u.username, u.role
         FROM auth_session s JOIN user u ON u.id = s.user_id
        WHERE s.id = ?`,
    )
    .get(sessionIdForToken(token)) as (SessionRow & { username: string; role: User['role'] }) | undefined;
  if (!row) return null;
  if (row.expires_at !== null && row.expires_at <= now) {
    db.prepare('DELETE FROM auth_session WHERE id = ?').run(row.id);
    return null;
  }
  const { username, role, ...session } = row;
  let renewed = false;
  if (now - session.last_used_at >= SESSION_SLIDE_INTERVAL_MS) {
    session.last_used_at = now;
    session.expires_at = session.kind === 'cookie' ? now + SESSION_TTL_MS : null;
    db.prepare('UPDATE auth_session SET last_used_at = ?, expires_at = ? WHERE id = ?').run(
      session.last_used_at,
      session.expires_at,
      session.id,
    );
    renewed = true;
  }
  return { session, user: { id: session.user_id, username, role }, renewed };
}

export function revokeSession(db: Db, id: string, userId: number): boolean {
  return db.prepare('DELETE FROM auth_session WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
}

export function listBearerTokens(db: Db, userId: number): Omit<SessionRow, 'user_id' | 'kind' | 'expires_at'>[] {
  return db
    .prepare(
      `SELECT id, label, created_at, last_used_at FROM auth_session
        WHERE user_id = ? AND kind = 'bearer' ORDER BY created_at DESC`,
    )
    .all(userId) as Omit<SessionRow, 'user_id' | 'kind' | 'expires_at'>[];
}
