import { describe, expect, it } from 'vitest';
import vectors from '../../../testdata/log-report-vectors.json';
import { buildLogReport, clipItemsFromLog, type ClipItem, type ReportInput, type ReportSummary } from '../src/report';

const v = vectors as unknown as {
  tolerance: number;
  report_cases: {
    name: string;
    input: ReportInput;
    expect: {
      days: { day: string; entry_ids: string[]; carbs_g: number; taken_units: number; goal_statuses: string[] }[];
      summary: ReportSummary;
    };
  }[];
  clip_cases: { name: string; items: Parameters<typeof clipItemsFromLog>[0]; expect: ClipItem[] }[];
};

const close = (actual: number | null, expected: number | null, label: string) => {
  if (expected === null) return expect(actual, label).toBeNull();
  expect(Math.abs((actual ?? Number.NaN) - expected), label).toBeLessThanOrEqual(v.tolerance);
};

describe('log report vectors', () => {
  it('has cases to run', () => {
    expect(v.report_cases.length).toBeGreaterThan(0);
    expect(v.clip_cases.length).toBeGreaterThan(0);
  });
  for (const c of v.report_cases) {
    it(`report: ${c.name}`, () => {
      const report = buildLogReport(c.input);
      expect(report.days.map((d) => d.day)).toEqual(c.expect.days.map((d) => d.day));
      report.days.forEach((day, i) => {
        const want = c.expect.days[i]!;
        expect(day.entries.map((e) => e.id)).toEqual(want.entry_ids);
        expect(day.entries.map((e) => e.goal_status)).toEqual(want.goal_statuses);
        close(day.carbs_g, want.carbs_g, `${day.day} carbs`);
        close(day.taken_units, want.taken_units, `${day.day} taken`);
      });
      const s = report.summary;
      const w = c.expect.summary;
      expect([s.days, s.logged_days, s.entries, s.bg_readings]).toEqual([w.days, w.logged_days, w.entries, w.bg_readings]);
      for (const key of ['carbs_g', 'avg_carbs_per_logged_day', 'taken_units', 'avg_taken_per_logged_day', 'avg_bg', 'min_bg', 'max_bg'] as const) {
        close(s[key], w[key], key);
      }
      expect(s.goal_counts).toEqual(w.goal_counts);
    });
  }
  for (const c of v.clip_cases) {
    it(`clip: ${c.name}`, () => {
      expect(clipItemsFromLog(c.items)).toEqual(c.expect);
    });
  }
});

describe('buildLogReport', () => {
  it('counts a non-finite carb or dose figure as nothing', () => {
    const report = buildLogReport({
      days: ['d'],
      entries: [
        { id: 'x', day: 'd', eaten_at: 0, time: '', window_name: null, bg_mgdl: Number.NaN, carbs_g: Number.NaN, suggested_units: null, taken_units: Number.POSITIVE_INFINITY, notes: null, goal: null, items: [] },
        { id: 'y', day: 'd', eaten_at: 1, time: '', window_name: null, bg_mgdl: 100, carbs_g: 10, suggested_units: null, taken_units: 1, notes: null, goal: null, items: [] },
      ],
    });
    expect(report.days[0]!.carbs_g).toBe(10);
    expect(report.days[0]!.taken_units).toBe(1);
    expect(report.summary.avg_bg).toBe(100);
  });
});
