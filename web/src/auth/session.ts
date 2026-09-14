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

export async function login(db: CarbBookDb, api: Api, username: string, password: string): Promise<User> {
  const { user } = await api.post<{ user: User }>('/api/auth/login', { username, password });
  await setMeta(db, 'user', user);
  return user;
}

/** Signs out locally even if the server is unreachable; returns whether the server session was revoked. */
export async function logout(db: CarbBookDb, api: Api): Promise<boolean> {
  let revoked = true;
  try {
    // Body `{}`: cookie-authenticated POSTs must be application/json (415 otherwise).
    await api.post('/api/auth/logout', {});
  } catch (error) {
    if (!(error instanceof NetworkError || (error instanceof ApiError && error.status === 401))) throw error;
    revoked = error instanceof ApiError;
  }
  await deleteMeta(db, 'user');
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
