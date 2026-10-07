/**
 * CGM history maths for charts and trends (BG history spec 2026-10-07). Display only: nothing in
 * here feeds the dose estimate. Shared with Swift through `testdata/bg-stats-vectors.json`.
 *
 * Bands are the international consensus CGM targets (Battelino et al., Diabetes Care 2019): very low
 * < 54, low 54–69, in range 70–180, high 181–250, very high > 250 mg/dL.
 */
export const BG_VERY_LOW = 54;
export const BG_LOW = 70;
export const BG_HIGH = 180;
export const BG_VERY_HIGH = 250;
/** Dexcom produces one reading every 5 minutes. */
export const BG_INTERVAL_MS = 5 * 60 * 1000;

export interface BgPoint {
  /** ms since epoch */
  at: number;
  mgdl: number;
}

export type BgBand = 'very_low' | 'low' | 'in_range' | 'high' | 'very_high';

export function bgBand(mgdl: number): BgBand {
  if (mgdl < BG_VERY_LOW) return 'very_low';
  if (mgdl < BG_LOW) return 'low';
  if (mgdl <= BG_HIGH) return 'in_range';
  if (mgdl <= BG_VERY_HIGH) return 'high';
  return 'very_high';
}

export interface BgStats {
  count: number;
  /** Readings received ÷ readings expected over the span, 0..1. Below ~0.7 the numbers are shaky. */
  coverage: number;
  mean: number;
  /** Population standard deviation. */
  sd: number;
  /** Coefficient of variation, percent. Consensus target ≤ 36. */
  cv: number;
  /** Glucose management indicator, percent: 3.31 + 0.02392 × mean mg/dL. */
  gmi: number;
  min: number;
  max: number;
  /** Fraction of readings in each band, 0..1; they sum to 1. */
  bands: Record<BgBand, number>;
}

const usable = (points: BgPoint[]): BgPoint[] => points.filter((p) => Number.isFinite(p.at) && Number.isFinite(p.mgdl) && p.mgdl > 0);

/** Stats over readings covering `spanMs` of time; null when there are none. */
export function bgStats(points: BgPoint[], spanMs: number): BgStats | null {
  const values = usable(points).map((p) => p.mgdl);
  const count = values.length;
  if (count === 0) return null;
  const mean = values.reduce((a, b) => a + b, 0) / count;
  const sd = Math.sqrt(values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / count);
  const bands: Record<BgBand, number> = { very_low: 0, low: 0, in_range: 0, high: 0, very_high: 0 };
  for (const v of values) bands[bgBand(v)] += 1;
  for (const key of Object.keys(bands) as BgBand[]) bands[key] /= count;
  const expected = spanMs > 0 ? spanMs / BG_INTERVAL_MS : count;
  return {
    count,
    coverage: Math.min(1, count / expected),
    mean,
    sd,
    cv: mean > 0 ? (sd / mean) * 100 : 0,
    gmi: 3.31 + 0.02392 * mean,
    min: Math.min(...values),
    max: Math.max(...values),
    bands,
  };
}

export interface MealResponse {
  /** Latest reading from 15 min before to 5 min after eating. */
  before: number | null;
  /** The reading closest to 2 h after eating, if one is within 10 min of it. */
  two_hour: number | null;
  /** Highest reading in the 3 h after eating. */
  peak: number | null;
  /** Minutes from eating to that peak. */
  peak_minutes: number | null;
  /** peak − before, when both exist. */
  rise: number | null;
}

const MIN = 60_000;

/** How BG moved after a meal eaten at `eatenAt`. Every field is null when the data isn't there. */
export function mealResponse(points: BgPoint[], eatenAt: number): MealResponse {
  const pts = usable(points);
  const before = pts.filter((p) => p.at >= eatenAt - 15 * MIN && p.at <= eatenAt + 5 * MIN).sort((a, b) => b.at - a.at)[0];
  const target = eatenAt + 120 * MIN;
  const near = pts
    .filter((p) => Math.abs(p.at - target) <= 10 * MIN)
    .sort((a, b) => Math.abs(a.at - target) - Math.abs(b.at - target) || a.at - b.at)[0];
  let peak: BgPoint | undefined;
  for (const p of pts) {
    if (p.at > eatenAt && p.at <= eatenAt + 180 * MIN && (!peak || p.mgdl > peak.mgdl || (p.mgdl === peak.mgdl && p.at < peak.at))) peak = p;
  }
  return {
    before: before?.mgdl ?? null,
    two_hour: near?.mgdl ?? null,
    peak: peak?.mgdl ?? null,
    peak_minutes: peak ? Math.round((peak.at - eatenAt) / MIN) : null,
    rise: peak && before ? peak.mgdl - before.mgdl : null,
  };
}

export interface PatternHour {
  hour: number;
  count: number;
  /** 10th, 25th, 50th, 75th, 90th percentiles; null with fewer than 3 readings in the hour. */
  p10: number | null;
  p25: number | null;
  p50: number | null;
  p75: number | null;
  p90: number | null;
}

/** Linear-interpolated percentile of sorted values (the common "type 7" definition). */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const rank = (sorted.length - 1) * p;
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (rank - lo);
}

/**
 * The daily pattern (an AGP-style view): readings grouped by local hour of day across many days.
 * `hourOf` is the platform's local hour for a timestamp — time zones are platform work.
 */
export function dailyPattern(points: BgPoint[], hourOf: (at: number) => number): PatternHour[] {
  const byHour: number[][] = Array.from({ length: 24 }, () => []);
  for (const p of usable(points)) {
    const hour = hourOf(p.at);
    if (Number.isInteger(hour) && hour >= 0 && hour < 24) byHour[hour]!.push(p.mgdl);
  }
  return byHour.map((values, hour) => {
    const sorted = [...values].sort((a, b) => a - b);
    const q = (p: number) => (sorted.length >= 3 ? percentile(sorted, p) : null);
    return { hour, count: sorted.length, p10: q(0.1), p25: q(0.25), p50: q(0.5), p75: q(0.75), p90: q(0.9) };
  });
}
