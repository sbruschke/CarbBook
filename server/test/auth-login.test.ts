import { describe, expect, it } from 'vitest';
import { SESSION_SLIDE_INTERVAL_MS, SESSION_TTL_MS } from '../src/auth/sessions';
import { addUser, loginBearer, loginCookie, makeTestApp, TEST_PASSWORD } from './helpers';

describe('POST /api/auth/login', () => {
  it('sets an httpOnly SameSite=Lax 30-day cookie for web clients', async () => {
    const { app, db } = await makeTestApp({ env: { COOKIE_SECURE: 'true' } });
    await addUser(db, 'brett', 'owner');
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'brett', password: TEST_PASSWORD },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ user: { id: 1, username: 'brett', role: 'owner' } });
    const cookie = response.cookies.find((c) => c.name === 'carbbook_session')!;
    expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: SESSION_TTL_MS / 1000 });
  });

  it('issues a bearer token for iOS clients', async () => {
    const { app, db } = await makeTestApp();
    await addUser(db, 'brett', 'owner');
    const authorization = await loginBearer(app, 'brett');
    const me = await app.inject({ url: '/api/auth/me', headers: { authorization } });
    expect(me.json()).toEqual({ user: { id: 1, username: 'brett', role: 'owner' } });
  });

  it('rejects wrong passwords and unknown users identically', async () => {
    const { app, db } = await makeTestApp();
    await addUser(db, 'brett', 'owner');
    for (const payload of [
      { username: 'brett', password: 'wrong password' },
      { username: 'ghost', password: 'wrong password' },
    ]) {
      const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: 'invalid_credentials', message: 'Wrong username or password' });
    }
  });

  it('validates the body', async () => {
    const { app } = await makeTestApp();
    const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'x' } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('invalid_request');
  });
});

describe('authenticated requests', () => {
  it('returns JSON 401 without credentials', async () => {
    const { app } = await makeTestApp();
    const response = await app.inject({ url: '/api/auth/me' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'unauthorized', message: 'Sign in required' });
  });

  it('slides cookie expiry after an hour and expires after 30 idle days', async () => {
    const { app, db, clock } = await makeTestApp();
    await addUser(db, 'brett', 'owner');
    const cookie = await loginCookie(app, 'brett');

    clock.advance(SESSION_SLIDE_INTERVAL_MS);
    const renewed = await app.inject({ url: '/api/auth/me', headers: { cookie } });
    expect(renewed.statusCode).toBe(200);
    expect(renewed.cookies.some((c) => c.name === 'carbbook_session')).toBe(true);

    clock.advance(SESSION_TTL_MS - 1);
    expect((await app.inject({ url: '/api/auth/me', headers: { cookie } })).statusCode).toBe(200);

    clock.advance(SESSION_TTL_MS);
    expect((await app.inject({ url: '/api/auth/me', headers: { cookie } })).statusCode).toBe(401);
  });

  it('logout revokes the session', async () => {
    const { app, db } = await makeTestApp();
    await addUser(db, 'brett', 'owner');
    const cookie = await loginCookie(app, 'brett');
    expect((await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/auth/me', headers: { cookie } })).statusCode).toBe(401);
  });
});
