import { describe, expect, it } from 'vitest';
import { bgPrefill, fetchBg } from '../src/bg/bg';
import { ApiError, NetworkError } from '../src/lib/api';
import type { BgReading } from '../src/lib/wire';
import { FakeApi } from './helpers';

const MIN = 60_000;
const reading = (fields: Partial<BgReading> = {}): BgReading => ({
  mgdl: 263, trend: 'FortyFiveUp', arrow: '↗', delta_mgdl: 6, read_at: 0, age_ms: 5 * MIN, fresh: true, ...fields,
});

describe('BG', () => {
  it('prefills a fresh reading and keeps ageing it after the fetch', async () => {
    const api = new FakeApi().on('GET', '/api/bg', () => reading());
    const result = await fetchBg(api, () => 1000);
    expect(result).toEqual({ kind: 'reading', reading: reading(), fetched_at: 1000 });
    expect(bgPrefill(result, 1000 + MIN)).toEqual({ mgdl: 263, trend: 'FortyFiveUp', arrow: '↗', age_ms: 6 * MIN });
    expect(bgPrefill(result, 1000 + 10 * MIN)).toEqual(expect.objectContaining({ age_ms: 15 * MIN }));
    expect(bgPrefill(result, 1000 + 10 * MIN + 1)).toBeNull();
  });

  it('never prefills a reading the server marks stale', async () => {
    const api = new FakeApi().on('GET', '/api/bg', () => reading({ age_ms: 0, fresh: false }));
    expect(bgPrefill(await fetchBg(api, () => 0), 0)).toBeNull();
  });

  it('reports an unavailable dexcom-api and offline separately', async () => {
    const down = new FakeApi().on('GET', '/api/bg', () => {
      throw new ApiError(503, 'bg_unavailable', 'dexcom-api responded 500');
    });
    expect(await fetchBg(down)).toEqual({ kind: 'unavailable', message: 'dexcom-api responded 500' });
    const offline = new FakeApi().on('GET', '/api/bg', () => {
      throw new NetworkError('Failed to fetch');
    });
    const result = await fetchBg(offline);
    expect(result).toEqual({ kind: 'offline' });
    expect(bgPrefill(result, 0)).toBeNull();
  });
});
