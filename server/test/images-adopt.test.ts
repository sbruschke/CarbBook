import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { addUser, loginBearer, makeTestApp } from './helpers';
import type { AppDeps } from '../src/context';

const OK_URL = 'https://api.openverse.org/v1/images/x/thumb/?full_size=true';
const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];

const jpeg = () => sharp({ create: { width: 400, height: 300, channels: 3, background: '#c00' } }).jpeg().toBuffer();

function body(overrides: Record<string, unknown> = {}) {
  return {
    url: OK_URL,
    source: 'openverse',
    source_url: OK_URL,
    license: 'CC-BY-4.0',
    attribution: 'Someone (CC-BY-4.0)',
    ...overrides,
  };
}

/**
 * Adopt stubs fetchImage but keeps the real ImageStore, which writes bytes to IMAGE_DIR — whose
 * production default is /data/images. Every app here gets a throwaway directory instead.
 */
const tempImageDir = () => mkdtemp(join(tmpdir(), 'carbbook-images-'));

async function authed(deps: Partial<AppDeps>) {
  const { app, db, clock } = await makeTestApp({
    env: { IMAGE_DIR: await tempImageDir() },
    deps: { dnsLookup: publicDns, ...deps },
  });
  await addUser(db, 'brett', 'owner');
  const authorization = await loginBearer(app, 'brett');
  return { app, db, clock, authorization };
}

describe('POST /api/images/adopt', () => {
  it('stores the bytes and returns the image row, writing no food', async () => {
    const bytes = await jpeg();
    const { app, db, authorization } = await authed({ fetchImage: async () => bytes });
    const response = await app.inject({ method: 'POST', url: '/api/images/adopt', headers: { authorization }, payload: body() });

    expect(response.statusCode).toBe(200);
    const image = response.json();
    expect(image.id).toMatch(/^[0-9a-f]{64}$/);
    expect(image).toMatchObject({ mime: 'image/jpeg', source: 'openverse', license: 'CC-BY-4.0', width: 400, height: 300 });
    // The row really landed in the database, with a server_seq so it will sync.
    const row = db.prepare('SELECT * FROM image WHERE id = ?').get(image.id) as Record<string, unknown>;
    expect(row.server_seq).toBeTypeOf('number');
    expect(db.prepare('SELECT count(*) AS n FROM food').get()).toEqual({ n: 0 });
  });

  it('is a no-op returning the existing row when the hash already exists', async () => {
    const bytes = await jpeg();
    const { app, authorization } = await authed({ fetchImage: async () => bytes });
    const send = (payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: '/api/images/adopt', headers: { authorization }, payload });

    const first = await send(body());
    // A second adopt with different metadata must not overwrite the first attribution.
    const second = await send(body({ attribution: 'Someone Else', license: 'CC0-1.0' }));
    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(first.json().id);
    expect(second.json().attribution).toBe('Someone (CC-BY-4.0)');
  });

  it('revives a soft-deleted row rather than failing last-write-wins', async () => {
    const bytes = await jpeg();
    const { app, db, authorization } = await authed({ fetchImage: async () => bytes });
    const send = () => app.inject({ method: 'POST', url: '/api/images/adopt', headers: { authorization }, payload: body() });

    const id = (await send()).json().id as string;
    // A client deletes the row later than the clock the route will use for the re-adopt, which is
    // exactly the case where a naive now() would lose last-write-wins and be ignored.
    db.prepare('UPDATE image SET deleted = 1, updated_at = updated_at + 60000, updated_by = ? WHERE id = ?').run('zzz-device', id);

    const response = await send();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id, deleted: 0 });
    expect(db.prepare('SELECT deleted FROM image WHERE id = ?').get(id)).toEqual({ deleted: 0 });
  });

  it('rejects every unsafe URL shape', async () => {
    const bytes = await jpeg();
    let fetched = 0;
    const { app, authorization } = await authed({
      fetchImage: async () => {
        fetched += 1;
        return bytes;
      },
    });
    const unsafe = [
      { url: 'http://api.openverse.org/x.jpg' },
      { url: 'https://user:pass@api.openverse.org/x.jpg' },
      { url: 'https://api.openverse.org:8443/x.jpg' },
      { url: 'https://127.0.0.1/x.jpg' },
      { url: 'https://192.168.1.210/x.jpg' },
      { url: 'https://169.254.169.254/latest/meta-data/' },
      { url: 'https://api.openverse.org.evil.test/x.jpg' },
      { url: 'file:///etc/passwd' },
      { url: 'not a url' },
      // Right shape, wrong provider for that host.
      { url: 'https://upload.wikimedia.org/x.jpg', source: 'openverse' },
    ];
    for (const overrides of unsafe) {
      const response = await app.inject({ method: 'POST', url: '/api/images/adopt', headers: { authorization }, payload: body(overrides) });
      expect(response.statusCode, JSON.stringify(overrides)).toBe(400);
    }
    // Nothing unsafe was ever fetched.
    expect(fetched).toBe(0);
  });

  it('rejects an allowlisted host that resolves to a private address', async () => {
    const bytes = await jpeg();
    const { app, authorization } = await authed({
      fetchImage: async () => bytes,
      dnsLookup: async () => [{ address: '10.0.0.5', family: 4 }],
    });
    const response = await app.inject({ method: 'POST', url: '/api/images/adopt', headers: { authorization }, payload: body() });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a non-image body even when the host claimed an image', async () => {
    const { app, authorization } = await authed({ fetchImage: async () => Buffer.from('<!doctype html><html>404</html>') });
    const response = await app.inject({ method: 'POST', url: '/api/images/adopt', headers: { authorization }, payload: body() });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('image_rejected');
  });

  it('surfaces an unreachable host as 502, not 500', async () => {
    const { app, authorization } = await authed({
      fetchImage: async () => {
        throw new Error('socket hang up');
      },
    });
    const response = await app.inject({ method: 'POST', url: '/api/images/adopt', headers: { authorization }, payload: body() });
    expect(response.statusCode).toBe(502);
  });

  it('rejects an unknown source, the upload source, and extra properties', async () => {
    const bytes = await jpeg();
    const { app, authorization } = await authed({ fetchImage: async () => bytes });
    const cases = [body({ source: 'pinterest' }), body({ source: 'upload' }), { ...body(), sneaky: 1 }];
    for (const payload of cases) {
      expect((await app.inject({ method: 'POST', url: '/api/images/adopt', headers: { authorization }, payload })).statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it('requires authentication', async () => {
    const { app } = await makeTestApp({ env: { IMAGE_DIR: await tempImageDir() }, deps: { dnsLookup: publicDns } });
    expect((await app.inject({ method: 'POST', url: '/api/images/adopt', payload: body() })).statusCode).toBe(401);
  });

  it('requires application/json for a cookie session (CSRF guard)', async () => {
    const bytes = await jpeg();
    const { app } = await authed({ fetchImage: async () => bytes });
    const response = await app.inject({
      method: 'POST',
      url: '/api/images/adopt',
      headers: { 'content-type': 'text/plain' },
      payload: 'url=whatever',
    });
    expect(response.statusCode).toBe(415);
  });
});
