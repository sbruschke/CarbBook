import { BG_HIGH, BG_LOW, type BgPoint, type BgStats, type PatternHour, bgBand } from '@carbbook/core';

/**
 * BG charts as self-contained SVG strings (BG history spec 2026-10-07), so the Log screen and the
 * printed PDF draw the exact same picture. iOS draws its screen charts with Swift Charts and its PDF
 * with a port of this file (`CarbBookKit/BgChartSvg.swift`) — keep the two in step.
 */
const W = 720;
const PAD = { left: 34, right: 10, top: 16, bottom: 20 };
const HOUR = 3_600_000;
/** A gap longer than this breaks the line instead of drawing across missing data. */
const GAP_MS = 15 * 60_000;

export const BAND_COLORS = {
  very_low: '#8a1418',
  low: '#c62828',
  in_range: '#2e7d32',
  high: '#b26a00',
  very_high: '#8a3f00',
} as const;

const esc = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const f = (n: number): string => String(Math.round(n * 10) / 10);

function yScale(points: { mgdl: number }[], height: number) {
  const top = Math.min(400, Math.max(300, Math.ceil(Math.max(0, ...points.map((p) => p.mgdl)) / 50) * 50));
  const bottom = 40;
  const plot = height - PAD.top - PAD.bottom;
  return { top, y: (mgdl: number) => PAD.top + plot * (1 - (Math.min(top, Math.max(bottom, mgdl)) - bottom) / (top - bottom)) };
}

function frame(height: number, top: number, y: (v: number) => number): string {
  const right = W - PAD.right;
  const ticks = [70, 180, ...(top >= 300 ? [300] : [])];
  return [
    `<rect x="${PAD.left}" y="${f(y(BG_HIGH))}" width="${right - PAD.left}" height="${f(y(BG_LOW) - y(BG_HIGH))}" fill="#e6f4ec"/>`,
    ...ticks.map(
      (t) =>
        `<line x1="${PAD.left}" x2="${right}" y1="${f(y(t))}" y2="${f(y(t))}" stroke="#c5cfc1" stroke-width="1" ${t === 300 ? '' : 'stroke-dasharray="3 3"'}/>` +
        `<text x="${PAD.left - 4}" y="${f(y(t) + 3.5)}" text-anchor="end" font-size="10" fill="#5d6b59">${t}</text>`,
    ),
    `<line x1="${PAD.left}" x2="${right}" y1="${height - PAD.bottom}" y2="${height - PAD.bottom}" stroke="#d7ddd3"/>`,
  ].join('');
}

export interface ChartMeal {
  at: number;
  /** Short label above the marker, e.g. "54 g". */
  label: string;
}

/**
 * One stretch of time — normally a local day — with the 70–180 target band, the reading line
 * (broken across gaps), each reading outside range dotted in its band colour, and meal markers.
 * `hourLabel` formats tick hours the platform's way ("6 AM" / "06").
 */
export function bgDayChartSvg(args: {
  start: number;
  end: number;
  points: BgPoint[];
  meals?: ChartMeal[];
  hourLabel: (at: number) => string;
  height?: number;
  title?: string;
}): string {
  const height = args.height ?? 170;
  const pts = args.points.filter((p) => p.at >= args.start && p.at < args.end && Number.isFinite(p.mgdl) && p.mgdl > 0).sort((a, b) => a.at - b.at);
  const { top, y } = yScale(pts, height);
  const span = args.end - args.start;
  const x = (at: number) => PAD.left + ((W - PAD.left - PAD.right) * (at - args.start)) / span;

  // Runs of readings with no gap longer than GAP_MS; each becomes one line.
  const runs: BgPoint[][] = [];
  for (const p of pts) {
    const run = runs[runs.length - 1];
    if (run && p.at - run[run.length - 1]!.at <= GAP_MS) run.push(p);
    else runs.push([p]);
  }
  const lines = runs
    .filter((run) => run.length > 1)
    .map((run) => `<polyline points="${run.map((p) => `${f(x(p.at))},${f(y(p.mgdl))}`).join(' ')}" fill="none" stroke="#1c2419" stroke-width="1.6" stroke-linejoin="round"/>`)
    .join('');
  // A dot for every reading out of range (so a low stands out in a dense line) and for a lone
  // reading between gaps, which would otherwise draw nothing at all.
  const dots = runs
    .flatMap((run) => run.filter((p) => run.length === 1 || bgBand(p.mgdl) !== 'in_range'))
    .map((p) => `<circle cx="${f(x(p.at))}" cy="${f(y(p.mgdl))}" r="1.8" fill="${BAND_COLORS[bgBand(p.mgdl)]}"/>`)
    .join('');

  const ticks: string[] = [];
  for (let t = Math.ceil(args.start / HOUR) * HOUR; t < args.end; t += HOUR) {
    const offset = Math.round((t - args.start) / HOUR);
    if (offset % 3 !== 0) continue;
    ticks.push(`<text x="${f(x(t))}" y="${height - 6}" text-anchor="middle" font-size="10" fill="#5d6b59">${esc(args.hourLabel(t))}</text>`);
  }
  const meals = (args.meals ?? [])
    .filter((m) => m.at >= args.start && m.at < args.end)
    .map(
      (m) =>
        `<line x1="${f(x(m.at))}" x2="${f(x(m.at))}" y1="${PAD.top}" y2="${height - PAD.bottom}" stroke="#1b5e20" stroke-width="1" stroke-dasharray="2 2" opacity="0.7"/>` +
        `<text x="${f(x(m.at))}" y="${PAD.top - 4}" text-anchor="middle" font-size="9.5" font-weight="600" fill="#1b5e20">${esc(m.label)}</text>`,
    )
    .join('');
  const empty = pts.length === 0 ? `<text x="${W / 2}" y="${height / 2}" text-anchor="middle" font-size="12" fill="#5d6b59">No CGM readings</text>` : '';
  const title = args.title ? `<title>${esc(args.title)}</title>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${height}" width="100%" role="img" class="bg-chart">${title}${frame(height, top, y)}${meals}${lines}${dots}${ticks.join('')}${empty}</svg>`;
}

