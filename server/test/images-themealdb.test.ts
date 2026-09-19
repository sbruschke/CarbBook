import { describe, expect, it } from 'vitest';
import { createMealDbProvider } from '../src/images/providers/themealdb';
import { ProviderUnavailableError } from '../src/images/providers/types';

/** Trimmed from a live themealdb.com/api/json/v1/1/search.php?s=soup response. */
const RESPONSE = {
  meals: [
    { idMeal: '52908', strMeal: 'Tomato Soup', strMealThumb: 'https://www.themealdb.com/images/media/meals/abc123.jpg' },
    { idMeal: '52909', strMeal: 'Noodle Soup', strMealThumb: 'https://www.themealdb.com/images/media/meals/def456.jpg' },
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
  baseUrl: 'https://www.themealdb.com',
  timeoutMs: 1000,
  userAgent: 'CarbBook/test',
  fetch,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('themealdb provider', () => {
  it('maps meals, uses the /medium thumbnail, and honours the limit', async () => {
    const { fetch, calls } = stubFetch(() => json(RESPONSE));
    const candidates = await createMealDbProvider(options(fetch)).search('soup', 1);

    expect(calls[0]).toBe('https://www.themealdb.com/api/json/v1/1/search.php?s=soup');
    expect(candidates).toEqual([
      {
        provider: 'themealdb',
        thumb_url: 'https://www.themealdb.com/images/media/meals/abc123.jpg/medium',
        full_url: 'https://www.themealdb.com/images/media/meals/abc123.jpg',
        width: null,
        height: null,
        license: null,
        attribution: 'TheMealDB',
        title: 'Tomato Soup',
      },
    ]);
  });

  it('treats a null meals field as no results (how TheMealDB reports a miss)', async () => {
    const { fetch } = stubFetch(() => json({ meals: null }));
    expect(await createMealDbProvider(options(fetch)).search('zzzz', 10)).toEqual([]);
  });

  it('drops a meal with no thumbnail or an off-host one', async () => {
    const { fetch } = stubFetch(() =>
      json({
        meals: [
          { idMeal: '1', strMeal: 'A', strMealThumb: '' },
          { idMeal: '2', strMeal: 'B', strMealThumb: 'https://evil.test/x.jpg' },
        ],
      }),
    );
    expect(await createMealDbProvider(options(fetch)).search('x', 10)).toEqual([]);
  });

  it('throws ProviderUnavailableError on a 503', async () => {
    const { fetch } = stubFetch(() => new Response('down', { status: 503 }));
    await expect(createMealDbProvider(options(fetch)).search('x', 10)).rejects.toBeInstanceOf(ProviderUnavailableError);
  });
});
