import { describe, expect, it } from 'vitest';
import { createOpenverseProvider } from '../src/images/providers/openverse';
import { ProviderUnavailableError } from '../src/images/providers/types';

/** Trimmed from a live api.openverse.org/v1/images/?q=tomato+soup response. */
const RESPONSE = {
  result_count: 2,
  results: [
    {
      id: '11111111-1111-1111-1111-111111111111',
      title: 'Tomato soup',
      creator: 'A Cook',
      license: 'by',
      license_version: '4.0',
      width: 2400,
      height: 1600,
      thumbnail: 'https://api.openverse.org/v1/images/11111111-1111-1111-1111-111111111111/thumb/',
      url: 'https://live.staticflickr.com/1/2_3_b.jpg',
      foreign_landing_url: 'https://www.flickr.com/photos/x/2',
    },
    {
      id: '22222222-2222-2222-2222-222222222222',
      title: null,
      creator: null,
      license: 'cc0',
      license_version: '1.0',
      width: null,
      height: null,
      thumbnail: 'https://api.openverse.org/v1/images/22222222-2222-2222-2222-222222222222/thumb/',
      url: 'https://example.test/2.jpg',
      foreign_landing_url: null,
    },
  ],
};

function stubFetch(handler: (url: string) => Response) {
  const calls: string[] = [];
  const fetch = (async (input: string | URL | Request) => {
    calls.push(String(input));
    return handler(String(input));
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const options = (fetch: typeof globalThis.fetch) => ({
  baseUrl: 'https://api.openverse.org',
  timeoutMs: 1000,
  userAgent: 'CarbBook/test',
  fetch,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('openverse provider', () => {
  it('maps results and adopts from the Openverse-hosted thumbnail, not the foreign origin', async () => {
    const { fetch, calls } = stubFetch(() => json(RESPONSE));
    const candidates = await createOpenverseProvider(options(fetch)).search('tomato soup', 10);

    expect(calls[0]).toContain('/v1/images/?');
    expect(calls[0]).toContain('q=tomato+soup');
    expect(calls[0]).toContain('page_size=10');

    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toEqual({
      provider: 'openverse',
      thumb_url: 'https://api.openverse.org/v1/images/11111111-1111-1111-1111-111111111111/thumb/',
      // full_size=true upgrades the plain proxy (600x399) to the original (1024x681, measured),
      // while staying on api.openverse.org so urlguard's allowlist still covers it.
      full_url: 'https://api.openverse.org/v1/images/11111111-1111-1111-1111-111111111111/thumb/?full_size=true',
      width: 2400,
      height: 1600,
      license: 'CC-BY-4.0',
      attribution: 'Tomato soup by A Cook (CC-BY-4.0)',
      title: 'Tomato soup',
    });
  });

  it('handles a missing creator, title and dimensions', async () => {
    const { fetch } = stubFetch(() => json(RESPONSE));
    const candidates = await createOpenverseProvider(options(fetch)).search('x', 10);
    expect(candidates[1]!.license).toBe('CC0-1.0');
    expect(candidates[1]!.attribution).toBe('CC0-1.0');
    expect(candidates[1]!.width).toBeNull();
    expect(candidates[1]!.title).toBeNull();
  });

  it('appends full_size to a thumbnail URL that already carries a query string', async () => {
    const { fetch } = stubFetch(() =>
      json({
        results: [
          {
            ...RESPONSE.results[0],
            thumbnail: 'https://api.openverse.org/v1/images/11111111-1111-1111-1111-111111111111/thumb/?compressed=false',
          },
        ],
      }),
    );
    const candidates = await createOpenverseProvider(options(fetch)).search('x', 10);
    expect(candidates[0]!.full_url).toBe(
      'https://api.openverse.org/v1/images/11111111-1111-1111-1111-111111111111/thumb/?compressed=false&full_size=true',
    );
  });

  it('drops a result with no Openverse thumbnail rather than adopting a foreign host', async () => {
    const { fetch } = stubFetch(() =>
      json({ results: [{ ...RESPONSE.results[0], thumbnail: 'https://live.staticflickr.com/1/2_3_b.jpg' }] }),
    );
    expect(await createOpenverseProvider(options(fetch)).search('x', 10)).toEqual([]);
  });

  it('throws ProviderUnavailableError on 429 and on a non-JSON body', async () => {
    const rateLimited = stubFetch(() => new Response('slow down', { status: 429 }));
    await expect(createOpenverseProvider(options(rateLimited.fetch)).search('x', 10)).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
    const garbage = stubFetch(() => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    await expect(createOpenverseProvider(options(garbage.fetch)).search('x', 10)).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
  });

  it('returns an empty list when the response has no results array', async () => {
    const { fetch } = stubFetch(() => json({ result_count: 0 }));
    expect(await createOpenverseProvider(options(fetch)).search('x', 10)).toEqual([]);
  });
});
