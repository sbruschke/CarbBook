export interface BgReading {
  mgdl: number;
  /** pydexcom trend_direction, e.g. "Flat", "FortyFiveUp". */
  trend: string | null;
  arrow: string | null;
  delta_mgdl: number | null;
  /** Sensor reading time, ms since epoch. */
  read_at: number;
}

/** One stored CGM reading from dexcom-api's history (`GET /readings`). */
export interface BgPoint {
  /** Sensor reading time, ms since epoch. */
  at: number;
  mgdl: number;
}

export interface BgRange {
  readings: BgPoint[];
  /** Oldest reading dexcom-api holds at all, so "not recorded that far back" reads differently from a gap. */
  earliest_at: number | null;
}

export interface BgClient {
  /** Resolves with the latest cached reading or rejects with BgUnavailableError. */
  latest(): Promise<BgReading>;
  /** Stored readings in [fromMs, toMs), oldest first, or rejects with BgUnavailableError. */
  range(fromMs: number, toMs: number): Promise<BgRange>;
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

async function getJson(options: DexcomApiClientOptions, path: string): Promise<unknown> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  let response: Response;
  try {
    response = await options.fetch(`${options.baseUrl}${path}`, { headers, signal: AbortSignal.timeout(options.timeoutMs) });
  } catch (error) {
    throw new BgUnavailableError(`dexcom-api unreachable: ${(error as Error).message}`);
  }
  if (!response.ok) throw new BgUnavailableError(`dexcom-api responded ${response.status}`);
  try {
    return await response.json();
  } catch (error) {
    throw new BgUnavailableError(`dexcom-api returned an invalid response: ${(error as Error).message}`);
  }
}

export function createDexcomApiClient(options: DexcomApiClientOptions): BgClient {
  return {
    async range(fromMs, toMs) {
      // dexcom-api speaks epoch seconds; widen to whole seconds so no reading at the edge is lost.
      const from = Math.floor(fromMs / 1000);
      const to = Math.ceil(toMs / 1000);
      const body = (await getJson(options, `/readings?from=${from}&to=${to}`)) as {
        ok?: unknown;
        error?: unknown;
        earliest_epoch?: unknown;
        readings?: unknown;
      } | null;
      if (!body || body.ok !== true || !Array.isArray(body.readings)) {
        throw new BgUnavailableError(typeof body?.error === 'string' ? body.error : 'dexcom-api returned no readings');
      }
      // Anything malformed is dropped rather than drawn: a chart must never invent a point.
      const readings = body.readings.flatMap((r: unknown): BgPoint[] => {
        const { epoch, mgdl } = (r ?? {}) as { epoch?: unknown; mgdl?: unknown };
        return typeof epoch === 'number' && Number.isFinite(epoch) && typeof mgdl === 'number' && Number.isFinite(mgdl) && mgdl > 0
          ? [{ at: epoch * 1000, mgdl }]
          : [];
      });
      return {
        readings: readings.filter((r) => r.at >= fromMs && r.at < toMs),
        earliest_at: typeof body.earliest_epoch === 'number' ? body.earliest_epoch * 1000 : null,
      };
    },

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
