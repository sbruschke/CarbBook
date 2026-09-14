import { describe, expect, it } from 'vitest';
import { addUser, makeTestApp } from './helpers';

describe('login rate limit', () => {
  it('allows 5 attempts per IP + username (case-insensitive) per 15 minutes', async () => {
    const { app, db } = await makeTestApp();
    await addUser(db, 'brett', 'owner');
    const attempt = (username: string) =>
      app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'wrong password' } });
    for (let i = 0; i < 5; i++) expect((await attempt('brett')).statusCode).toBe(401);
    const blocked = await attempt('Brett');
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error).toBe('rate_limited');
    expect((await attempt('kim')).statusCode).toBe(401);
  });

  it('keys on the client IP', async () => {
    const { app, db } = await makeTestApp();
    await addUser(db, 'brett', 'owner');
    const attempt = (remoteAddress: string) =>
      app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress, payload: { username: 'brett', password: 'wrong password' } });
    for (let i = 0; i < 5; i++) await attempt('10.0.0.1');
    expect((await attempt('10.0.0.1')).statusCode).toBe(429);
    expect((await attempt('10.0.0.2')).statusCode).toBe(401);
  });
});
