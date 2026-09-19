/** One search hit. Nothing is downloaded to produce these; thumb_url is loaded by the client. */
export interface ImageCandidate {
  provider: 'openverse' | 'wikimedia' | 'themealdb' | 'off';
  /** Small image for the picker grid. */
  thumb_url: string;
  /** What POST /api/images/adopt will fetch. Must be on the provider's own host (urlguard.ts). */
  full_url: string;
  width: number | null;
  height: number | null;
  license: string | null;
  attribution: string | null;
  title: string | null;
}

export interface ImageSearchProvider {
  readonly name: ImageCandidate['provider'];
  /** Resolves candidates, or rejects; the aggregator turns a rejection into `providers_failed`. */
  search(query: string, limit: number): Promise<ImageCandidate[]>;
}

export interface ProviderOptions {
  baseUrl: string;
  timeoutMs: number;
  fetch: typeof globalThis.fetch;
  userAgent: string;
}

/** Shared by every provider: one JSON GET with a timeout, failures thrown as this. */
export class ProviderUnavailableError extends Error {
  constructor(provider: string, message: string) {
    super(`${provider}: ${message}`);
    this.name = 'ProviderUnavailableError';
  }
}

export async function getJson<T>(provider: string, url: string, options: ProviderOptions): Promise<T> {
  try {
    const response = await options.fetch(url, {
      headers: { accept: 'application/json', 'user-agent': options.userAgent },
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    // 429 is normal for anonymous Openverse use; it is unavailability, not a bug.
    if (!response.ok) throw new ProviderUnavailableError(provider, `responded ${response.status}`);
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof ProviderUnavailableError) throw error;
    throw new ProviderUnavailableError(provider, (error as Error).message);
  }
}
