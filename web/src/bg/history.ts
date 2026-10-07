import type { BgPoint } from '@carbbook/core';
import { useEffect, useState } from 'react';
import { useServices } from '../app/services';
import { ApiError, type Api, NetworkError } from '../lib/api';

/**
 * Stored CGM history (BG history spec 2026-10-07) from `GET /api/bg/readings`. Online only: the
 * readings live in dexcom-api on the Pi, not in the synced tables. Display only — never fed to a dose.
 */
export interface BgRangeResult {
  status: 'loading' | 'ok' | 'error';
  points: BgPoint[];
  /** Oldest reading stored at all; before it there is simply no history, not a gap. */
  earliestAt: number | null;
  message: string | null;
}

const LOADING: BgRangeResult = { status: 'loading', points: [], earliestAt: null, message: null };

/** One request per range per minute: moving between days and back should not refetch. */
const cache = new Map<string, { at: number; result: BgRangeResult }>();
const CACHE_MS = 60_000;
const CHUNK_MS = 90 * 24 * 3_600_000;

export async function fetchBgRange(api: Api, from: number, to: number, now: number = Date.now()): Promise<BgRangeResult> {
  const key = `${from}-${to}`;
  const hit = cache.get(key);
  // A range wholly in the past never changes; one reaching now goes stale after a minute.
  if (hit && (to <= hit.at || now - hit.at < CACHE_MS)) return hit.result;
  try {
    // The server caps one request at 92 days; a long export asks in 90-day pieces.
    const points: BgPoint[] = [];
    let earliestAt: number | null = null;
    for (let a = from; a < to; a += CHUNK_MS) {
      const b = Math.min(to, a + CHUNK_MS);
      const body = await api.get<{ readings: BgPoint[]; earliest_at: number | null }>(`/api/bg/readings?from=${a}&to=${b}`);
      points.push(...body.readings);
      earliestAt = body.earliest_at;
    }
    const result: BgRangeResult = { status: 'ok', points, earliestAt, message: null };
    cache.set(key, { at: now, result });
    return result;
  } catch (error) {
    const message =
      error instanceof NetworkError
        ? 'BG history needs a connection.'
        : error instanceof ApiError && error.code === 'bg_unavailable'
          ? 'BG history is unavailable right now.'
          : 'Could not load BG history.';
    return { status: 'error', points: [], earliestAt: null, message };
  }
}

export function clearBgCache(): void {
  cache.clear();
}

export function useBgRange(from: number, to: number): BgRangeResult {
  const { api, now } = useServices();
  const [result, setResult] = useState<{ key: string; value: BgRangeResult } | null>(null);
  const key = `${from}-${to}`;
  useEffect(() => {
    let cancelled = false;
    void fetchBgRange(api, from, to, now()).then((value) => {
      if (!cancelled) setResult({ key, value });
    });
    return () => {
      cancelled = true;
    };
  }, [api, now, from, to, key]);
  // Never show the previous range's readings while the new one loads.
  return result?.key === key ? result.value : LOADING;
}
