import { describe, expect, it } from 'vitest';
import { BgUnavailableError, type BgClient } from '../src/bg/client';
import { addUser, loginCookie, makeTestApp, T0 } from './helpers';

describe('GET /api/bg', () => {
  it('returns the reading with age and freshness', async () => {
    const bg: BgClient = {
      latest: async () => ({ mgdl: 263, trend: 'FortyFiveUp', arrow: '↗', delta_mgdl: 6, read_at: T0 - 16 * 60_000 }),
    };
    const { app, db } = await makeTestApp({ deps: { bg } });
    await addUser(db, 'kim', 'viewer');
    const cookie = await loginCookie(app, 'kim');
    const response = await app.inject({ url: '/api/bg', headers: { cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      mgdl: 263,
      trend: 'FortyFiveUp',
      arrow: '↗',
      delta_mgdl: 6,
      read_at: T0 - 16 * 60_000,
      age_ms: 16 * 60_000,
      fresh: false,
    });
  });

  it('marks a 15-minute-old reading as fresh', async () => {
    const bg: BgClient = { latest: async () => ({ mgdl: 120, trend: null, arrow: null, delta_mgdl: null, read_at: T0 - 15 * 60_000 }) };
    const { app, db } = await makeTestApp({ deps: { bg } });
    await addUser(db, 'kim', 'viewer');
    const cookie = await loginCookie(app, 'kim');
    expect((await app.inject({ url: '/api/bg', headers: { cookie } })).json().fresh).toBe(true);
  });

  it('returns 503 bg_unavailable when dexcom-api fails', async () => {
    const bg: BgClient = { latest: () => Promise.reject(new BgUnavailableError('dexcom-api responded 500')) };
    const { app, db } = await makeTestApp({ deps: { bg } });
    await addUser(db, 'kim', 'viewer');
    const cookie = await loginCookie(app, 'kim');
    const response = await app.inject({ url: '/api/bg', headers: { cookie } });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'bg_unavailable', message: 'dexcom-api responded 500' });
  });

  it('treats a reading more than 2 minutes in the future as stale', async () => {
    const bg: BgClient = { latest: async () => ({ mgdl: 100, trend: null, arrow: null, delta_mgdl: null, read_at: T0 + 3 * 60_000 }) };
    const { app, db } = await makeTestApp({ deps: { bg } });
    await addUser(db, 'kim', 'viewer');
    const cookie = await loginCookie(app, 'kim');
    const response = await app.inject({ url: '/api/bg', headers: { cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json().fresh).toBe(false);
  });

  it('still treats a reading within 2 minutes in the future as fresh', async () => {
    const bg: BgClient = { latest: async () => ({ mgdl: 100, trend: null, arrow: null, delta_mgdl: null, read_at: T0 + 60_000 }) };
    const { app, db } = await makeTestApp({ deps: { bg } });
    await addUser(db, 'kim', 'viewer');
    const cookie = await loginCookie(app, 'kim');
    const response = await app.inject({ url: '/api/bg', headers: { cookie } });
    expect(response.json().fresh).toBe(true);
  });

  it('requires auth', async () => {
    const { app } = await makeTestApp();
    expect((await app.inject({ url: '/api/bg' })).statusCode).toBe(401);
  });
});
