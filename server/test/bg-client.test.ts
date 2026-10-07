import { describe, expect, it } from 'vitest';
import { BgUnavailableError, createDexcomApiClient } from '../src/bg/client';

const READ_AT_S = 1789405200;

/** Shape of dexcom-api GET /glucose?history=0 (~/HomelabServer/dexcom-api/app.py `_render`). */
const DEXCOM_OK = {
  ok: true,
  error: null,
  value: 142,
  display: '142',
  unit: 'mg/dL',
  mgdl: 142,
  mmol: 7.9,
  arrow: '→',
  trend: 4,
  trend_direction: 'Flat',
  trend_description: 'steady',
  delta: -3,
  delta_display: '-3',
  timestamp: '2026-09-14T11:55:00-05:00',
  epoch: READ_AT_S,
  minutes_ago: 5,
  stale: false,
};

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return handler(String(input), init);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

describe('createDexcomApiClient', () => {
  it('requests /glucose?history=0 with the bearer token and maps the payload', async () => {
    const { fetch, calls } = stubFetch(() => Response.json(DEXCOM_OK));
    const client = createDexcomApiClient({ baseUrl: 'http://dexcom-api:8000', token: 'tok', timeoutMs: 5000, fetch });
    expect(await client.latest()).toEqual({ mgdl: 142, trend: 'Flat', arrow: '→', delta_mgdl: -3, read_at: READ_AT_S * 1000 });
    expect(calls[0]!.url).toBe('http://dexcom-api:8000/glucose?history=0');
    expect(new Headers(calls[0]!.init?.headers).get('authorization')).toBe('Bearer tok');
  });

  it('drops delta when dexcom-api is configured for mmol', async () => {
    const { fetch } = stubFetch(() => Response.json({ ...DEXCOM_OK, unit: 'mmol/L', delta: -0.2 }));
    const client = createDexcomApiClient({ baseUrl: 'http://x', token: null, timeoutMs: 5000, fetch });
    expect((await client.latest()).delta_mgdl).toBeNull();
  });

  it('maps network errors, HTTP errors and ok:false to BgUnavailableError', async () => {
    const cases: (() => Response)[] = [
      () => {
        throw new TypeError('fetch failed');
      },
      () => new Response('nope', { status: 401 }),
      () => Response.json({ ok: false, error: 'no readings in the last 3 hours' }),
    ];
    for (const handler of cases) {
      const { fetch } = stubFetch(handler);
      const client = createDexcomApiClient({ baseUrl: 'http://x', token: null, timeoutMs: 5000, fetch });
      await expect(client.latest()).rejects.toBeInstanceOf(BgUnavailableError);
    }
  });

  it('maps a non-JSON upstream body to BgUnavailableError instead of throwing', async () => {
    const { fetch } = stubFetch(() => new Response('<html>not json</html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    const client = createDexcomApiClient({ baseUrl: 'http://x', token: null, timeoutMs: 5000, fetch });
    await expect(client.latest()).rejects.toBeInstanceOf(BgUnavailableError);
  });

  it('maps a null upstream body to BgUnavailableError instead of throwing', async () => {
    const { fetch } = stubFetch(() => Response.json(null));
    const client = createDexcomApiClient({ baseUrl: 'http://x', token: null, timeoutMs: 5000, fetch });
    await expect(client.latest()).rejects.toBeInstanceOf(BgUnavailableError);
  });
});

describe('createDexcomApiClient range', () => {
  it('asks /readings in whole seconds with the token, maps to ms and drops malformed rows', async () => {
    const { fetch, calls } = stubFetch(() =>
      Response.json({
        ok: true,
        earliest_epoch: 1000,
        readings: [
          { epoch: 2000, mgdl: 120, trend: 'Flat' },
          { epoch: 2300, mgdl: 'x' },
          { epoch: 2600, mgdl: 0 },
          null,
          { epoch: 2900, mgdl: 131 },
        ],
      }),
    );
    const client = createDexcomApiClient({ baseUrl: 'http://dexcom-api:8000', token: 'tok', timeoutMs: 5000, fetch });
    expect(await client.range(1_999_500, 3_000_000)).toEqual({
      readings: [
        { at: 2_000_000, mgdl: 120 },
        { at: 2_900_000, mgdl: 131 },
      ],
      earliest_at: 1_000_000,
    });
    expect(calls[0]!.url).toBe('http://dexcom-api:8000/readings?from=1999&to=3000');
    expect((calls[0]!.init!.headers as Record<string, string>).authorization).toBe('Bearer tok');
  });

  it('rejects with BgUnavailableError on an error payload or HTTP failure', async () => {
    const bad = createDexcomApiClient({ baseUrl: 'http://x', token: null, timeoutMs: 5000, fetch: stubFetch(() => Response.json({ ok: false, error: 'range must be positive' })).fetch });
    await expect(bad.range(0, 1000)).rejects.toThrow(new BgUnavailableError('range must be positive'));
    const down = createDexcomApiClient({ baseUrl: 'http://x', token: null, timeoutMs: 5000, fetch: stubFetch(() => new Response('', { status: 502 })).fetch });
    await expect(down.range(0, 1000)).rejects.toBeInstanceOf(BgUnavailableError);
  });
});
