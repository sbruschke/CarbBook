import { describe, expect, it } from 'vitest';
import { addUser, makeTestApp } from './helpers';

describe('client IP used for rate limiting', () => {
  it('a spoofed rotating X-Forwarded-For does not bypass the login rate limit when CF-Connecting-IP is fixed', async () => {
    const { app, db } = await makeTestApp({ env: { TRUST_PROXY: 'true' } });
    await addUser(db, 'brett', 'owner');
    const attempt = (xff: string) =>
      app.inject({
        method: 'POST',
        url: '/api/auth/login',
        remoteAddress: '10.10.10.10', // the cloudflared container's address on pi_net
        headers: { 'x-forwarded-for': xff, 'cf-connecting-ip': '203.0.113.5' },
        payload: { username: 'brett', password: 'wrong password' },
      });
    for (let i = 0; i < 5; i++) expect((await attempt(`1.2.3.${i}`)).statusCode).toBe(401);
    const blocked = await attempt('9.9.9.9');
    expect(blocked.statusCode).toBe(429);
  });

  it('ignores CF-Connecting-IP when TRUST_PROXY is off', async () => {
    const { app, db } = await makeTestApp();
    await addUser(db, 'brett', 'owner');
    const attempt = (cfIp: string) =>
      app.inject({
        method: 'POST',
        url: '/api/auth/login',
        remoteAddress: '10.0.0.5',
        headers: { 'cf-connecting-ip': cfIp },
        payload: { username: 'brett', password: 'wrong password' },
      });
    for (let i = 0; i < 5; i++) await attempt(`5.5.5.${i}`);
    // Same socket address throughout, so still rate limited despite a rotating CF-Connecting-IP.
    expect((await attempt('6.6.6.6')).statusCode).toBe(429);
  });
});
