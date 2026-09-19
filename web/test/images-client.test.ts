import { describe, expect, it } from 'vitest';
import { adoptImage, imageUrl, searchImages } from '../src/lib/images';
import type { ImageCandidate } from '../src/lib/wire';
import { ApiError, NetworkError } from '../src/lib/api';
import { FakeApi } from './helpers';

const candidate = (fields: Partial<ImageCandidate> = {}): ImageCandidate => ({
  provider: 'openverse',
  thumb_url: 't',
  full_url: 'https://api.openverse.org/v1/images/x/thumb/?full_size=true',
  width: null,
  height: null,
  license: 'CC0-1.0',
  attribution: null,
  title: null,
  ...fields,
});

describe('imageUrl', () => {
  it('builds the hash URL and returns null for anything that is not a hash', () => {
    expect(imageUrl('a'.repeat(64))).toBe(`/api/images/${'a'.repeat(64)}`);
    expect(imageUrl(null)).toBeNull();
    expect(imageUrl(undefined)).toBeNull();
    // A dangling or malformed id must render as no image, never a broken request.
    expect(imageUrl('nope')).toBeNull();
    expect(imageUrl('A'.repeat(64))).toBeNull();
  });
});

describe('searchImages', () => {
  it('sends the query and returns candidates with failed providers', async () => {
    const api = new FakeApi().on('GET', '/api/images/search', () => ({ candidates: [], providers_failed: ['wikimedia'] }));
    const result = await searchImages(api, 'tomato soup');
    expect(api.calls[0]!.path).toContain('/api/images/search?q=tomato+soup');
    expect(result.providers_failed).toEqual(['wikimedia']);
  });

  it('returns an empty result rather than throwing when the request fails', async () => {
    const api = new FakeApi().on('GET', '/api/images/search', () => {
      throw new ApiError(500, 'oops', 'nope');
    });
    expect(await searchImages(api, 'x')).toEqual({ candidates: [], providers_failed: ['server'] });
  });

  it('returns an empty result when the network is down', async () => {
    const api = new FakeApi().on('GET', '/api/images/search', () => {
      throw new NetworkError('Failed to fetch');
    });
    expect(await searchImages(api, 'x')).toEqual({ candidates: [], providers_failed: ['server'] });
  });
});

describe('adoptImage', () => {
  it('posts the candidate and returns the image row', async () => {
    const row = { id: 'b'.repeat(64), mime: 'image/jpeg', width: 800, height: 600, source: 'openverse' };
    const api = new FakeApi().on('POST', '/api/images/adopt', () => row);
    const result = await adoptImage(api, candidate());
    const sent = api.calls[0]!.body as Record<string, unknown>;
    expect(sent).toMatchObject({ url: candidate().full_url, source: 'openverse', license: 'CC0-1.0' });
    // A null attribution must be omitted, not sent as null — the schema forbids non-string values.
    expect('attribution' in sent).toBe(false);
    expect(result.id).toBe(row.id);
  });
});
