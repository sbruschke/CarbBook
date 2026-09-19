import { IMAGE_MAX_DOWNLOAD_BYTES } from '@carbbook/core';
import { ImageRejectedError } from './store';

/**
 * Download bytes for adoption. The caller MUST have passed the URL through assertAdoptableUrl
 * first — this function does no validation of its own.
 *
 * Redirects are rejected rather than followed: a 302 from an allowlisted host would otherwise
 * escape both of the guard's gates, and all four allowlisted hosts serve final URLs for the URLs
 * we adopt. If a provider ever starts redirecting, re-run the guard per hop — do NOT switch to
 * redirect: 'follow', which would bypass the guard entirely.
 *
 * The body is read in chunks and capped as bytes arrive, not from a content-length header the
 * host may have lied about, so a hostile or misconfigured host cannot stream forever.
 */
export async function fetchImageBytes(url: string, timeoutMs: number, userAgent: string): Promise<Buffer> {
  const response = await fetch(url, {
    headers: { accept: 'image/*', 'user-agent': userAgent },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'manual',
  });
  if (response.status >= 300 && response.status < 400) {
    throw new ImageRejectedError('image URL redirected; adopt the final URL instead');
  }
  if (!response.ok) throw new ImageRejectedError(`image host responded ${response.status}`);
  if (!response.body) throw new ImageRejectedError('image response had no body');

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > IMAGE_MAX_DOWNLOAD_BYTES) throw new ImageRejectedError('image is too large to adopt');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
