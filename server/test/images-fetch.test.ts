import { IMAGE_MAX_DOWNLOAD_BYTES } from '@carbbook/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchImageBytes } from '../src/images/fetch';
import { ImageRejectedError } from '../src/images/store';

/** A body that yields `count` chunks of `size` bytes, so a big body costs no big allocation. */
function streamOf(count: number, size: number): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= count) {
        controller.close();
        return;
      }
      sent += 1;
      controller.enqueue(new Uint8Array(size));
    },
  });
}

function stubFetch(response: Response): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchImageBytes', () => {
  it('returns the downloaded bytes', async () => {
    stubFetch(new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }));
    const bytes = await fetchImageBytes('https://example.test/a.jpg', 1000, 'CarbBook/test');
    expect([...bytes]).toEqual([1, 2, 3, 4]);
  });

  it('rejects a redirect rather than following it', async () => {
    stubFetch(new Response(null, { status: 302, headers: { location: 'https://elsewhere.test/a.jpg' } }));
    await expect(fetchImageBytes('https://example.test/a.jpg', 1000, 'CarbBook/test')).rejects.toThrow(
      ImageRejectedError,
    );
  });

  it('rejects a non-ok response', async () => {
    stubFetch(new Response(null, { status: 404 }));
    await expect(fetchImageBytes('https://example.test/a.jpg', 1000, 'CarbBook/test')).rejects.toThrow(
      /responded 404/,
    );
  });

  it('rejects a body that exceeds the download cap as bytes arrive', async () => {
    const chunk = 1024 * 1024;
    stubFetch(new Response(streamOf(Math.ceil(IMAGE_MAX_DOWNLOAD_BYTES / chunk) + 1, chunk), { status: 200 }));
    await expect(fetchImageBytes('https://example.test/a.jpg', 1000, 'CarbBook/test')).rejects.toThrow(
      /too large to adopt/,
    );
  });
});
