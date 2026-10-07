import { buildLogReport, type LogEntryData } from '@carbbook/core';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mealResponseText, statsLine } from '../src/bg/BgViews';
import { bgDayChartSvg, bgPatternSvg } from '../src/bg/chart';
import { clearBgCache } from '../src/bg/history';
import { reportBg } from '../src/log/exportReport';
import { reportHtml } from '../src/log/reportHtml';
import { Log } from '../src/screens/Log';
import { dayRange } from '../src/ui/format';
import { synced } from './helpers';
import { makeServices, NOW, renderWith, SEED_SETTINGS, seedSettings, type TestServices } from './render';

let services: TestServices;
afterEach(async () => {
  await services?.db.delete();
});
beforeEach(() => clearBgCache());

const MIN = 60_000;
const [DAY_START, DAY_END] = dayRange('2026-09-14');
/** A reading every 5 min across the test day: 110 steady, rising to 220 after lunch, one 60 low. */
const DAY_POINTS = Array.from({ length: 288 }, (_, i) => {
  const at = DAY_START + i * 5 * MIN;
  const sinceLunch = (at - (NOW - 60 * MIN)) / MIN;
  const mgdl = i === 20 ? 60 : sinceLunch > 5 && sinceLunch <= 125 ? 220 : 110;
  return { at, mgdl };
});

async function setup(readings: (from: number, to: number) => unknown) {
  services = makeServices();
  await seedSettings(services.db);
  await services.db.log_entry.put(
    synced<LogEntryData>({
      id: 'lunch', eaten_at: NOW - 60 * MIN, window_name: 'Lunch', bg_mgdl: 110, bg_source: 'manual', total_carbs_g: 60,
      suggested_units: 7, taken_units: 7, settings_version_id: SEED_SETTINGS.id, notes: null,
    }),
  );
  services.api.on('GET', '/api/bg/readings', (_body, path) => {
    const q = new URLSearchParams(path.split('?')[1]);
    return readings(Number(q.get('from')), Number(q.get('to')));
  });
  return userEvent.setup();
}

const inRange = (from: number, to: number) => ({ readings: DAY_POINTS.filter((p) => p.at >= from && p.at < to), earliest_at: DAY_START });

describe('BG on the Log', () => {
  it('charts the day with its stats in words', async () => {
    await setup(inRange);
    renderWith(<Log />, services);
    const stats = await screen.findByTestId('bg-day-stats');
    expect(stats).toHaveTextContent(/In range \d+% · avg \d+ · low 0% · high \d+% · 288 readings/);
    expect(document.querySelector('.bg-day svg polyline')).not.toBeNull();
    // The lunch marker is labelled with its carbs.
    expect(document.querySelector('.bg-day svg')!.textContent).toContain('60 g');
  });

  it('says why there is no chart when history is unavailable', async () => {
    services = makeServices();
    await seedSettings(services.db);
    renderWith(<Log />, services);
    expect(await screen.findByText('Could not load BG history.')).toBeInTheDocument();
  });

  it('shows how BG moved after a meal in the entry editor', async () => {
    const user = await setup(inRange);
    renderWith(<Log />, services);
    await user.click(await screen.findByRole('button', { name: /11:00 Lunch/ }));
    expect(await screen.findByTestId('meal-bg')).toHaveTextContent('BG 110 → peak 220 (+10 min) · 2 h after 220');
  });

  it('BG trends: time in range, summary numbers, pattern and after-meal table', async () => {
    const user = await setup(inRange);
    renderWith(<Log />, services);
    await user.click(await screen.findByRole('tab', { name: 'BG trends' }));
    expect(await screen.findByTestId('tir')).toHaveTextContent('In range');
    expect(screen.getByText('GMI')).toBeInTheDocument();
    // History starts on the test day, so the 14-day view says so instead of reporting 7% coverage.
    expect(screen.getByText(/BG history starts Sep 14/)).toBeInTheDocument();
    expect(screen.getByRole('row', { name: /Lunch 1 60 g \+110 220/ })).toBeInTheDocument();
  });
});

describe('BG charts and text', () => {
  it('breaks the line across a gap and dots out-of-range and lone readings', () => {
    const svg = bgDayChartSvg({
      start: 0,
      end: 3 * 3_600_000,
      points: [
        { at: 0, mgdl: 100 },
        { at: 5 * MIN, mgdl: 110 },
        { at: 60 * MIN, mgdl: 300 },
        { at: 120 * MIN, mgdl: 120 },
        { at: 125 * MIN, mgdl: 50 },
      ],
      hourLabel: () => 'h',
    });
    expect(svg.match(/<polyline/g)).toHaveLength(2);
    expect(svg.match(/<circle/g)).toHaveLength(2); // the lone 300 and the 50
  });

  it('escapes labels', () => {
    const svg = bgDayChartSvg({ start: 0, end: 3_600_000, points: [], meals: [{ at: 1, label: '<b>' }], hourLabel: () => '&' });
    expect(svg).toContain('&lt;b&gt;');
    expect(svg).toContain('No CGM readings');
    expect(bgPatternSvg([], () => '')).toContain('Not enough readings yet');
  });

  it('meal response text leaves out what is unknown', () => {
    expect(mealResponseText({ before: null, two_hour: null, peak: null, peak_minutes: null, rise: null })).toBeNull();
    expect(mealResponseText({ before: null, two_hour: 150, peak: 180, peak_minutes: 40, rise: null })).toBe('peak 180 (+40 min) · 2 h after 150');
    expect(mealResponseText({ before: 163, two_hour: 116, peak: 163, peak_minutes: 5, rise: 0 })).toBe('BG 163 → no rise · 2 h after 116');
  });

  it('statsLine', () => {
    expect(
      statsLine({ count: 10, coverage: 1, mean: 150.4, sd: 0, cv: 0, gmi: 0, min: 0, max: 0, bands: { very_low: 0.1, low: 0, in_range: 0.7, high: 0.1, very_high: 0.1 } }),
    ).toBe('In range 70% · avg 150 · low 10% · high 20% · 10 readings');
  });
});

describe('BG in the PDF', () => {
  const report = buildLogReport({
    days: ['2026-09-14'],
    entries: [
      { id: 'lunch', day: '2026-09-14', eaten_at: NOW - 60 * MIN, time: '11:00', window_name: 'Lunch', bg_mgdl: 110, carbs_g: 60, suggested_units: 7, taken_units: 7, notes: null, goal: null, items: [] },
    ],
  });

  it('adds the CGM summary, the day chart and the after-meal line', () => {
    const cgm = reportBg({ status: 'ok', points: DAY_POINTS, earliestAt: DAY_START, message: null }, report, '2026-09-14', '2026-09-14');
    const html = reportHtml(report, { range: 'r', generated: 'g', day: (d) => d }, cgm);
    expect(html).toContain('Blood sugar (CGM)');
    expect(html).toContain('GMI');
    expect(html).toContain('<div class="daybg"><svg');
    expect(html).toContain('After: BG 110 → peak 220 (+10 min) · 2 h after 220');
    expect(html).toContain('BG at meals');
  });

  it('prints without CGM, saying why, when history could not be fetched', () => {
    const cgm = reportBg({ status: 'error', points: [], earliestAt: null, message: 'BG history needs a connection.' }, report, '2026-09-14', '2026-09-14');
    const html = reportHtml(report, { range: 'r', generated: 'g', day: (d) => d }, cgm);
    expect(html).toContain('No CGM section: BG history needs a connection.');
    expect(html).not.toContain('class="daybg"');
  });
});
