import {
  activeSettings,
  bgStats,
  dailyPattern,
  mealResponse,
  buildLogReport,
  type DoseSettingsData,
  type LogEntryData,
  type LogItemData,
  type PortionData,
  type Report,
  type ReportEntryInput,
  type Synced,
} from '@carbbook/core';
import { dayKey, dayRange, formatTime, shiftDay, unitLabel } from '../ui/format';
import { hourLabel, hourLabelAt, mealResponseText, statsLine } from '../bg/BgViews';
import { bgDayChartSvg, bgPatternSvg, tirBarHtml } from '../bg/chart';
import type { BgRangeResult } from '../bg/history';
import type { ReportBg, ReportLabels } from './reportHtml';

/** Every day key from `from` to `to`, inclusive; empty when the range is backwards. */
export function daysBetween(from: string, to: string): string[] {
  const days: string[] = [];
  // 400 caps a typo'd year from building a document nobody can print.
  for (let day = from; day <= to && days.length < 400; day = shiftDay(day, 1)) days.push(day);
  return days;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Sep 30 – Oct 6, 2026", "Oct 6, 2026", or both years when the range crosses one. */
export function rangeLabel(from: string, to: string): string {
  const parts = (key: string) => key.split('-').map(Number) as [number, number, number];
  const [fy, fm, fd] = parts(from);
  const [ty, tm, td] = parts(to);
  if (from === to) return `${MONTHS[fm - 1]} ${fd}, ${fy}`;
  return fy === ty ? `${MONTHS[fm - 1]} ${fd} – ${MONTHS[tm - 1]} ${td}, ${ty}` : `${MONTHS[fm - 1]} ${fd}, ${fy} – ${MONTHS[tm - 1]} ${td}, ${ty}`;
}

/** "Tuesday, October 6" — the year is already in the range heading. */
export function dayHeading(key: string): string {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

/**
 * The report for `from`..`to` from the device's own copy of the log, so it works offline and
 * includes entries not yet pushed. Goals use the same settings precedence as the Log screen.
 */
export function logReport(args: {
  from: string;
  to: string;
  entries: Synced<LogEntryData>[];
  items: Synced<LogItemData>[];
  portions: PortionData[];
  versions: Synced<DoseSettingsData>[];
}): Report {
  const days = daysBetween(args.from, args.to);
  const [start] = dayRange(args.from);
  const [, end] = dayRange(args.to);
  const itemsByEntry = new Map<string, Synced<LogItemData>[]>();
  for (const item of args.items) itemsByEntry.set(item.log_entry_id, [...(itemsByEntry.get(item.log_entry_id) ?? []), item]);
  const entries = args.entries
    .filter((e) => e.deleted !== 1 && e.eaten_at >= start && e.eaten_at < end)
    .map((entry): ReportEntryInput => {
      const settings = args.versions.find((v) => v.id === entry.settings_version_id) ?? activeSettings(args.versions, entry.eaten_at);
      return {
        id: entry.id,
        day: dayKey(entry.eaten_at),
        eaten_at: entry.eaten_at,
        time: formatTime(entry.eaten_at),
        window_name: entry.window_name,
        bg_mgdl: entry.bg_mgdl,
        carbs_g: entry.total_carbs_g,
        suggested_units: entry.suggested_units,
        taken_units: entry.taken_units,
        notes: entry.notes ?? null,
        goal: settings?.windows.find((w) => w.name === entry.window_name)?.carb_goal ?? null,
        items: (itemsByEntry.get(entry.id) ?? [])
          .filter((i) => i.deleted !== 1)
          .map((item) => ({
            name: item.display_name,
            amount:
              item.ref_type === 'quick'
                ? ''
                : `${String(Number(item.amount.toFixed(2)))} ${unitLabel(item.unit, args.portions.filter((p) => p.food_id === item.ref_id))}`,
            carbs_g: item.carbs_g,
          })),
      };
    });
  return buildLogReport({ days, entries });
}

export function reportLabels(from: string, to: string, now: number): ReportLabels {
  return {
    range: rangeLabel(from, to),
    generated: new Date(now).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }),
    day: dayHeading,
  };
}

/**
 * Opens the print dialog for the report, where "Save as PDF" makes the file. A hidden iframe rather
 * than a new window: no popup to be blocked, and the app stays where it was. Resolves once the
 * dialog has been handed the document.
 */
export function printReport(html: string, doc: Document = document): Promise<void> {
  return new Promise((resolve, reject) => {
    const frame = doc.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
    frame.onload = () => {
      // Once only: printing ends with the frame removed, and a stray second load must not reprint.
      frame.onload = null;
      const win = frame.contentWindow;
      if (!win) return reject(new Error('The print view could not be opened.'));
      // Removed only after printing: Safari prints nothing from a frame that is already gone.
      win.addEventListener('afterprint', () => setTimeout(() => frame.remove(), 0));
      win.focus();
      win.print();
      resolve();
    };
    frame.srcdoc = html;
    doc.body.appendChild(frame);
  });
}

/**
 * The CGM parts of the report from a fetched range: summary (time in range, average, GMI, CV, sensor
 * data, and the daily pattern for ranges of 3+ days), a chart per day with its meals marked, and the
 * after-meal line per entry. Without history it is only a note, and the rest of the report stands.
 */
export function reportBg(bg: BgRangeResult, report: Report, from: string, to: string): ReportBg {
  const empty: ReportBg = { summaryHtml: null, dayHtml: {}, mealText: {}, note: null };
  if (bg.status !== 'ok') return { ...empty, note: `No CGM section: ${bg.message ?? 'BG history unavailable.'}` };
  if (bg.points.length === 0) return { ...empty, note: 'No CGM readings stored for this range.' };
  const [start] = dayRange(from);
  const [, end] = dayRange(to);
  const covered = Math.max(start, Math.min(end, bg.earliestAt ?? end));
  const stats = bgStats(bg.points, end - covered)!;
  const days = report.days.length;
  const line = `avg ${Math.round(stats.mean)} mg/dL · GMI ${stats.gmi.toFixed(1)}% · CV ${Math.round(stats.cv)}% · sensor data ${Math.round(stats.coverage * 100)}%`;
  const startNote =
    bg.earliestAt !== null && bg.earliestAt > start
      ? ` · history starts ${new Date(bg.earliestAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
      : '';
  const summaryHtml = [
    '<h3>Blood sugar (CGM) · time in range 70–180</h3>',
    tirBarHtml(stats),
    `<p class="line">${line}${startNote}</p>`,
    days >= 3 ? bgPatternSvg(dailyPattern(bg.points, (at) => new Date(at).getHours()), hourLabel, 150) : '',
  ].join('');
  const dayHtml: Record<string, string> = {};
  const mealText: Record<string, string> = {};
  for (const day of report.days) {
    const [dStart, dEnd] = dayRange(day.day);
    const points = bg.points.filter((p) => p.at >= dStart && p.at < dEnd);
    if (points.length === 0) continue;
    const dayStats = bgStats(points, dEnd - dStart)!;
    dayHtml[day.day] =
      bgDayChartSvg({
        start: dStart,
        end: dEnd,
        points,
        meals: day.entries.map((e) => ({ at: e.eaten_at, label: `${String(Number(e.carbs_g.toFixed(0)))} g` })),
        hourLabel: hourLabelAt,
        height: 120,
      }) + `<div class="line">${statsLine(dayStats)}</div>`;
    for (const entry of day.entries) {
      const text = mealResponseText(mealResponse(bg.points, entry.eaten_at));
      if (text) mealText[entry.id] = text;
    }
  }
  return { summaryHtml, dayHtml, mealText, note: null };
}
