import {
  bgStats,
  type BgStats,
  dailyPattern,
  type LogEntryData,
  mealResponse,
  type MealResponse,
  type Synced,
} from '@carbbook/core';
import { useState } from 'react';
import { useServices } from '../app/services';
import { dayKey, dayRange, formatCarbs, shiftDay } from '../ui/format';
import { bgDayChartSvg, bgPatternSvg, tirBarHtml } from './chart';
import { useBgRange } from './history';

/** "6 AM" — the platform's own short hour. */
export const hourLabelAt = (at: number): string => new Date(at).toLocaleTimeString([], { hour: 'numeric' });
export const hourLabel = (hour: number): string => hourLabelAt(new Date(2000, 0, 1, hour).getTime());

const pct = (n: number) => `${Math.round(n * 100)}%`;
const mg = (n: number) => String(Math.round(n));

/** "In range 72% · avg 148 · low 3% · 286 readings" — the numbers behind a chart, in words. */
export function statsLine(stats: BgStats): string {
  const low = stats.bands.low + stats.bands.very_low;
  const high = stats.bands.high + stats.bands.very_high;
  return [`In range ${pct(stats.bands.in_range)}`, `avg ${mg(stats.mean)}`, `low ${pct(low)}`, `high ${pct(high)}`, `${stats.count} readings`].join(' · ');
}

/** The Log day's BG chart with the day's meals marked, and its stats line. */
export function BgDay(props: { day: string; entries: Synced<LogEntryData>[] }) {
  const [start, end] = dayRange(props.day);
  const bg = useBgRange(start, end);
  if (bg.status === 'loading') return <p className="muted bg-note">Loading BG…</p>;
  if (bg.status === 'error') return <p className="muted bg-note">{bg.message}</p>;
  if (bg.points.length === 0) {
    const before = bg.earliestAt !== null && end <= bg.earliestAt;
    return <p className="muted bg-note">{before ? 'BG history starts later than this day.' : 'No CGM readings this day.'}</p>;
  }
  const stats = bgStats(bg.points, end - start)!;
  const svg = bgDayChartSvg({
    start,
    end,
    points: bg.points,
    meals: props.entries.map((e) => ({ at: e.eaten_at, label: formatCarbs(e.total_carbs_g) })),
    hourLabel: hourLabelAt,
    title: `BG on ${props.day}`,
  });
  return (
    <section className="card bg-day" aria-label="BG this day">
      {/* The SVG is built from numbers and escaped labels only (bg/chart.ts). */}
      <div className="bg-chart-wrap" dangerouslySetInnerHTML={{ __html: svg }} />
      <p className="muted bg-stats" data-testid="bg-day-stats">
        {statsLine(stats)}
      </p>
    </section>
  );
}

/** "BG 112 → peak 210 (+55 min) · 2 h after 180" for one log entry, or nothing without data. */
export function mealResponseText(r: MealResponse): string | null {
  const parts: string[] = [];
  // A "peak" no higher than the starting BG is not a peak; say so rather than echo the same number.
  if (r.before !== null && r.rise !== null && r.rise <= 0) parts.push(`BG ${mg(r.before)} → no rise`);
  else if (r.before !== null) parts.push(`BG ${mg(r.before)}${r.peak !== null ? ` → peak ${mg(r.peak)} (+${r.peak_minutes} min)` : ''}`);
  else if (r.peak !== null) parts.push(`peak ${mg(r.peak)} (+${r.peak_minutes} min)`);
  if (r.two_hour !== null) parts.push(`2 h after ${mg(r.two_hour)}`);
  return parts.length ? parts.join(' · ') : null;
}

/** After-meal BG for the entry being edited (CGM history, display only). */
export function MealBg(props: { eatenAt: number }) {
  const from = props.eatenAt - 20 * 60_000;
  const to = props.eatenAt + 3 * 3_600_000 + 60_000;
  const bg = useBgRange(from, to);
  if (bg.status !== 'ok' || bg.points.length === 0 || !Number.isFinite(props.eatenAt)) return null;
  const text = mealResponseText(mealResponse(bg.points, props.eatenAt));
  if (!text) return null;
  return (
    <section className="card bg-meal" aria-label="BG after this meal">
      <div
        className="bg-chart-wrap"
        dangerouslySetInnerHTML={{
          __html: bgDayChartSvg({ start: from, end: to, points: bg.points, meals: [{ at: props.eatenAt, label: 'ate' }], hourLabel: hourLabelAt, height: 130 }),
        }}
      />
      <p className="muted bg-stats" data-testid="meal-bg">
        {text}
      </p>
    </section>
  );
}

const PRESETS = [7, 14, 30, 90];