/**
 * The daily pattern across many days: 10–90th percentile band, 25–75th band, median line, by local
 * hour. Hours with fewer than 3 readings are left out of the bands.
 */
export function bgPatternSvg(pattern: PatternHour[], hourLabel: (hour: number) => string, height = 190): string {
  const filled = pattern.filter((h) => h.p50 !== null);
  const { top, y } = yScale(filled.map((h) => ({ mgdl: h.p90! })), height);
  const x = (hour: number) => PAD.left + ((W - PAD.left - PAD.right) * hour) / 24;
  // Each hour is drawn at its middle, so 0:00–0:59 sits at x(0.5).
  const band = (lo: keyof PatternHour, hi: keyof PatternHour, fill: string) => {
    const runs: PatternHour[][] = [];
    let run: PatternHour[] = [];
    for (const h of pattern) {
      if (h[lo] === null) {
        if (run.length) runs.push(run);
        run = [];
      } else run.push(h);
    }
    if (run.length) runs.push(run);
    return runs
      .map((r) => {
        const upper = r.map((h) => `${f(x(h.hour + 0.5))},${f(y(h[hi] as number))}`);
        const lower = [...r].reverse().map((h) => `${f(x(h.hour + 0.5))},${f(y(h[lo] as number))}`);
        return `<polygon points="${[...upper, ...lower].join(' ')}" fill="${fill}"/>`;
      })
      .join('');
  };
  const median = filled.map((h) => `${f(x(h.hour + 0.5))},${f(y(h.p50!))}`).join(' ');
  const ticks = [0, 3, 6, 9, 12, 15, 18, 21]
    .map((h) => `<text x="${f(x(h))}" y="${height - 6}" text-anchor="middle" font-size="10" fill="#5d6b59">${esc(hourLabel(h))}</text>`)
    .join('');
  const empty = filled.length === 0 ? `<text x="${W / 2}" y="${height / 2}" text-anchor="middle" font-size="12" fill="#5d6b59">Not enough readings yet</text>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${height}" width="100%" role="img" class="bg-chart"><title>Daily BG pattern</title>${frame(height, top, y)}${band('p10', 'p90', 'rgba(27,94,32,0.14)')}${band('p25', 'p75', 'rgba(27,94,32,0.28)')}${
    filled.length > 1 ? `<polyline points="${median}" fill="none" stroke="#1b5e20" stroke-width="2"/>` : ''
  }${ticks}${empty}</svg>`;
}

const pct = (n: number): string => `${Math.round(n * 100)}%`;

/** Stacked time-in-range bar with the percentages written out (colour is never the only signal). */
export function tirBarHtml(stats: BgStats): string {
  const order = ['very_low', 'low', 'in_range', 'high', 'very_high'] as const;
  const names = { very_low: 'Very low', low: 'Low', in_range: 'In range', high: 'High', very_high: 'Very high' };
  const segs = order
    .filter((k) => stats.bands[k] > 0)
    .map((k) => `<span style="flex:${stats.bands[k]};background:${BAND_COLORS[k]}" title="${names[k]} ${pct(stats.bands[k])}"></span>`)
    .join('');
  const legend = order
    .map((k) => `<span class="tir-key"><i style="background:${BAND_COLORS[k]}"></i>${names[k]} ${pct(stats.bands[k])}</span>`)
    .join('');
  return `<div class="tir"><div class="tir-bar">${segs}</div><div class="tir-legend">${legend}</div></div>`;
}

/** CSS for `tirBarHtml`, shared by the app stylesheet and the PDF. */
export const TIR_CSS = `
.tir-bar { display: flex; height: 14px; border-radius: 4px; overflow: hidden; background: #eceee9; }
.tir-bar span { display: block; min-width: 2px; }
.tir-legend { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-top: 4px; font-size: 0.8em; color: #3d4a39; }
.tir-key i { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 4px; vertical-align: -1px; }
`;
