import { activeSettings, type DoseSettingsData, itemCarbs, type LogEntryData, type LogItemData, type Synced } from '@carbbook/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { useCatalogData, useEligibleDoseVersions } from '../app/hooks';
import { useServices } from '../app/services';
import { buildCatalog, type CatalogData } from '../db/catalog';
import { isLive } from '../db/db';
import { type Change, dataOf } from '../db/store';
import { estimateFor } from '../dose/dose';
import { DoseCard } from '../ui/DoseCard';
import { formatCarbs, fromDateTimeLocal, parseNonNegative, toDateTimeLocal, unitLabel } from '../ui/format';
import { itemName } from '../ui/ItemEditor';

export function LogEntryEditor(props: { entryId: string; onDone: () => void }) {
  const { db } = useServices();
  const loaded = useLiveQuery(
    async () => ({
      entry: await db.log_entry.get(props.entryId),
      items: await db.log_item.where('log_entry_id').equals(props.entryId).filter(isLive).toArray(),
    }),
    [db, props.entryId],
  );
  const data = useCatalogData();
  // Never the raw dose_settings table: excludes any version with a recorded server rejection
  // (spec safety rule — "pass rejected settings exclusion" for the recalculate flow).
  const versions = useEligibleDoseVersions();
  if (!loaded || !data || !versions) return <p>Loading…</p>;
  if (!loaded.entry || loaded.entry.deleted === 1) {
    return (
      <div className="screen">
        <p>This entry was deleted.</p>
        <button type="button" onClick={props.onDone}>
          Back
        </button>
      </div>
    );
  }
  return <EntryForm entry={loaded.entry} items={loaded.items} data={data} versions={versions} onDone={props.onDone} />;
}

function EntryForm(props: {
  entry: Synced<LogEntryData>;
  items: Synced<LogItemData>[];
  data: CatalogData;
  versions: Synced<DoseSettingsData>[];
  onDone: () => void;
}) {
  const { entry, items, data, versions } = props;
  const { store, now } = useServices();
  const [eatenText, setEatenText] = useState(toDateTimeLocal(entry.eaten_at));
  const [bgText, setBgText] = useState(entry.bg_mgdl == null ? '' : String(entry.bg_mgdl));
  const [takenText, setTakenText] = useState(entry.taken_units == null ? '' : String(entry.taken_units));
  const [notes, setNotes] = useState(entry.notes ?? '');
  const [rows, setRows] = useState(items);
  const [message, setMessage] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const eatenAt = fromDateTimeLocal(eatenText) ?? Number.NaN;
  const bg = parseNonNegative(bgText);
  const total = rows.reduce((sum, row) => sum + row.carbs_g, 0);
  const settings = versions.find((v) => v.id === entry.settings_version_id) ?? activeSettings(versions, eatenAt);
  const estimate = settings
    ? estimateFor({ settings, windowName: entry.window_name, eatenAt, carbs: { carbs_g: total, complete: true }, bg })
    : null;

  /** Spec §8: refresh each item's carbs snapshot from current food/meal data via core. */
  function recalculate() {
    const catalog = buildCatalog(data);
    const kept: string[] = [];
    setRows(
      rows.map((row) => {
        const result = itemCarbs(catalog, row.ref_type, row.ref_id, row.amount, row.unit);
        if (!result.complete) {
          kept.push(row.display_name);
          return row;
        }
        return { ...row, carbs_g: result.carbs_g, display_name: itemName(catalog, row.ref_type, row.ref_id) };
      }),
    );
    setMessage(
      kept.length > 0
        ? `Kept the logged carbs for ${kept.join(', ')}: no complete carb data now.`
        : 'Recalculated from current foods and meals. Save to keep it.',
    );
  }

  async function save() {
    const problems: string[] = [];
    if (!Number.isFinite(eatenAt)) problems.push('Enter when you ate.');
    if (bgText.trim() !== '' && bg === null) problems.push('BG must be a number.');
    const taken = parseNonNegative(takenText);
    if (takenText.trim() !== '' && taken === null) problems.push('Taken dose must be a number.');
    setErrors(problems);
    if (problems.length > 0) return;
    const bgChanged = bg !== entry.bg_mgdl;
    const changes: Change[] = [
      {
        table: 'log_entry',
        data: {
          ...dataOf<'log_entry'>(entry),
          eaten_at: eatenAt,
          bg_mgdl: bg,
          bg_source: bgChanged ? (bg === null ? 'none' : 'manual') : entry.bg_source,
          bg_trend: bgChanged ? null : (entry.bg_trend ?? null),
          total_carbs_g: total,
          suggested_units: estimate?.ok ? estimate.units : null,
          taken_units: taken,
          notes: notes.trim() || null,
        },
      },
    ];
    for (const row of rows) {
      const original = items.find((i) => i.id === row.id);
      if (original && (original.carbs_g !== row.carbs_g || original.display_name !== row.display_name)) {
        changes.push({ table: 'log_item', data: dataOf<'log_item'>(row) });
      }
    }
    await store.saveMany(changes);
    props.onDone();
  }

  async function remove() {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    for (const item of items) await store.remove('log_item', item.id);
    await store.remove('log_entry', entry.id);
    props.onDone();
  }

  return (
    <div className="screen editor">
      <h1>Edit log entry</h1>
      <label>
        Eaten at
        <input type="datetime-local" value={eatenText} onChange={(e) => setEatenText(e.target.value)} />
      </label>
      <p>Window: {entry.window_name ?? 'none'}</p>
      <label>
        BG (mg/dL)
        <input inputMode="numeric" value={bgText} onChange={(e) => setBgText(e.target.value)} />
      </label>
      <h2>Items</h2>
      <ul className="list">
        {rows.map((row) => (
          <li key={row.id} data-testid="log-item" className="log-item">
            <span>
              {row.display_name} · {row.amount} {unitLabel(row.unit, data.portions.filter((p) => p.food_id === row.ref_id))}
            </span>
            <span>{formatCarbs(row.carbs_g)}</span>
          </li>
        ))}
      </ul>
      <button type="button" onClick={recalculate}>
        Recalculate from current meal
      </button>
      {message && <p role="status">{message}</p>}
      <p className="total" data-testid="entry-carbs">
        Total {formatCarbs(total)} carbs
      </p>
      <DoseCard estimate={estimate} hasItems={rows.length > 0} bg={bg} lastDoseAt={null} now={now()} />
      <label>
        Taken dose (u)
        <input inputMode="decimal" value={takenText} onChange={(e) => setTakenText(e.target.value)} />
      </label>
      <label>
        Notes
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
      </label>
      {errors.length > 0 && (
        <ul role="alert" className="errors">
          {errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      )}
      <div className="button-row">
        <button type="button" className="primary" onClick={() => void save()}>
          Save
        </button>
        <button type="button" onClick={props.onDone}>
          Cancel
        </button>
        <button type="button" className="danger" onClick={() => void remove()}>
          {confirmDelete ? 'Tap again to delete' : 'Delete entry'}
        </button>
      </div>
    </div>
  );
}