interface WindowRow {
  name: string;
  meals: number;
  carbs: number;
  rises: number[];
  twoHours: number[];
}

const avg = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);

/** Trends over a range: time in range, the usual summary numbers, the daily pattern, and how each meal window tends to go. */
export function BgTrends(props: { entries: Synced<LogEntryData>[] }) {
  const { now } = useServices();
  const [days, setDays] = useState(14);
  const today = dayKey(now());
  const first = shiftDay(today, -(days - 1));
  const [start] = dayRange(first);
  const [, end] = dayRange(today);
  const bg = useBgRange(start, end);

  const header = (
    <div className="button-row" role="group" aria-label="Trend range">
      {PRESETS.map((d) => (
        <button key={d} type="button" aria-pressed={d === days} className={d === days ? 'primary' : undefined} onClick={() => setDays(d)}>
          {d} days
        </button>
      ))}
    </div>
  );
  if (bg.status === 'loading') return <section aria-label="BG trends">{header}<p className="muted">Loading BG…</p></section>;
  if (bg.status === 'error') return <section aria-label="BG trends">{header}<p className="muted">{bg.message}</p></section>;

  // Only the part of the range the history actually covers counts towards coverage.
  const covered = Math.max(start, Math.min(end, bg.earliestAt ?? end));
  const stats = bgStats(bg.points, end - covered);
  const pattern = dailyPattern(bg.points, (at) => new Date(at).getHours());
  const historyNote =
    bg.earliestAt !== null && bg.earliestAt > start
      ? `BG history starts ${new Date(bg.earliestAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}. Older readings can be imported from a Dexcom Clarity export.`
      : null;

  const windows = new Map<string, WindowRow>();
  for (const entry of props.entries) {
    if (entry.eaten_at < start || entry.eaten_at >= end) continue;
    const name = entry.window_name ?? 'Other';
    const row = windows.get(name) ?? { name, meals: 0, carbs: 0, rises: [], twoHours: [] };
    row.meals += 1;
    row.carbs += Number.isFinite(entry.total_carbs_g) ? entry.total_carbs_g : 0;
    const r = mealResponse(bg.points, entry.eaten_at);
    if (r.rise !== null) row.rises.push(r.rise);
    if (r.two_hour !== null) row.twoHours.push(r.two_hour);
    windows.set(name, row);
  }

  return (
    <section aria-label="BG trends" className="bg-trends">
      {header}
      {historyNote && <p className="hint">{historyNote}</p>}
      {!stats ? (
        <p className="muted">No CGM readings in this range.</p>
      ) : (
        <>
          <section className="card">
            <h2>Time in range (70–180)</h2>
            <div data-testid="tir" dangerouslySetInnerHTML={{ __html: tirBarHtml(stats) }} />
            <dl className="bg-tiles">
              <div>
                <dt>Average</dt>
                <dd>{mg(stats.mean)} mg/dL</dd>
              </div>
              <div>
                <dt>GMI</dt>
                <dd>{stats.gmi.toFixed(1)}%</dd>
              </div>
              <div>
                <dt>Variability (CV)</dt>
                <dd>
                  {Math.round(stats.cv)}% <span className="muted">{stats.cv <= 36 ? 'stable' : 'variable'}</span>
                </dd>
              </div>
              <div>
                <dt>Sensor data</dt>
                <dd>{pct(stats.coverage)}</dd>
              </div>
            </dl>
            {stats.coverage < 0.7 && <p className="hint">Under 70% sensor data — treat these numbers as rough.</p>}
          </section>
          <section className="card">
            <h2>Daily pattern</h2>
            <div className="bg-chart-wrap" dangerouslySetInnerHTML={{ __html: bgPatternSvg(pattern, hourLabel) }} />
            <p className="hint">Line: median by hour. Bands: middle 50% and 80% of readings.</p>
          </section>
          {windows.size > 0 && (
            <section className="card">
              <h2>After meals</h2>
              <table className="bg-windows">
                <thead>
                  <tr>
                    <th>Meal</th>
                    <th className="n">Logged</th>
                    <th className="n">Avg carbs</th>
                    <th className="n">Avg rise</th>
                    <th className="n">Avg 2 h after</th>
                  </tr>
                </thead>
                <tbody>
                  {[...windows.values()].map((w) => (
                    <tr key={w.name}>
                      <td>{w.name}</td>
                      <td className="n">{w.meals}</td>
                      <td className="n">{formatCarbs(w.carbs / w.meals)}</td>
                      <td className="n">{avg(w.rises) === null ? '–' : `+${mg(avg(w.rises)!)}`}</td>
                      <td className="n">{avg(w.twoHours) === null ? '–' : mg(avg(w.twoHours)!)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </>
      )}
    </section>
  );
}

