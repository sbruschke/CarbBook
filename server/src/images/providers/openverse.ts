import { isProviderHost } from '../urlguard';
import { getJson, type ImageCandidate, type ImageSearchProvider, type ProviderOptions } from './types';

/**
 * Openverse: ~700M CC-licensed images, no API key (anonymous calls are rate-limited, which
 * arrives as 429 and is treated as unavailability).
 *
 * We deliberately adopt the Openverse-proxied `thumbnail` URL rather than `url`, the original
 * on an arbitrary third-party host. That keeps every adoptable URL on api.openverse.org, which
 * is what makes the urlguard allowlist short.
 *
 * The plain proxy (used for thumb_url) is fine for a picker grid but too small to store: measured
 * at 600x399 (25768B), under our 800px cap. Appending full_size=true, still on api.openverse.org,
 * returns the original — measured at 1024x681 (96610B) for the same image — so full_url adds it.
 */
interface OpenverseResult {
  id?: string;
  title?: string | null;
  creator?: string | null;
  license?: string | null;
  license_version?: string | null;
  width?: number | null;
  height?: number | null;
  thumbnail?: string | null;
}

/** Openverse reports licences as a slug plus a version: "by" + "4.0" -> CC-BY-4.0. */
function licenseOf(result: OpenverseResult): string | null {
  const slug = result.license?.trim().toLowerCase();
  if (!slug) return null;
  const version = result.license_version?.trim();
  if (slug === 'cc0') return version ? `CC0-${version}` : 'CC0-1.0';
  if (slug === 'pdm') return 'Public-Domain-Mark';
  return version ? `CC-${slug.toUpperCase()}-${version}` : `CC-${slug.toUpperCase()}`;
}

function attributionOf(result: OpenverseResult, license: string | null): string | null {
  const parts: string[] = [];
  if (result.title) parts.push(result.title);
  if (result.creator) parts.push(`by ${result.creator}`);
  const credit = parts.join(' ');
  if (credit && license) return `${credit} (${license})`;
  return credit || license || null;
}

export function createOpenverseProvider(options: ProviderOptions): ImageSearchProvider {
  return {
    name: 'openverse',
    async search(query, limit) {
      const url = `${options.baseUrl}/v1/images/?${new URLSearchParams({
        q: query,
        page_size: String(limit),
        // Only licences that permit reuse with attribution; excludes ND/NC edge cases we would
        // otherwise have to reason about per image.
        license: 'cc0,pdm,by,by-sa',
        mature: 'false',
      })}`;
      const body = await getJson<{ results?: OpenverseResult[] }>('openverse', url, options);
      const results = Array.isArray(body.results) ? body.results : [];

      return results.flatMap((result) => {
        const thumb = result.thumbnail?.trim();
        // Defence in depth: urlguard would reject a foreign host at adopt time anyway, but a
        // candidate we know is unadoptable should never reach the picker.
        if (!thumb || !isProviderHost(thumb, 'openverse')) return [];
        const fullUrl = new URL(thumb);
        fullUrl.searchParams.set('full_size', 'true');
        const license = licenseOf(result);
        const candidate: ImageCandidate = {
          provider: 'openverse',
          thumb_url: thumb,
          full_url: fullUrl.toString(),
          width: result.width ?? null,
          height: result.height ?? null,
          license,
          attribution: attributionOf(result, license),
          title: result.title ?? null,
        };
        return [candidate];
      });
    },
  };
}
