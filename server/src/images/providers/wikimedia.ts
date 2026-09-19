import { IMAGE_MAX_EDGE_PX } from '@carbbook/core';
import { isProviderHost } from '../urlguard';
import { getJson, type ImageCandidate, type ImageSearchProvider, type ProviderOptions } from './types';

/**
 * Wikimedia Commons via action=query with a search generator. No API key. Licence and
 * attribution are reliable here, which is why it is worth having alongside Openverse.
 * Bytes always come from upload.wikimedia.org, the only host in the allowlist for this provider.
 */
interface CommonsImageInfo {
  thumburl?: string;
  thumbwidth?: number;
  thumbheight?: number;
  url?: string;
  width?: number;
  height?: number;
  extmetadata?: Record<string, { value?: unknown } | undefined>;
}

interface CommonsPage {
  title?: string;
  imageinfo?: CommonsImageInfo[];
}

/** extmetadata values are HTML fragments; every client renders attribution as plain text. */
function plainText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text === '' ? null : text;
}

export function createWikimediaProvider(options: ProviderOptions): ImageSearchProvider {
  return {
    name: 'wikimedia',
    async search(query, limit) {
      const url = `${options.baseUrl}/w/api.php?${new URLSearchParams({
        action: 'query',
        format: 'json',
        formatversion: '1',
        generator: 'search',
        // filetype:bitmap keeps SVGs and PDFs out; namespace 6 is File:.
        gsrsearch: `filetype:bitmap ${query}`,
        gsrnamespace: '6',
        gsrlimit: String(limit),
        prop: 'imageinfo',
        iiprop: 'url|size|extmetadata',
        iiurlwidth: String(IMAGE_MAX_EDGE_PX),
      })}`;
      const body = await getJson<{ query?: { pages?: Record<string, CommonsPage> } }>('wikimedia', url, options);
      const pages = body.query?.pages ? Object.values(body.query.pages) : [];

      return pages.flatMap((page) => {
        const info = page.imageinfo?.[0];
        if (!info) return [];
        const chosen = info.thumburl ?? info.url;
        if (!chosen || !isProviderHost(chosen, 'wikimedia')) return [];
        const license = plainText(info.extmetadata?.LicenseShortName?.value);
        const artist = plainText(info.extmetadata?.Artist?.value);
        const usingThumb = chosen === info.thumburl;
        const candidate: ImageCandidate = {
          provider: 'wikimedia',
          thumb_url: chosen,
          full_url: chosen,
          width: (usingThumb ? info.thumbwidth : info.width) ?? null,
          height: (usingThumb ? info.thumbheight : info.height) ?? null,
          license,
          attribution: artist && license ? `${artist} (${license})` : (artist ?? license),
          // Titles arrive as "File:Tomato soup.jpg".
          title: page.title?.replace(/^File:/, '') ?? null,
        };
        return [candidate];
      });
    },
  };
}
