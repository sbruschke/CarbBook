import { activeSettings, type Catalog, type LogItemData, type StackEntry, type Synced } from '@carbbook/core';
import { useState } from 'react';
import { BgDay, BgTrends } from '../bg/BgViews';
import { useCatalogData, useEligibleDoseVersions, useLogData } from '../app/hooks';
import { useServices } from '../app/services';
import { buildCatalog } from '../db/catalog';
import { fetchBgRange } from '../bg/history';
import { logReport, printReport, reportBg, reportLabels } from '../log/exportReport';
import { LogEntryEditor } from '../log/LogEntryEditor';
import { reportHtml } from '../log/reportHtml';
import { goalView } from '../plan/goal';
import { dayKey, dayRange, formatCarbs, formatTime, formatUnits, shiftDay } from '../ui/format';
import { ImageStack } from '../ui/ImageStack';
import { itemRecord } from '../ui/ItemEditor';

/** Stack entries for logged rows: the image from the catalog, the carbs as logged. */
function stackEntries(catalog: Catalog, items: Synced<LogItemData>[]): StackEntry[] {
  return items.map((item) => ({
    imageId: itemRecord(catalog, item.ref_type, item.ref_id)?.image_id ?? null,
    carbs: Number.isFinite(item.carbs_g) ? item.carbs_g : null,
  }));
}

