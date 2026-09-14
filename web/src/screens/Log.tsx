import type { LogItemData, Synced } from '@carbbook/core';
import { useState } from 'react';
import { useLogData } from '../app/hooks';
import { useServices } from '../app/services';
import { LogEntryEditor } from '../log/LogEntryEditor';
import { dayKey, dayRange, formatCarbs, formatTime, formatUnits, shiftDay } from '../ui/format';

export function Log() {
  const { now } = useServices();
  const log = useLogData();
  const [day, setDay] = useState(() => dayKey(now()));
  const [editing, setEditing] = useState<string | null>(null);

  if (editing) return <LogEntryEditor entryId={editing} onDone={() => setEditing(null)} />;
  if (!log) return <p>Loading…</p>;

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
        {entries.map((entry) => (
          <li key={entry.id}>
            <button type="button" className="list-item" onClick={() => setEditing(entry.id)}>
              <span>
                <strong>{formatTime(entry.eaten_at)}</strong> {entry.window_name ?? ''}
              </span>
              <span>
                {formatCarbs(entry.total_carbs_g)} carbs · BG {entry.bg_mgdl ?? '–'} · est.{' '}
                {entry.suggested_units == null ? '–' : formatUnits(entry.suggested_units)} · took{' '}
                {entry.taken_units == null ? '–' : formatUnits(entry.taken_units)}
              </span>
              <span className="muted">{(itemsByEntry.get(entry.id) ?? []).map((i) => i.display_name).join(', ')}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
