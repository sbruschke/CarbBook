import { type Api, ApiError, NetworkError } from '../lib/api';
import type { BgReading } from '../lib/wire';

/** Prefill BG only when the reading is at most this old (spec §4.4). */
export const BG_FRESH_MS = 15 * 60 * 1000;

export type BgResult =
  | { kind: 'reading'; reading: BgReading; fetched_at: number }
  | { kind: 'unavailable'; message: string }
  | { kind: 'offline' };

export interface BgPrefill {
  mgdl: number;
  trend: string | null;
  arrow: string | null;
  age_ms: number;
}

export async function fetchBg(api: Api, now: () => number = Date.now): Promise<BgResult> {
  try {
    const reading = await api.get<BgReading>('/api/bg');
    return { kind: 'reading', reading, fetched_at: now() };
  } catch (error) {
    if (error instanceof NetworkError) return { kind: 'offline' };
    if (error instanceof ApiError && error.status === 401) return { kind: 'unavailable', message: 'Sign in again to load BG' };
    return { kind: 'unavailable', message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The reading to prefill, or null when the user must enter BG by hand. The server's `fresh`
 * flag is authoritative (it also marks readings more than 2 minutes in the future as stale);
 * the age keeps growing while the screen stays open.
 */
export function bgPrefill(result: BgResult, now: number): BgPrefill | null {
  if (result.kind !== 'reading' || !result.reading.fresh) return null;
  const ageMs = result.reading.age_ms + Math.max(0, now - result.fetched_at);
  if (ageMs > BG_FRESH_MS) return null;
  return { mgdl: result.reading.mgdl, trend: result.reading.trend, arrow: result.reading.arrow, age_ms: ageMs };
}
