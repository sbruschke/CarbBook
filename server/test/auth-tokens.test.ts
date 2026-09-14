import { describe, expect, it } from 'vitest';
import { addUser, loginBearer, loginCookie, makeTestApp } from './helpers';

describe('bearer token management', () => {
  it('lists and revokes bearer tokens', async () => {
    const { app, db } = await makeTestApp();
    await addUser(db, 'brett', 'owner');
    const phone = await loginBearer(app, 'brett');
    const cookie = await loginCookie(app, 'brett');

    const list = await app.inject({ url: '/api/auth/tokens', headers: { cookie } });
    expect(list.statusCode).toBe(200);
    const tokens = list.json().tokens as { id: string; label: string }[];
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.label).toBe('Test iPhone');

    const revoke = await app.inject({ method: 'DELETE', url: `/api/auth/tokens/${tokens[0]!.id}`, headers: { cookie } });
    expect(revoke.statusCode).toBe(200);
    expect((await app.inject({ url: '/api/auth/me', headers: { authorization: phone } })).statusCode).toBe(401);
    const again = await app.inject({ method: 'DELETE', url: `/api/auth/tokens/${tokens[0]!.id}`, headers: { cookie } });
    expect(again.statusCode).toBe(404);
  });

  it("cannot revoke another user's token", async () => {
    const { app, db } = await makeTestApp();
    await addUser(db, 'brett', 'owner');
    await addUser(db, 'kim', 'viewer');
    const phone = await loginBearer(app, 'brett');
    const brettCookie = await loginCookie(app, 'brett');
    const kimCookie = await loginCookie(app, 'kim');
    const [token] = (await app.inject({ url: '/api/auth/tokens', headers: { cookie: brettCookie } })).json().tokens;
    const response = await app.inject({ method: 'DELETE', url: `/api/auth/tokens/${token.id}`, headers: { cookie: kimCookie } });
    expect(response.statusCode).toBe(404);
    expect((await app.inject({ url: '/api/auth/me', headers: { authorization: phone } })).statusCode).toBe(200);
  });
});
