import { describe, expect, it } from 'vitest';
import { BgUnavailableError, type BgClient } from '../src/bg/client';
import { addUser, loginCookie, makeTestApp, T0, unusedBg } from './helpers';

describe('GET /api/bg', () => {
  it('returns the reading with age and freshness', async () => {
    const bg: BgClient = { ...unusedBg,
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
    const bg: BgClient = { ...unusedBg, latest: async () => ({ mgdl: 120, trend: null, arrow: null, delta_mgdl: null, read_at: T0 - 15 * 60_000 }) };
    const { app, db } = await makeTestApp({ deps: { bg } });
    await addUser(db, 'kim', 'viewer');
    const cookie = await loginCookie(app, 'kim');
    expect((await app.inject({ url: '/api/bg', headers: { cookie } })).json().fresh).toBe(true);
  });

  it('returns 503 bg_unavailable when dexcom-api fails', async () => {
    const bg: BgClient = { ...unusedBg, latest: () => Promise.reject(new BgUnavailableError('dexcom-api responded 500')) };
    const { app, db } = await makeTestApp({ deps: { bg } });
    await addUser(db, 'kim', 'viewer');
    const cookie = await loginCookie(app, 'kim');
    const response = await app.inject({ url: '/api/bg', headers: { cookie } });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'bg_unavailable', message: 'dexcom-api responded 500' });
  });

  it('treats a reading more than 2 minutes in the future as stale', async () => {
    const bg: BgClient = { ...unusedBg, latest: async () => ({ mgdl: 100, trend: null, arrow: null, delta_mgdl: null, read_at: T0 + 3 * 60_000 }) };
    const { app, db } = await makeTestApp({ deps: { bg } });
    await addUser(db, 'kim', 'viewer');
    const cookie = await loginCookie(app, 'kim');
    const response = await app.inject({ url: '/api/bg', headers: { cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json().fresh).toBe(false);
  });

  it('still treats a reading within 2 minutes in the future as fresh', async () => {
    const bg: BgClient = { ...unusedBg, latest: async () => ({ mgdl: 100, trend: null, arrow: null, delta_mgdl: null, read_at: T0 + 60_000 }) };
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

describe('GET /api/bg/readings', () => {
  const H = 3_600_000;
  it('returns the stored range for any signed-in user', async () => {
    const calls: [number, number][] = [];
    const bg: BgClient = {
      ...unusedBg,
      range: async (from, to) => {
        calls.push([from, to]);
        return { readings: [{ at: T0 - H, mgdl: 140 }], earliest_at: T0 - 24 * H };
      },
    };
    const { app, db } = await makeTestApp({ deps: { bg } });
    await addUser(db, 'kim', 'viewer');
    const cookie = await loginCookie(app, 'kim');
    const response = await app.inject({ url: `/api/bg/readings?from=${T0 - 2 * H}&to=${T0}`, headers: { cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ readings: [{ at: T0 - H, mgdl: 140 }], earliest_at: T0 - 24 * H });
    expect(calls).toEqual([[T0 - 2 * H, T0]]);
  });

  it('rejects a missing, backwards or too-long range', async () => {
    const { app, db } = await makeTestApp({});
    await addUser(db, 'kim', 'viewer');
    const cookie = await loginCookie(app, 'kim');
    for (const query of ['', `from=${T0}&to=${T0}`, `from=${T0}&to=${T0 - 1}`, `from=0&to=${93 * 24 * H}`, 'from=a&to=b']) {
      const response = await app.inject({ url: `/api/bg/readings?${query}`, headers: { cookie } });
      expect(response.statusCode, query).toBe(400);
    }
  });

  it('is 503 when dexcom-api is down', async () => {
    const bg: BgClient = { ...unusedBg, range: () => Promise.reject(new BgUnavailableError('dexcom-api responded 502')) };
    const { app, db } = await makeTestApp({ deps: { bg } });
    await addUser(db, 'kim', 'viewer');
    const cookie = await loginCookie(app, 'kim');
    expect((await app.inject({ url: `/api/bg/readings?from=${T0 - H}&to=${T0}`, headers: { cookie } })).statusCode).toBe(503);
  });

  it('needs a session', async () => {
    const { app } = await makeTestApp({});
    expect((await app.inject({ url: `/api/bg/readings?from=${T0 - H}&to=${T0}` })).statusCode).toBe(401);
  });
});
