import { afterEach, describe, expect, it } from 'vitest';
import { login, loginErrorMessage, logout, restoreSession } from '../src/auth/session';
import type { CarbBookDb } from '../src/db/db';
import { getMeta, setMeta } from '../src/db/meta';
import { ApiError, NetworkError } from '../src/lib/api';
import { FakeApi, openTestDb } from './helpers';

const brett = { id: 1, username: 'brett', role: 'owner' as const };

let db: CarbBookDb;
afterEach(async () => {
  await db.delete();
});

describe('restoreSession', () => {
  it('signs in from /api/auth/me and caches the user', async () => {
    db = openTestDb();
    const api = new FakeApi().on('GET', '/api/auth/me', () => ({ user: brett }));
    expect(await restoreSession(db, api)).toEqual({ status: 'signed_in', user: brett, offline: false });
    expect(await getMeta(db, 'user')).toEqual(brett);
  });

  it('signs out on 401 and forgets the cached user', async () => {
    db = openTestDb();
    await setMeta(db, 'user', brett);
    const api = new FakeApi().on('GET', '/api/auth/me', () => {
      throw new ApiError(401, 'unauthorized', 'Session expired or revoked');
    });
    expect(await restoreSession(db, api)).toEqual({ status: 'signed_out' });
    expect(await getMeta(db, 'user')).toBeUndefined();
  });

  it('uses the cached user when the server is unreachable', async () => {
    db = openTestDb();
    const api = new FakeApi().on('GET', '/api/auth/me', () => {
      throw new NetworkError('Failed to fetch');
    });
    expect(await restoreSession(db, api)).toEqual({ status: 'signed_out' });
    await setMeta(db, 'user', brett);
    expect(await restoreSession(db, api)).toEqual({ status: 'signed_in', user: brett, offline: true });
  });
});

describe('login and logout', () => {
  it('logs in and caches the user', async () => {
    db = openTestDb();
    const api = new FakeApi().on('POST', '/api/auth/login', () => ({ user: brett }));
    expect(await login(db, api, 'brett', 'pw')).toEqual(brett);
    expect(api.calls[0]!.body).toEqual({ username: 'brett', password: 'pw' });
    expect(await getMeta(db, 'user')).toEqual(brett);
  });

  it('describes login failures', () => {
    expect(loginErrorMessage(new ApiError(401, 'invalid_credentials', 'Wrong username or password'))).toBe('Wrong username or password');
    expect(loginErrorMessage(new ApiError(429, 'rate_limited', 'Too many login attempts, retry in 15 minutes'))).toBe(
      'Too many login attempts, retry in 15 minutes',
    );
    expect(loginErrorMessage(new NetworkError('Failed to fetch'))).toBe("Can't reach the server. Check your connection and try again.");
  });

  it('logs out with a JSON body, and still signs out locally when offline', async () => {
    db = openTestDb();
    await setMeta(db, 'user', brett);
    const api = new FakeApi().on('POST', '/api/auth/logout', () => ({ ok: true }));
    expect(await logout(db, api)).toBe(true);
    expect(api.calls[0]!.body).toEqual({});
    expect(await getMeta(db, 'user')).toBeUndefined();

    await setMeta(db, 'user', brett);
    api.on('POST', '/api/auth/logout', () => {
      throw new NetworkError('Failed to fetch');
    });
    expect(await logout(db, api)).toBe(false);
    expect(await getMeta(db, 'user')).toBeUndefined();
  });
});
