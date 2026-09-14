export interface BgReading {
  mgdl: number;
  /** pydexcom trend_direction, e.g. "Flat", "FortyFiveUp". */
  trend: string | null;
  arrow: string | null;
  delta_mgdl: number | null;
  /** Sensor reading time, ms since epoch. */
  read_at: number;
}

export interface BgClient {
  /** Resolves with the latest cached reading or rejects with BgUnavailableError. */
  latest(): Promise<BgReading>;
}

export class BgUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BgUnavailableError';
  }
}

export interface DexcomApiClientOptions {
  baseUrl: string;
  token: string | null;
  timeoutMs: number;
  fetch: typeof globalThis.fetch;
}

/** Subset of dexcom-api `GET /glucose?history=0` (~/HomelabServer/dexcom-api/app.py `_render`). */
interface DexcomApiPayload {
  ok: boolean;
  error?: string | null;
  mgdl?: number;
  unit?: string;
  delta?: number | null;
  arrow?: string;
  trend_direction?: string;
  epoch?: number;
}

export function createDexcomApiClient(options: DexcomApiClientOptions): BgClient {
  return {
    async latest() {
      const headers: Record<string, string> = { accept: 'application/json' };
      if (options.token) headers.authorization = `Bearer ${options.token}`;
      let response: Response;
      try {
        response = await options.fetch(`${options.baseUrl}/glucose?history=0`, {
          headers,
          signal: AbortSignal.timeout(options.timeoutMs),
        });
      } catch (error) {
        throw new BgUnavailableError(`dexcom-api unreachable: ${(error as Error).message}`);
      }
      if (!response.ok) throw new BgUnavailableError(`dexcom-api responded ${response.status}`);
      let body: DexcomApiPayload;
      try {
        const parsed: unknown = await response.json();
        if (!parsed || typeof parsed !== 'object') {
          throw new BgUnavailableError('dexcom-api returned an unexpected response body');
        }
        body = parsed as DexcomApiPayload;
        if (!body.ok || typeof body.mgdl !== 'number' || typeof body.epoch !== 'number') {
          throw new BgUnavailableError(body.error ?? 'dexcom-api has no current reading');
        }
      } catch (error) {
        if (error instanceof BgUnavailableError) throw error;
        throw new BgUnavailableError(`dexcom-api returned an invalid response: ${(error as Error).message}`);
      }
      return {
        mgdl: body.mgdl,
        trend: body.trend_direction ?? null,
        arrow: body.arrow ?? null,
        delta_mgdl: body.unit === 'mg/dL' && typeof body.delta === 'number' ? body.delta : null,
        read_at: body.epoch * 1000,
      };
    },
  };
}
