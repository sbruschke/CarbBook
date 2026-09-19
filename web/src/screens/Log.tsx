import { activeSettings, type Catalog, type LogItemData, type StackEntry, type Synced } from '@carbbook/core';
import { useState } from 'react';
import { useCatalogData, useEligibleDoseVersions, useLogData } from '../app/hooks';
import { useServices } from '../app/services';
import { buildCatalog } from '../db/catalog';
import { LogEntryEditor } from '../log/LogEntryEditor';
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
  const { now } = useServices();
  const log = useLogData();
  const versions = useEligibleDoseVersions();
  // The catalog is what turns a logged item's ref into its food's or meal's photo. One live query
  // for the screen, never one per row.
  const data = useCatalogData();
  const [day, setDay] = useState(() => dayKey(now()));
  const [editing, setEditing] = useState<string | null>(null);

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
    </div>
  );
}
