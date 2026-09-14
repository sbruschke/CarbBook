/** Fields requested from Open Food Facts API v2 (verified against world.openfoodfacts.org 2026-09-14). */
export const OFF_FIELDS = 'code,product_name,brands,serving_size,serving_quantity,serving_quantity_unit,nutriments';

export interface OffProduct {
  code: string;
  product_name?: string;
  brands?: string;
  serving_size?: string;
  serving_quantity?: number | string;
  serving_quantity_unit?: string;
  nutriments?: Record<string, unknown>;
}

export interface OffClient {
  /** Resolves null when OFF does not know the code; rejects with OffUnavailableError on failure. */
  lookup(code: string): Promise<OffProduct | null>;
}

export class OffUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OffUnavailableError';
  }
}

export interface OffClientOptions {
  baseUrl: string;
  /** OFF asks for "AppName/Version (Contact)". CarbBook uses its site URL, never an email address. */
  userAgent: string;
  timeoutMs: number;
  fetch: typeof globalThis.fetch;
}

export function createOffClient(options: OffClientOptions): OffClient {
  return {
    async lookup(code) {
      const url = `${options.baseUrl}/api/v2/product/${encodeURIComponent(code)}?fields=${OFF_FIELDS}`;
      let response: Response;
      let body: { code?: string; status?: number; product?: Omit<OffProduct, 'code'> };
      try {
        response = await options.fetch(url, {
          headers: { 'user-agent': options.userAgent, accept: 'application/json' },
          signal: AbortSignal.timeout(options.timeoutMs),
        });
        // Unknown products come back as HTTP 404 with {"status":0,"status_verbose":"product not found"}.
        if (response.status === 404) return null;
        if (!response.ok) throw new OffUnavailableError(`Open Food Facts responded ${response.status}`);
        body = (await response.json()) as { code?: string; status?: number; product?: Omit<OffProduct, 'code'> };
      } catch (error) {
        if (error instanceof OffUnavailableError) throw error;
        throw new OffUnavailableError(`Open Food Facts unreachable: ${(error as Error).message}`);
      }
      if (body.status !== 1 || !body.product) return null;
      return { ...body.product, code: body.code ?? code };
    },
  };
}
