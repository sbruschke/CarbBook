import type { GoalStatus, Report, ReportEntry } from '@carbbook/core';
import { GOAL_WORDS } from '../plan/goal';

/**
 * The printable log report as one self-contained HTML document (log export spec 2026-10-07). The
 * browser's print dialog turns it into the PDF ("Save as PDF"); iOS renders its own copy of this
 * layout (`LogReportHtml.swift`) — keep the two in step.
 *
 * Laid out for paper: US Letter, black on white, one table per day, a row never split across pages,
 * goal colours backed by words so a black-and-white print still reads.
 */
/**
 * CGM history pieces, already rendered by the platform (charts are `bg/chart.ts`). Every part is
 * optional: without a connection the report simply has no CGM sections, plus `note` saying why.
 */
export interface ReportBg {
  /** The "Blood sugar (CGM)" block under the summary. */
  summaryHtml: string | null;
  /** Per day key: chart + stats line, shown above that day's table. */
  dayHtml: Record<string, string>;
  /** Per entry id: "BG 112 → peak 210 (+55 min) · 2 h after 180". */
  mealText: Record<string, string>;
  /** Shown in place of the CGM block when there is none, e.g. "BG history needs a connection." */
  note: string | null;
}

export interface ReportLabels {
  /** "Sep 30 – Oct 6, 2026" */
  range: string;
  /** "10/7/26, 12:24 PM CDT" */
  generated: string;
  /** Heading for a day key: "Tuesday, October 6". */
  day: (key: string) => string;
}

const esc = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const trim = (n: number, digits: number): string => String(Number(n.toFixed(digits)));
const grams = (n: number): string => `${Number.isFinite(n) ? trim(n, 1) : '–'} g`;
const units = (n: number | null): string => (n === null || !Number.isFinite(n) ? '–' : `${trim(n, 2)} u`);
const bg = (n: number | null): string => (n === null || !Number.isFinite(n) ? '–' : trim(n, 0));

export const REPORT_CSS = `
@page { size: letter; margin: 0.6in 0.55in; }
* { box-sizing: border-box; }
body { margin: 0; color: #1c2419; background: #fff; font: 10.5pt/1.35 -apple-system, 'Helvetica Neue', 'Segoe UI', Roboto, Arial, sans-serif;
  -webkit-print-color-adjust: exact; print-color-adjust: exact; }
header { border-bottom: 2px solid #1b5e20; padding-bottom: 8px; margin-bottom: 14px; }
h1 { font-size: 18pt; margin: 0; color: #1b5e20; }
.sub { color: #5d6b59; margin-top: 2px; }
.summary { display: table; width: 100%; border-collapse: separate; border-spacing: 6px 0; margin: 0 -6px 16px; }
.tile { display: table-cell; width: 25%; border: 1px solid #d7ddd3; border-radius: 8px; padding: 8px 10px; vertical-align: top; }
.tile .k { font-size: 8.5pt; text-transform: uppercase; letter-spacing: 0.04em; color: #5d6b59; }
.tile .v { font-size: 15pt; font-weight: 700; }
.tile .d { font-size: 8.5pt; color: #5d6b59; }
section.day { margin-bottom: 14px; }
.day h2 { font-size: 12pt; margin: 0 0 4px; padding: 5px 8px; background: #e8f5e9; border-radius: 6px; page-break-after: avoid; break-after: avoid; }
.day h2 .tot { float: right; font-weight: 400; color: #1c2419; }
.empty { color: #5d6b59; font-style: italic; padding: 2px 8px; }
table { width: 100%; border-collapse: collapse; table-layout: fixed; }
col.c-time { width: 12%; } col.c-meal { width: 19%; } col.c-bg { width: 8%; } col.c-carbs { width: 31%; } col.c-sug { width: 15%; } col.c-taken { width: 15%; }
th { text-align: left; font-size: 8.5pt; text-transform: uppercase; letter-spacing: 0.04em; color: #5d6b59; font-weight: 600; padding: 3px 8px; border-bottom: 1px solid #d7ddd3; }
td { padding: 5px 8px 1px; vertical-align: top; }
td.n, th.n { text-align: right; white-space: nowrap; }
tbody { page-break-inside: avoid; break-inside: avoid; border-bottom: 1px solid #eceee9; }
tr.items td, tr.note td { padding-top: 0; padding-bottom: 5px; font-size: 9pt; color: #3d4a39; }
tr.note td { font-style: italic; }
.time { white-space: nowrap; font-weight: 600; }
.goal { display: inline-block; padding: 0 6px; border-radius: 4px; white-space: nowrap; }
.goal .w { font-size: 8pt; }
.goal-in { color: #0f6b3a; background: #e6f4ec; }
.goal-near { color: #6b5200; background: #fbf3d5; }
.goal-off { color: #8a3f00; background: #fbe9dc; }
.goal-out { color: #8a1418; background: #fbe3e4; }
.it { white-space: nowrap; }
.it:not(:last-child)::after { content: ' ·'; color: #9aa596; }
.cgm { border: 1px solid #d7ddd3; border-radius: 8px; padding: 8px 10px 6px; margin: 0 0 16px; page-break-inside: avoid; break-inside: avoid; }
.cgm h3 { font-size: 10pt; margin: 0 0 6px; }
.cgm .line { margin: 6px 0 2px; }
.daybg { margin: 2px 0 4px; page-break-inside: avoid; break-inside: avoid; }
.daybg svg { display: block; width: 100%; height: auto; }
.daybg .line, .cgm .line { font-size: 8.5pt; color: #3d4a39; }
tr.bgrow td { padding-top: 0; padding-bottom: 5px; font-size: 8.5pt; color: #1b5e20; }
.tir-bar { display: flex; height: 12px; border-radius: 4px; overflow: hidden; background: #eceee9; }
.tir-bar span { display: block; min-width: 2px; }
.tir-legend { margin-top: 4px; font-size: 8.5pt; color: #3d4a39; }
.tir-key { margin-right: 12px; white-space: nowrap; }
.tir-key i { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 4px; }
footer { margin-top: 18px; font-size: 8.5pt; color: #5d6b59; border-top: 1px solid #d7ddd3; padding-top: 6px; }
`;

