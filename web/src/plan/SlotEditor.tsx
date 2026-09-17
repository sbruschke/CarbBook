import { sumCarbs, type PlanEntryData } from '@carbbook/core';
import { useState } from 'react';
import { useUsdaPicks } from '../app/hooks';
import { useServices } from '../app/services';
import { buildCatalog, type CatalogData } from '../db/catalog';
import { parseUsdaFoodId, uuidv7 } from '../lib/ids';
import type { SearchResult } from '../search/search';
import { formatDayLabel } from '../ui/format';
import { type DraftItem, draftAmount, draftItemCarbs, ItemEditor, newDraftItem, newQuickItem } from '../ui/ItemEditor';
import { SearchPanel } from '../ui/SearchPanel';
import { goalView } from './goal';
import { removeSlot, saveSlot } from './saveSlot';
import type { Slot } from './slots';

/**
 * Edits one plan slot with the same picker as the Calculator and the meal editor: search →
 * `DraftItem` rows with amount text (fractions allowed) + `UnitPicker`.
 */
export function SlotEditor(props: {
  date: string;
  windowName: string;
  /** The existing slot, or null for an empty one. */
  slot: Slot | null;
  data: CatalogData;
  onDone: () => void;
}) {
  const { date, windowName, slot, data } = props;
  const { store, now } = useServices();
  const usda = useUsdaPicks();
  const [entryId] = useState(() => slot?.entry?.id ?? uuidv7(now()));
  const [originalItemIds] = useState(() => (slot?.items ?? []).map((i) => i.id));
  const [items, setItems] = useState<DraftItem[]>(() =>
    (slot?.items ?? []).map((i) => ({ key: i.id, ref_type: i.ref_type, ref_id: i.ref_id, amount: String(i.amount), unit: i.unit, label: i.label ?? '' })),
  );
  const [note, setNote] = useState(slot?.entry?.note ?? '');
  const [errors, setErrors] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const catalog = buildCatalog(data, usda.entries);
  const carbs = sumCarbs(items.map((item) => draftItemCarbs(catalog, item)));

  async function pick(result: SearchResult) {
    let target = catalog;
    if (result.kind === 'usda') {
      const entry = await usda.add(parseUsdaFoodId(result.id)!);
      if (!entry) return;
      target = buildCatalog(data, [...usda.entries, entry]);
    }
    setItems((current) => [...current, newDraftItem(target, result.kind === 'meal' ? 'meal' : 'food', result.id, uuidv7(now()))]);
  }

  async function save() {
    const problems: string[] = [];
    if (items.length === 0) problems.push('Add at least one item, or delete the slot.');
    if (items.some((i) => draftAmount(i) === null)) problems.push('Every item needs an amount.');
    setErrors(problems);
    if (problems.length > 0) return;
    const entry: PlanEntryData = {
      id: entryId,
      date,
      // Trimmed to match the server's stored form — it trims window_name and compares slots
      // case-insensitively, so an untrimmed value here would still collide there.
      window_name: windowName.trim(),
      // Editing a slot never claims it was eaten; only logging from a loaded slot sets `logged`.
      status: slot?.entry?.status === 'logged' ? 'logged' : 'planned',
      note: note.trim() || null,
      log_entry_id: slot?.entry?.log_entry_id ?? null,
    };
    const keys = new Set(items.map((i) => i.key));
    await saveSlot(store, entry, items, originalItemIds.filter((id) => !keys.has(id)));
    props.onDone();
  }

  async function remove() {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    if (slot?.entry) await removeSlot(store, slot.entry.id, originalItemIds);
    props.onDone();
  }

  return (
    <div className="screen editor">
      <h1>
        {windowName} · {formatDayLabel(date)}
      </h1>
      <ItemEditor items={items} catalog={catalog} onChange={setItems} reorderable />
      <SearchPanel
        label="Add to this slot"
        onPick={(result) => void pick(result)}
        onAddCarbs={() => setItems((current) => [...current, newQuickItem(uuidv7(now()))])}
      />
      {(() => {
        const view = goalView(carbs, slot?.goal ?? null);
        return (
          <p className="total" data-testid="slot-carbs">
            <span className={view.className} aria-label={view.ariaLabel}>
              <span aria-hidden="true">{view.text}</span>
              {view.word && (
                <span className="goal-word" aria-hidden="true">
                  {view.word}
                </span>
              )}
            </span>
          </p>
        );
      })()}
      <label>
        Note
        <textarea value={note} onChange={(e) => setNote(e.target.value)} />
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
          Save slot
        </button>
        <button type="button" onClick={props.onDone}>
          Cancel
        </button>
        {slot?.entry && (
          <button type="button" className="danger" onClick={() => void remove()}>
            {confirmDelete ? 'Tap again to delete' : 'Delete slot'}
          </button>
        )}
      </div>
    </div>
  );
}
