import { describe, expect, it } from 'vitest';
import { searchImages } from '../src/images/search';
import { ProviderUnavailableError, type ImageCandidate, type ImageSearchProvider } from '../src/images/providers/types';

const candidate = (provider: ImageCandidate['provider'], n: number): ImageCandidate => ({
  provider,
  thumb_url: `https://example.test/${provider}/${n}/thumb`,
  full_url: `https://example.test/${provider}/${n}`,
  width: 800,
  height: 600,
  license: null,
  attribution: null,
  title: `${provider} ${n}`,
});

const working = (name: ImageCandidate['provider'], count: number): ImageSearchProvider => ({
  name,
  search: async (_query, limit) => Array.from({ length: Math.min(count, limit) }, (_, i) => candidate(name, i)),
});

const broken = (name: ImageCandidate['provider']): ImageSearchProvider => ({
  name,
  search: async () => {
    throw new ProviderUnavailableError(name, 'responded 429');
  },
});

describe('searchImages', () => {
  it('interleaves providers so one cannot crowd out the others', async () => {
    const result = await searchImages([working('openverse', 3), working('wikimedia', 3)], 'soup', 6);
    expect(result.candidates.map((c) => c.provider)).toEqual([
      'openverse', 'wikimedia', 'openverse', 'wikimedia', 'openverse', 'wikimedia',
    ]);
    expect(result.providers_failed).toEqual([]);
  });

  it('names failed providers and still returns what arrived', async () => {
    const result = await searchImages([working('openverse', 2), broken('wikimedia')], 'soup', 10);
    expect(result.candidates).toHaveLength(2);
    expect(result.providers_failed).toEqual(['wikimedia']);
  });

  it('returns an empty list, not an error, when every provider fails', async () => {
    const result = await searchImages([broken('openverse'), broken('wikimedia')], 'soup', 10);
    expect(result.candidates).toEqual([]);
    expect(result.providers_failed).toEqual(['openverse', 'wikimedia']);
  });

  it('dedups by full_url, keeping the first occurrence', async () => {
    const same: ImageSearchProvider = { name: 'themealdb', search: async () => [candidate('openverse', 0)] };
    const result = await searchImages([working('openverse', 1), same], 'soup', 10);
    expect(result.candidates).toHaveLength(1);
  });

  it('honours the overall limit and caps each provider to its fair share', async () => {
    const result = await searchImages([working('openverse', 50), working('wikimedia', 50)], 'soup', 4);
    expect(result.candidates).toHaveLength(4);
    expect(result.candidates.filter((c) => c.provider === 'openverse')).toHaveLength(2);
  });

  it('returns nothing for a blank query without calling any provider', async () => {
    let called = false;
    const spy: ImageSearchProvider = {
      name: 'openverse',
      search: async () => {
        called = true;
        return [];
      },
    };
    const result = await searchImages([spy], '   ', 10);
    expect(result.candidates).toEqual([]);
    expect(called).toBe(false);
  });

  it('does not let one slow provider delay the others past its own failure', async () => {
    // A provider that rejects late must still only contribute to providers_failed.
    const slowBroken: ImageSearchProvider = {
      name: 'themealdb',
      search: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        throw new ProviderUnavailableError('themealdb', 'timeout');
      },
    };
    const result = await searchImages([working('openverse', 2), slowBroken], 'soup', 10);
    expect(result.candidates).toHaveLength(2);
    expect(result.providers_failed).toEqual(['themealdb']);
  });
});
