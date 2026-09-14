import { describe, expect, it } from 'vitest';
import { addUser, loginBearer, loginCookie, makeTestApp } from './helpers';

describe('CSRF content-type guard on /api mutations', () => {
  it('rejects a text/plain POST to /api/auth/logout with a valid cookie, leaving the session valid', async () => {
    const { app, db } = await makeTestApp();
    await addUser(db, 'brett', 'owner');
    const cookie = await loginCookie(app, 'brett');

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie, 'content-type': 'text/plain' },
      payload: 'not json',
    });
    expect(response.statusCode).toBe(415);
    expect(response.json()).toHaveProperty('error');

    const me = await app.inject({ url: '/api/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
  });

  it('allows a JSON POST to /api/auth/logout with a valid cookie', async () => {
    const { app, db } = await makeTestApp();
    await addUser(db, 'brett', 'owner');
    const cookie = await loginCookie(app, 'brett');
    const response = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie }, payload: {} });
    expect(response.statusCode).toBe(200);
  });

  it('does not require a JSON content-type for bearer-authenticated requests', async () => {
    const { app, db } = await makeTestApp();
    await addUser(db, 'brett', 'owner');
    const authorization = await loginBearer(app, 'brett');
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/auth/tokens/does-not-exist',
      headers: { authorization, 'content-type': 'text/plain' },
      payload: 'ignored',
    });
    // Reached the route handler (404 for an unknown token id), not blocked at 415.
    expect(response.statusCode).toBe(404);
  });

  it('does not require a JSON content-type for non-mutating (GET) requests', async () => {
    const { app, db } = await makeTestApp();
    await addUser(db, 'brett', 'owner');
    const cookie = await loginCookie(app, 'brett');
    const response = await app.inject({ url: '/api/auth/me', headers: { cookie, 'content-type': 'text/plain' } });
    expect(response.statusCode).toBe(200);
  });
});
