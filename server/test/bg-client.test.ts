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
});