export function Log() {
  const { api, now } = useServices();
  const log = useLogData();
  const versions = useEligibleDoseVersions();
  // The catalog is what turns a logged item's ref into its food's or meal's photo. One live query
  // for the screen, never one per row.
  const data = useCatalogData();
  const [day, setDay] = useState(() => dayKey(now()));
  const [editing, setEditing] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [view, setView] = useState<'days' | 'trends'>('days');

  if (editing) return <LogEntryEditor entryId={editing} onDone={() => setEditing(null)} />;
  if (!log || !versions || !data) return <p>Loading…</p>;
  const catalog = buildCatalog(data);

  const [start, end] = dayRange(day);
  const entries = log.entries.filter((e) => e.eaten_at >= start && e.eaten_at < end).sort((a, b) => a.eaten_at - b.eaten_at);
  const itemsByEntry = new Map<string, Synced<LogItemData>[]>();
  for (const item of log.items) itemsByEntry.set(item.log_entry_id, [...(itemsByEntry.get(item.log_entry_id) ?? []), item]);
  const totalCarbs = entries.reduce((sum, e) => sum + e.total_carbs_g, 0);
  const totalTaken = entries.reduce((sum, e) => sum + (e.taken_units ?? 0), 0);

  return (
    <div className="screen">
      <h1>Log</h1>
      <div className="segmented" role="tablist" aria-label="Log view">
        <button type="button" role="tab" aria-selected={view === 'days'} onClick={() => setView('days')}>
          Days
        </button>
        <button type="button" role="tab" aria-selected={view === 'trends'} onClick={() => setView('trends')}>
          BG trends
        </button>
      </div>
      {view === 'trends' ? (
        <BgTrends entries={log.entries} />
      ) : (
        <>
      {exporting ? (
        <ExportCard
          defaultTo={day}
          onExport={async (from, to) => {
            const report = logReport({ from, to, entries: log.entries, items: log.items, portions: data.portions, versions });
            // CGM history is fetched fresh for the range; offline, the report prints without it.
            const bg = await fetchBgRange(api, dayRange(from)[0], dayRange(to)[1], now());
            await printReport(reportHtml(report, reportLabels(from, to, now()), reportBg(bg, report, from, to)));
          }}
          onClose={() => setExporting(false)}
        />
      ) : (
        <div className="button-row">
          <button type="button" onClick={() => setExporting(true)}>
            Export PDF…
          </button>
        </div>
      )}
      <div className="day-nav">
        <button type="button" aria-label="Previous day" onClick={() => setDay(shiftDay(day, -1))}>
          ‹
        </button>
        <input type="date" aria-label="Day" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} />
        <button type="button" aria-label="Next day" onClick={() => setDay(shiftDay(day, 1))}>
          ›
        </button>
      </div>
      <p className="total" data-testid="day-totals">
        {formatCarbs(totalCarbs)} carbs · {formatUnits(totalTaken)} taken
      </p>
      <BgDay day={day} entries={entries} />
      {entries.length === 0 && <p className="muted">Nothing logged this day.</p>}
      <ul className="list">
        {entries.map((entry) => {
          // The entry's own settings version if it is still eligible, else whatever was active
          // then — the same precedence LogEntryEditor uses.
          const settings = versions.find((v) => v.id === entry.settings_version_id) ?? activeSettings(versions, entry.eaten_at);
          const goal = settings?.windows.find((w) => w.name === entry.window_name)?.carb_goal ?? null;
          const view = goalView({ carbs_g: entry.total_carbs_g, complete: true }, goal);
          const items = itemsByEntry.get(entry.id) ?? [];
          return (
            <li key={entry.id}>
              <button type="button" className="list-item" onClick={() => setEditing(entry.id)}>
                <span>
                  <strong>{formatTime(entry.eaten_at)}</strong> {entry.window_name ?? ''}
                </span>
                <span>
                  <span className={view.className} aria-label={view.ariaLabel}>
                    <span aria-hidden="true">{view.text}</span>
                    {view.word && (
                      <span className="goal-word" aria-hidden="true">
                        {view.word}
                      </span>
                    )}
                  </span>{' '}
                  · BG {entry.bg_mgdl ?? '–'} · est. {entry.suggested_units == null ? '–' : formatUnits(entry.suggested_units)} · took{' '}
                  {entry.taken_units == null ? '–' : formatUnits(entry.taken_units)}
                </span>
                <span className="muted log-entry-items">
                  {/* The log is where recognising what was eaten matters most, so the entry's
                      items show as a carb-ordered stack. Carbs are the logged snapshot already on
                      the row — no recomputation — and a quick row has no food, so it contributes
                      no photo but still counts towards the badge. */}
                  <ImageStack entries={stackEntries(catalog, items)} size={28} />
                  <span>{items.map((i) => i.display_name).join(', ')}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
        </>
      )}
    </div>
  );
}

const PRESETS = [7, 14, 30, 90];

/**
 * Log export spec: pick a range, then the browser's print dialog makes the PDF ("Save as PDF").
 * The range defaults to the week ending on the day being viewed.
 */
function ExportCard(props: { defaultTo: string; onExport: (from: string, to: string) => Promise<void>; onClose: () => void }) {
  const [to, setTo] = useState(props.defaultTo);
  const [from, setFrom] = useState(() => shiftDay(props.defaultTo, -6));
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (!from || !to) return setError('Choose both dates.');
    if (from > to) return setError('The start date is after the end date.');
    setError(null);
    try {
      await props.onExport(from, to);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The print view could not be opened.');
    }
  }

  return (
    <section className="card export-card" aria-label="Export log">
      <h2>Export log as PDF</h2>
      <div className="button-row">
        {PRESETS.map((days) => (
          <button
            key={days}
            type="button"
            onClick={() => {
              setFrom(shiftDay(to || props.defaultTo, -(days - 1)));
            }}
          >
            Last {days} days
          </button>
        ))}
      </div>
      <label>
        From
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
      </label>
      <label>
        To
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
      </label>
      <p className="hint">Opens the print dialog — choose “Save as PDF”.</p>
      {error && (
        <p role="alert" className="errors">
          {error}
        </p>
      )}
      <div className="button-row">
        <button type="button" className="primary" onClick={() => void run()}>
          Create PDF
        </button>
        <button type="button" onClick={props.onClose}>
          Close
        </button>
      </div>
    </section>
  );
}
