import { describe, expect, it } from 'vitest';
import { createWikimediaProvider } from '../src/images/providers/wikimedia';
import { ProviderUnavailableError } from '../src/images/providers/types';

/** Trimmed from a live commons.wikimedia.org action=query response. */
const RESPONSE = {
  query: {
    pages: {
      '123': {
        pageid: 123,
        title: 'File:Tomato soup.jpg',
        imageinfo: [
          {
            thumburl:
              'https://thumb.wikimedia.org/wikipedia/commons/thumb/a/b/Tomato_soup.jpg/800px-Tomato_soup.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail',
            thumbwidth: 800,
            thumbheight: 533,
            url: 'https://upload.wikimedia.org/wikipedia/commons/a/b/Tomato_soup.jpg',
            width: 3000,
            height: 2000,
            extmetadata: {
              LicenseShortName: { value: 'CC BY-SA 4.0' },
              Artist: { value: '<a href="/wiki/User:Someone">Someone</a>' },
            },
          },
        ],
      },
    },
  },
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
  baseUrl: 'https://commons.wikimedia.org',
  timeoutMs: 1000,
  userAgent: 'CarbBook/test',
  fetch,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('wikimedia provider', () => {
  it('searches file namespace bitmaps and maps imageinfo', async () => {
    const { fetch, calls } = stubFetch(() => json(RESPONSE));
    const candidates = await createWikimediaProvider(options(fetch)).search('tomato soup', 8);

    expect(calls[0]).toContain('action=query');
    expect(calls[0]).toContain('gsrnamespace=6');
    expect(calls[0]).toContain('gsrlimit=8');
    expect(calls[0]).toContain('iiurlwidth=800');

    expect(candidates).toEqual([
      {
        provider: 'wikimedia',
        thumb_url:
          'https://thumb.wikimedia.org/wikipedia/commons/thumb/a/b/Tomato_soup.jpg/800px-Tomato_soup.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail',
        full_url:
          'https://thumb.wikimedia.org/wikipedia/commons/thumb/a/b/Tomato_soup.jpg/800px-Tomato_soup.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail',
        width: 800,
        height: 533,
        license: 'CC BY-SA 4.0',
        // HTML stripped: attribution is rendered as plain text on every client.
        attribution: 'Someone (CC BY-SA 4.0)',
        title: 'Tomato soup.jpg',
      },
    ]);
  });

  it('falls back to the full url when no thumburl is offered', async () => {
    const info = { ...RESPONSE.query.pages['123']!.imageinfo[0]! };
    delete (info as Record<string, unknown>).thumburl;
    const { fetch } = stubFetch(() => json({ query: { pages: { '123': { title: 'File:X.jpg', imageinfo: [info] } } } }));
    const candidates = await createWikimediaProvider(options(fetch)).search('x', 8);
    expect(candidates[0]!.full_url).toBe('https://upload.wikimedia.org/wikipedia/commons/a/b/Tomato_soup.jpg');
    expect(candidates[0]!.width).toBe(3000);
  });

  it('drops a candidate whose URL is not on an allowlisted Wikimedia host', async () => {
    const { fetch } = stubFetch(() =>
      json({
        query: {
          pages: {
            '1': { title: 'File:Evil.jpg', imageinfo: [{ thumburl: 'https://evil.test/x.jpg', thumbwidth: 8, thumbheight: 8 }] },
          },
        },
      }),
    );
    expect(await createWikimediaProvider(options(fetch)).search('x', 8)).toEqual([]);
  });

  it('returns an empty list when the search matches nothing', async () => {
    const { fetch } = stubFetch(() => json({ batchcomplete: '' }));
    expect(await createWikimediaProvider(options(fetch)).search('zzzz', 8)).toEqual([]);
  });

  it('throws ProviderUnavailableError on a 500', async () => {
    const { fetch } = stubFetch(() => new Response('boom', { status: 500 }));
    await expect(createWikimediaProvider(options(fetch)).search('x', 8)).rejects.toBeInstanceOf(ProviderUnavailableError);
  });
});
