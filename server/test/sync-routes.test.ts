import { describe, expect, it } from 'vitest';
import { addUser, loginBearer, loginCookie, makeTestApp } from './helpers';
import { doseSettings, food } from './sync-helpers';

describe('sync routes', () => {
  it('pushes with a cookie and pulls with a bearer token', async () => {
    const { app, db } = await makeTestApp();
    await addUser(db, 'brett', 'owner');
    const cookie = await loginCookie(app, 'brett');
    const authorization = await loginBearer(app, 'brett');

    const push = await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      headers: { cookie },
      payload: { changes: [{ table: 'food', record: food({ id: 'f1' }) }] },
    });
    expect(push.statusCode).toBe(200);
    expect(push.json()).toEqual({ results: [{ table: 'food', id: 'f1', status: 'accepted', server_seq: 2 }], server_seq: 2 });

    const pull = await app.inject({ url: '/api/sync/pull?since=1&limit=10', headers: { authorization } });
    expect(pull.statusCode).toBe(200);
    expect(pull.json()).toMatchObject({ next_since: 2, has_more: false, changes: [{ table: 'food', record: { id: 'f1', server_seq: 2 } }] });
  });

  it('reports viewer dose_settings pushes as rejected records (HTTP 200)', async () => {
    const { app, db } = await makeTestApp();
    await addUser(db, 'kim', 'viewer');
    const cookie = await loginCookie(app, 'kim');
    const response = await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      headers: { cookie },
      payload: { changes: [{ table: 'dose_settings', record: doseSettings({ id: 'd1' }) }] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().results[0]).toMatchObject({ status: 'rejected', reason: 'forbidden' });
  });

  it('validates the envelope and query', async () => {
    const { app, db } = await makeTestApp();
    await addUser(db, 'brett', 'owner');
    const cookie = await loginCookie(app, 'brett');
    const tooMany = Array.from({ length: 501 }, () => ({ table: 'food', record: food() }));
    for (const payload of [{}, { changes: 'nope' }, { changes: tooMany }]) {
      const response = await app.inject({ method: 'POST', url: '/api/sync/push', headers: { cookie }, payload });
      expect(response.statusCode).toBe(400);
    }
    expect((await app.inject({ url: '/api/sync/pull?since=-1', headers: { cookie } })).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/sync/pull?limit=5000', headers: { cookie } })).statusCode).toBe(400);
  });

  it('requires auth', async () => {
    const { app } = await makeTestApp();
    expect((await app.inject({ url: '/api/sync/pull' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/sync/push', payload: { changes: [] } })).statusCode).toBe(401);
  });
});
