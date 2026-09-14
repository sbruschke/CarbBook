import type { CarbBookDb } from '../db/db';
import { deleteMeta, getMeta, setMeta } from '../db/meta';
import { type Api, ApiError, NetworkError } from '../lib/api';
import type { User } from '../lib/wire';

export type Session =
  | { status: 'signed_in'; user: User; /** true when the server could not be reached */ offline: boolean }
  | { status: 'signed_out' };

/**
 * Checks the session cookie with `/api/auth/me`. When the server is unreachable the last
 * signed-in user is used so the app works offline; a 401 signs out (local data is kept).
 */
export async function restoreSession(db: CarbBookDb, api: Api): Promise<Session> {
  try {
    const { user } = await api.get<{ user: User }>('/api/auth/me');
    await setMeta(db, 'user', user);
    return { status: 'signed_in', user, offline: false };
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      await deleteMeta(db, 'user');
      return { status: 'signed_out' };
    }
    const cached = await getMeta(db, 'user');
    return cached ? { status: 'signed_in', user: cached, offline: true } : { status: 'signed_out' };
  }
}

export interface LoginResult {
  user: User;
  /**
   * True when a different user was cached locally and the outbox still holds unsynced changes
   * from them. The new user's `/api/auth/me` cookie is live, but the cached local `user` (and the
   * outbox) is intentionally left alone so the old user's queued edits are never pushed under the
   * new session; the caller must let the original user sign back in (to flush the outbox) or
   * explicitly discard those changes before proceeding as the new user.
   */
  outboxConflict: boolean;
}

export async function login(db: CarbBookDb, api: Api, username: string, password: string): Promise<LoginResult> {
  const { user } = await api.post<{ user: User }>('/api/auth/login', { username, password });
  const cached = await getMeta(db, 'user');
  const pending = await db.outbox.count();
  const outboxConflict = cached !== undefined && cached.id !== user.id && pending > 0;
  if (!outboxConflict) await setMeta(db, 'user', user);
  return { user, outboxConflict };
}

/** Signs out locally even if the server is unreachable; returns whether the server session was revoked. */
export async function logout(db: CarbBookDb, api: Api): Promise<boolean> {
  let revoked = true;
  try {
    // Body `{}`: cookie-authenticated POSTs must be application/json (415 otherwise).
    await api.post('/api/auth/logout', {});
  } catch (error) {
    const recoverable = error instanceof NetworkError || (error instanceof ApiError && (error.status === 401 || error.status >= 500));
    if (!recoverable) throw error;
    revoked = error instanceof ApiError && error.status === 401;
  } finally {
    // Always clear the cached local identity on a logout attempt, even on a 5xx/network failure,
    // so a stale user is never left signed in locally after the user asked to sign out.
    await deleteMeta(db, 'user');
  }
  return revoked;
}

export function loginErrorMessage(error: unknown): string {
  if (error instanceof NetworkError) return "Can't reach the server. Check your connection and try again.";
  if (error instanceof ApiError) {
    if (error.code === 'invalid_credentials') return 'Wrong username or password';
    return error.message;
  }
  return 'Sign-in failed';
}
