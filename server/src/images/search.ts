import type { ImageCandidate, ImageSearchProvider } from './providers/types';

export interface ImageSearchResult {
  candidates: ImageCandidate[];
  /** Providers that timed out, errored or rate-limited. The UI says so instead of silently showing less. */
  providers_failed: string[];
}

/**
 * Fan out to every provider in parallel and interleave the results.
 *
 * Search is a convenience and must never block saving a food, so a provider failure is data
 * (`providers_failed`), not an error: every provider failing still resolves with an empty list.
 */
export async function searchImages(
  providers: ImageSearchProvider[],
  query: string,
  limit: number,
): Promise<ImageSearchResult> {
  const trimmed = query.trim();
  if (trimmed === '' || providers.length === 0 || limit <= 0) return { candidates: [], providers_failed: [] };

  // Fair share, rounded up, so a single provider cannot fill the grid on its own.
  const perProvider = Math.max(1, Math.ceil(limit / providers.length));
  const settled = await Promise.allSettled(providers.map((provider) => provider.search(trimmed, perProvider)));

  const lists: ImageCandidate[][] = [];
  const failed: string[] = [];
  settled.forEach((outcome, index) => {
    const provider = providers[index]!;
    if (outcome.status === 'fulfilled') lists.push(outcome.value.slice(0, perProvider));
    else failed.push(provider.name);
  });

  const candidates: ImageCandidate[] = [];
  const seen = new Set<string>();
  const deepest = Math.max(0, ...lists.map((list) => list.length));
  for (let round = 0; round < deepest && candidates.length < limit; round += 1) {
    for (const list of lists) {
      if (candidates.length >= limit) break;
      const candidate = list[round];
      if (!candidate || seen.has(candidate.full_url)) continue;
      seen.add(candidate.full_url);
      candidates.push(candidate);
    }
  }

  return { candidates, providers_failed: failed };
}
