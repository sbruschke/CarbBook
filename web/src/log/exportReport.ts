import {
  activeSettings,
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
import type { ReportLabels } from './reportHtml';

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
