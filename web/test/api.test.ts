import { describe, expect, it } from 'vitest';
import { ApiError, createApi, type Fetch, NetworkError } from '../src/lib/api';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function recordingFetch(response: () => Response | Promise<Response>) {
  const calls: [string, RequestInit][] = [];
  const fetchImpl: Fetch = async (input, init) => {
    calls.push([input, init]);
    return response();
  };
  return { calls, fetchImpl };
}

describe('createApi', () => {
  it('GETs JSON with same-origin credentials', async () => {
    const { calls, fetchImpl } = recordingFetch(() => json(200, { ok: true }));
    expect(await createApi(fetchImpl).get('/api/health')).toEqual({ ok: true });
    expect(calls).toEqual([['/api/health', { method: 'GET', credentials: 'same-origin' }]]);
  });

  it('POSTs JSON bodies', async () => {
    const { calls, fetchImpl } = recordingFetch(() => json(200, { user: { id: 1 } }));
    await createApi(fetchImpl).post('/api/auth/login', { username: 'brett', password: 'pw' });
    expect(calls[0]![1]).toEqual({
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: '{"username":"brett","password":"pw"}',
    });
  });

  it('always sends a JSON content type, even for bodyless actions like logout', async () => {
    // Cookie-authenticated POSTs without Content-Type: application/json get 415 from the server.
    const { calls, fetchImpl } = recordingFetch(() => json(200, { ok: true }));
    await createApi(fetchImpl).post('/api/auth/logout', {});
    expect(calls[0]![1]).toMatchObject({ headers: { 'content-type': 'application/json' }, body: '{}' });
  });

  it('maps { error, message } bodies to ApiError', async () => {
    const { fetchImpl } = recordingFetch(() => json(401, { error: 'unauthorized', message: 'Sign in required' }));
    const error = await createApi(fetchImpl).get('/api/auth/me').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 401, code: 'unauthorized', message: 'Sign in required' });
  });

  it('uses http_error for non-JSON error pages', async () => {
    const { fetchImpl } = recordingFetch(() => new Response('<html>Bad gateway</html>', { status: 502 }));
    await expect(createApi(fetchImpl).get('/api/sync/pull')).rejects.toMatchObject({
      status: 502,
      code: 'http_error',
      message: 'HTTP 502',
    });
  });

  it('wraps fetch failures in NetworkError', async () => {
    const fetchImpl: Fetch = () => Promise.reject(new TypeError('Failed to fetch'));
    const error = await createApi(fetchImpl).get('/api/bg').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NetworkError);
    expect((error as Error).message).toBe('Failed to fetch');
  });

  it('reads binary bodies', async () => {
    const { fetchImpl } = recordingFetch(() => new Response(new Uint8Array([31, 139, 8])));
    const bytes = await createApi(fetchImpl).getBytes('/api/usda/files/usda-fdc-1.json.gz');
    expect(Array.from(new Uint8Array(bytes))).toEqual([31, 139, 8]);
  });
});
