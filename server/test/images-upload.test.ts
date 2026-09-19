import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { addUser, loginBearer, makeTestApp } from './helpers';

const png = () => sharp({ create: { width: 1200, height: 900, channels: 3, background: '#0a0' } }).png().toBuffer();

/**
 * These tests exercise the real ImageStore from defaultDeps, which writes bytes to IMAGE_DIR —
 * whose production default is /data/images. Point it at a throwaway directory per app.
 */
const tempImageDir = () => mkdtemp(join(tmpdir(), 'carbbook-images-'));

async function authed() {
  const { app, db } = await makeTestApp({ env: { IMAGE_DIR: await tempImageDir() } });
  await addUser(db, 'brett', 'owner');
  const authorization = await loginBearer(app, 'brett');
  return { app, db, authorization };
}

describe('POST /api/images/upload', () => {
  it('accepts base64 bytes, re-encodes to a capped JPEG and records source=upload', async () => {
    const { app, authorization } = await authed();
    const response = await app.inject({
      method: 'POST',
      url: '/api/images/upload',
      headers: { authorization },
      payload: { data_base64: (await png()).toString('base64'), mime: 'image/png' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      mime: 'image/jpeg',
      source: 'upload',
      source_url: null,
      license: null,
      attribution: null,
      width: 800,
      height: 600,
    });
  });

  it('rejects base64 that does not decode to an image', async () => {
    const { app, authorization } = await authed();
    const response = await app.inject({
      method: 'POST',
      url: '/api/images/upload',
      headers: { authorization },
      payload: { data_base64: Buffer.from('just text').toString('base64'), mime: 'image/jpeg' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a missing field, an unsupported mime, and extra properties', async () => {
    const { app, authorization } = await authed();
    const cases = [
      { mime: 'image/jpeg' },
      { data_base64: 'aGk=', mime: 'image/tiff' },
      { data_base64: 'aGk=', mime: 'image/jpeg', extra: true },
    ];
    for (const payload of cases) {
      expect((await app.inject({ method: 'POST', url: '/api/images/upload', headers: { authorization }, payload })).statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it('dedups: uploading the same photo twice yields one id and one row', async () => {
    const { app, db, authorization } = await authed();
    const data_base64 = (await png()).toString('base64');
    const send = () =>
      app.inject({ method: 'POST', url: '/api/images/upload', headers: { authorization }, payload: { data_base64, mime: 'image/png' } });
    const first = await send();
    const second = await send();
    expect(second.json().id).toBe(first.json().id);
    expect(db.prepare('SELECT count(*) AS n FROM image').get()).toEqual({ n: 1 });
  });

  it('requires authentication', async () => {
    const { app } = await makeTestApp({ env: { IMAGE_DIR: await tempImageDir() } });
    expect((await app.inject({ method: 'POST', url: '/api/images/upload', payload: { data_base64: 'aGk=', mime: 'image/jpeg' } })).statusCode).toBe(401);
  });
});
