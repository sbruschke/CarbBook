import { describe, expect, it } from 'vitest';
import type { AppDeps } from '../src/context';
import type { ImageCandidate, ImageSearchProvider } from '../src/images/providers/types';
import { ProviderUnavailableError } from '../src/images/providers/types';
import type { ImageStore } from '../src/images/store';
import { addUser, loginBearer, makeTestApp } from './helpers';

const HASH = 'a'.repeat(64);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

const candidate: ImageCandidate = {
  provider: 'openverse',
  thumb_url: 'https://api.openverse.org/v1/images/x/thumb/',
  full_url: 'https://api.openverse.org/v1/images/x/thumb/?full_size=true',
  width: 800,
  height: 600,
  license: 'CC-BY-4.0',
  attribution: 'Someone (CC-BY-4.0)',
  title: 'Soup',
};

const provider = (name: ImageCandidate['provider'], results: ImageCandidate[]): ImageSearchProvider => ({
  name,
  search: async () => results,
});

/**
 * A complete ImageStore whose parts can be overridden one at a time. `read` returns a Buffer
 * rather than a stream because reply.send accepts either, and a Buffer keeps the test synchronous.
 */
function stubStore(overrides: Partial<ImageStore> = {}): ImageStore {
  return {
    has: async () => true,
    read: () => Buffer.from(JPEG) as unknown as ReturnType<ImageStore['read']>,
    pathFor: () => '/tmp/x.jpg',
    put: async () => {
      throw new Error('put is not exercised by these tests');
    },
    remove: async () => {},
    ...overrides,
  };
}

/** Every /api/images/* route sits inside the authenticated scope, so most tests need a token. */
async function authed(deps: Partial<AppDeps>) {
  const t = await makeTestApp({ deps });
  await addUser(t.db, 'brett', 'owner');
  const authorization = await loginBearer(t.app, 'brett');
  return { ...t, headers: { authorization } };
}

describe('GET /api/images/:hash', () => {
  it('streams stored bytes with an immutable cache header', async () => {
    const { app, headers } = await authed({ images: stubStore({ has: async (hash) => hash === HASH }) });
    const response = await app.inject({ method: 'GET', url: `/api/images/${HASH}`, headers });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('image/jpeg');
    expect(response.headers['cache-control']).toBe('private, max-age=31536000, immutable');
    expect(response.rawPayload.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  });

  it('404s an unknown hash and rejects a malformed one without touching the store', async () => {
    let touched = false;
    const { app, headers } = await authed({
      images: stubStore({
        has: async () => {
          touched = true;
          return false;
        },
      }),
    });

    expect((await app.inject({ method: 'GET', url: `/api/images/${'b'.repeat(64)}`, headers })).statusCode).toBe(404);
    expect(touched).toBe(true);

    touched = false;
    expect((await app.inject({ method: 'GET', url: `/api/images/${'A'.repeat(64)}`, headers })).statusCode).toBe(400);
    expect(touched).toBe(false);

    // A percent-encoded traversal reaches the parametric route with the escapes decoded, so the
    // hash pattern — not the HTTP layer's path normalisation — is what turns it away.
    expect(
      (await app.inject({ method: 'GET', url: '/api/images/%2e%2e%2f%2e%2e%2fetc%2fpasswd', headers })).statusCode,
    ).toBe(400);
    expect(touched).toBe(false);
  });

  it('requires authentication', async () => {
    const { app } = await makeTestApp();
    expect((await app.inject({ method: 'GET', url: `/api/images/${HASH}` })).statusCode).toBe(401);
  });
});

describe('GET /api/images/search', () => {
  it('returns candidates', async () => {
    const { app, headers } = await authed({ imageProviders: [provider('openverse', [candidate])] });
    const response = await app.inject({ method: 'GET', url: '/api/images/search?q=tomato%20soup', headers });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ candidates: [candidate], providers_failed: [] });
  });

  it('reports a failed provider with 200', async () => {
    const broken: ImageSearchProvider = {
      name: 'wikimedia',
      search: async () => {
        throw new ProviderUnavailableError('wikimedia', 'responded 429');
      },
    };
    const { app, headers } = await authed({ imageProviders: [provider('openverse', [candidate]), broken] });
    const response = await app.inject({ method: 'GET', url: '/api/images/search?q=soup', headers });
    expect(response.statusCode).toBe(200);
    expect(response.json().providers_failed).toEqual(['wikimedia']);
  });

  it('rejects a missing or over-long query and an out-of-range limit', async () => {
    const { app, headers } = await authed({ imageProviders: [provider('openverse', [candidate])] });
    expect((await app.inject({ method: 'GET', url: '/api/images/search', headers })).statusCode).toBe(400);
    expect(
      (await app.inject({ method: 'GET', url: `/api/images/search?q=${'x'.repeat(201)}`, headers })).statusCode,
    ).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/images/search?q=soup&limit=99', headers })).statusCode).toBe(
      400,
    );
  });

  it('is not shadowed by the :hash route', async () => {
    // "search" is not a 64-char hex string, so the parametric route must not claim it.
    const { app, headers } = await authed({ imageProviders: [provider('openverse', [candidate])] });
    const response = await app.inject({ method: 'GET', url: '/api/images/search?q=soup', headers });
    expect(response.statusCode).toBe(200);
  });

  it('requires authentication', async () => {
    const { app } = await makeTestApp();
    expect((await app.inject({ method: 'GET', url: '/api/images/search?q=soup' })).statusCode).toBe(401);
  });
});