function goalCell(entry: ReportEntry): string {
  const status: GoalStatus = entry.goal_status;
  const range = entry.goal ? ` <span class="w">/ ${trim(entry.goal.min, 1)}–${trim(entry.goal.max, 1)}</span>` : '';
  const word = GOAL_WORDS[status] ? ` <span class="w">${esc(GOAL_WORDS[status])}</span>` : '';
  return `<span class="goal goal-${status}">${grams(entry.carbs_g)}${range}${word}</span>`;
}

function entryRows(entry: ReportEntry, bgText: string | undefined): string {
  const items = entry.items
    .map((item) => `<span class="it">${esc(item.name)}${item.amount ? ` ${esc(item.amount)}` : ''} — ${grams(item.carbs_g)}</span>`)
    // A real space between items is the only place a long list of items can wrap.
    .join(' ');
  return [
    '<tbody>',
    `<tr><td class="time">${esc(entry.time)}</td><td>${esc(entry.window_name ?? '—')}</td><td class="n">${bg(entry.bg_mgdl)}</td>`,
    `<td class="n">${goalCell(entry)}</td><td class="n">${units(entry.suggested_units)}</td><td class="n"><strong>${units(entry.taken_units)}</strong></td></tr>`,
    items ? `<tr class="items"><td></td><td colspan="5">${items}</td></tr>` : '',
    bgText ? `<tr class="bgrow"><td></td><td colspan="5">After: ${esc(bgText)}</td></tr>` : '',
    entry.notes ? `<tr class="note"><td></td><td colspan="5">Note: ${esc(entry.notes)}</td></tr>` : '',
    '</tbody>',
  ].join('');
}

function tile(key: string, value: string, detail: string): string {
  return `<div class="tile"><div class="k">${esc(key)}</div><div class="v">${esc(value)}</div><div class="d">${esc(detail)}</div></div>`;
}

export function reportHtml(report: Report, labels: ReportLabels, cgm: ReportBg | null = null): string {
  const s = report.summary;
  const withGoal = s.entries - s.goal_counts.none;
  const offGoal = (['near', 'off', 'out'] as const)
    .filter((k) => s.goal_counts[k] > 0)
    .map((k) => `${s.goal_counts[k]} ${GOAL_WORDS[k]}`)
    .join(' · ');
  const tiles = [
    tile('Entries', String(s.entries), `${s.logged_days} of ${s.days} ${s.days === 1 ? 'day' : 'days'} logged`),
    tile('Carbs', grams(s.carbs_g), s.avg_carbs_per_logged_day === null ? 'no days logged' : `avg ${grams(s.avg_carbs_per_logged_day)} / logged day`),
    tile('Insulin taken', units(s.taken_units), s.avg_taken_per_logged_day === null ? 'no days logged' : `avg ${units(s.avg_taken_per_logged_day)} / logged day`),
    tile(
      'BG at meals',
      s.avg_bg === null ? '–' : `avg ${bg(s.avg_bg)}`,
      s.avg_bg === null ? 'no readings' : `range ${bg(s.min_bg)}–${bg(s.max_bg)} · ${s.bg_readings} ${s.bg_readings === 1 ? 'reading' : 'readings'}`,
    ),
  ].join('');
  const goalLine =
    withGoal > 0 ? `<p class="sub">Carb goals: ${s.goal_counts.in} of ${withGoal} on target${offGoal ? ` · ${esc(offGoal)}` : ''}</p>` : '';
  const days = report.days
    .map((day) => {
      const heading = `<h2>${esc(labels.day(day.day))}${
        day.entries.length > 0 ? `<span class="tot">${grams(day.carbs_g)} carbs · ${units(day.taken_units)} taken</span>` : ''
      }</h2>`;
      const chart = cgm?.dayHtml[day.day] ? `<div class="daybg">${cgm.dayHtml[day.day]}</div>` : '';
      if (day.entries.length === 0) return `<section class="day">${heading}${chart}<div class="empty">Nothing logged</div></section>`;
      return `<section class="day">${heading}${chart}<table><colgroup><col class="c-time"><col class="c-meal"><col class="c-bg"><col class="c-carbs"><col class="c-sug"><col class="c-taken"></colgroup><thead><tr><th>Time</th><th>Meal</th><th class="n">BG</th><th class="n">Carbs / goal</th><th class="n">Suggested</th><th class="n">Taken</th></tr></thead>${day.entries
        .map((entry) => entryRows(entry, cgm?.mealText[entry.id]))
        .join('')}</table></section>`;
    })
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>CarbBook log ${esc(labels.range)}</title><style>${REPORT_CSS}</style></head><body><header><h1>CarbBook log</h1><div class="sub">${esc(labels.range)}</div></header><div class="summary">${tiles}</div>${goalLine}${
    cgm?.summaryHtml ? `<section class="cgm">${cgm.summaryHtml}</section>` : cgm?.note ? `<p class="sub">${esc(cgm.note)}</p>` : ''
  }${days}<footer>Generated ${esc(labels.generated)} by CarbBook. Suggested doses are what the app estimated at the time; Taken is what was recorded.</footer></body></html>`;
}
