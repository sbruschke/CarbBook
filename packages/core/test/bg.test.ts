import { describe, expect, it } from 'vitest';
import vectors from '../../../testdata/bg-stats-vectors.json';
import { type BgPoint, type BgStats, bgBand, bgStats, dailyPattern, type MealResponse, mealResponse, type PatternHour } from '../src/bg';

const v = vectors as unknown as {
  tolerance: number;
  stats_cases: { name: string; points: BgPoint[]; span_ms: number; expect: BgStats | null }[];
  meal_cases: { name: string; points: BgPoint[]; eaten_at: number; expect: MealResponse }[];
  pattern_cases: { name: string; points: BgPoint[]; expect: PatternHour[] }[];
};

const close = (a: number | null, b: number | null, label: string) => {
  if (b === null) return expect(a, label).toBeNull();
  expect(Math.abs((a ?? Number.NaN) - b), label).toBeLessThanOrEqual(v.tolerance);
};

describe('bg vectors', () => {
  it('has cases', () => {
    expect(v.stats_cases.length * v.meal_cases.length * v.pattern_cases.length).toBeGreaterThan(0);
  });
  for (const c of v.stats_cases) {
    it(`stats: ${c.name}`, () => {
      const s = bgStats(c.points, c.span_ms);
      if (c.expect === null) return expect(s).toBeNull();
      expect(s).not.toBeNull();
      for (const k of ['count', 'coverage', 'mean', 'sd', 'cv', 'gmi', 'min', 'max'] as const) close(s![k], c.expect[k], k);
      for (const k of Object.keys(c.expect.bands) as (keyof BgStats['bands'])[]) close(s!.bands[k], c.expect.bands[k], k);
    });
  }
  for (const c of v.meal_cases) {
    it(`meal: ${c.name}`, () => expect(mealResponse(c.points, c.eaten_at)).toEqual(c.expect));
  }
  for (const c of v.pattern_cases) {
    it(`pattern: ${c.name}`, () => {
      const got = dailyPattern(c.points, (at) => Math.floor(at / 3_600_000) % 24);
      expect(got.map((h) => [h.hour, h.count])).toEqual(c.expect.map((h) => [h.hour, h.count]));
      got.forEach((h, i) => {
        for (const k of ['p10', 'p25', 'p50', 'p75', 'p90'] as const) close(h[k], c.expect[i]![k], `${h.hour} ${k}`);
      });
    });
  }
});

describe('bgBand', () => {
  it('puts each edge in its consensus band', () => {
    expect([53, 54, 69, 70, 180, 181, 250, 251].map(bgBand)).toEqual(['very_low', 'low', 'low', 'in_range', 'in_range', 'high', 'high', 'very_high']);
  });
});
