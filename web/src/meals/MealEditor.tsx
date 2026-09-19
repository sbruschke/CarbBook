import { itemCarbs, type MealData, wouldCreateCycle } from '@carbbook/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { useUsdaPicks } from '../app/hooks';
import { useServices } from '../app/services';
import { buildCatalog, type CatalogData } from '../db/catalog';
import { parseUsdaFoodId, uuidv7 } from '../lib/ids';
import type { SearchResult } from '../search/search';
import { formatCarbs, parseAmount, parseNonNegative } from '../ui/format';
import { ImagePicker } from '../ui/ImagePicker';
import { type DraftItem, draftAmount, ItemEditor, newDraftItem, newQuickItem } from '../ui/ItemEditor';
import { SearchPanel } from '../ui/SearchPanel';
import { saveMeal, withDraftMeal } from './saveMeal';

export function MealEditor(props: { data: CatalogData; mealId: string | null; onDone: () => void }) {
  const { data, mealId } = props;
  const { db, store, now } = useServices();
  const usda = useUsdaPicks();
  const existing = mealId ? data.meals.find((m) => m.id === mealId) : undefined;
  const [id] = useState(() => mealId ?? uuidv7(now()));
  const [originalItemIds] = useState(() => data.meal_items.filter((i) => i.meal_id === mealId).map((i) => i.id));
  const [name, setName] = useState(existing?.name ?? '');
  const [yieldText, setYieldText] = useState(String(existing?.yield_servings ?? 1));
  const [weightText, setWeightText] = useState(existing?.total_weight_g == null ? '' : String(existing.total_weight_g));
  const [notes, setNotes] = useState(existing?.notes ?? '');
  const [imageId, setImageId] = useState<string | null>(existing?.image_id ?? null);
  // Attribution lives on the synced `image` row, not on the meal, so it is read back here.
  const image = useLiveQuery(async () => (imageId ? await db.image.get(imageId) : undefined), [db, imageId]);
  const [items, setItems] = useState<DraftItem[]>(() =>
    data.meal_items
      .filter((i) => i.meal_id === mealId)
      .sort((a, b) => a.position - b.position)
      .map((i) => ({ key: i.id, ref_type: i.ref_type, ref_id: i.ref_id, amount: String(i.amount), unit: i.unit, label: i.label ?? '' })),
  );
  const [message, setMessage] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const meal: MealData = {
    id,
    name: name.trim(),
    yield_servings: parseAmount(yieldText) ?? Number.NaN,
    total_weight_g: weightText.trim() === '' ? null : (parseNonNegative(weightText) ?? Number.NaN),
    notes: notes.trim() || null,
    image_id: imageId,
  };
  const catalog = buildCatalog(withDraftMeal(data, meal, items), usda.entries);
  const perServing = itemCarbs(catalog, 'meal', id, 1, 'serving');
  const per100g = meal.total_weight_g != null && meal.total_weight_g > 0 ? itemCarbs(catalog, 'meal', id, 100, 'g') : null;

  async function pick(result: SearchResult) {
    setMessage(null);
    if (result.kind === 'meal' && wouldCreateCycle(catalog, id, result.id)) {
      setMessage(`Can't add ${result.name}: it already contains this meal.`);
      return;
    }
    let target = catalog;
    if (result.kind === 'usda') {
      const entry = await usda.add(parseUsdaFoodId(result.id)!);
      if (!entry) return;
      target = buildCatalog(withDraftMeal(data, meal, items), [...usda.entries, entry]);
    }
    setItems((current) => [...current, newDraftItem(target, result.kind === 'meal' ? 'meal' : 'food', result.id, uuidv7(now()))]);
  }

  async function save() {
    const problems: string[] = [];
    if (!meal.name) problems.push('Name is required.');
    if (!(meal.yield_servings > 0)) problems.push('Yield must be more than 0 servings.');
    if (meal.total_weight_g != null && !(meal.total_weight_g > 0)) problems.push('Total weight must be empty or more than 0 g.');
    if (items.length === 0) problems.push('Add at least one component.');
    if (items.some((i) => draftAmount(i) === null)) problems.push('Every component needs an amount.');
    setErrors(problems);
    if (problems.length > 0) return;
    const keys = new Set(items.map((i) => i.key));
    await saveMeal(store, meal, items, originalItemIds.filter((itemId) => !keys.has(itemId)));
    props.onDone();
  }

  async function remove() {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    for (const itemId of originalItemIds) await store.remove('meal_item', itemId);
    await store.remove('meal', id);
    props.onDone();
  }

  return (
    <div className="screen editor">
      <h1>{existing ? 'Edit meal' : 'New meal'}</h1>
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        Yield (servings)
        <input inputMode="text" placeholder="e.g. 2/3" value={yieldText} onChange={(e) => setYieldText(e.target.value)} />
      </label>
      <label>
        Total weight (g, optional)
        <input inputMode="decimal" value={weightText} onChange={(e) => setWeightText(e.target.value)} />
      </label>
      <h2>Components</h2>
      <ItemEditor items={items} catalog={catalog} onChange={setItems} reorderable />
      <SearchPanel
        label="Add a component"
        onPick={(result) => void pick(result)}
        onAddCarbs={() => setItems((current) => [...current, newQuickItem(uuidv7(now()))])}
      />
      {message && <p role="alert">{message}</p>}
      <p className="total" data-testid="meal-carbs">
        {perServing.complete ? `${formatCarbs(perServing.carbs_g)} carbs per serving` : 'Incomplete carb data'}
        {per100g?.complete ? ` · ${formatCarbs(per100g.carbs_g)} per 100 g` : ''}
      </p>
      <fieldset>
        <legend>Image</legend>
        <ImagePicker imageId={imageId} defaultQuery={name} attribution={image?.attribution ?? null} onChange={setImageId} />
      </fieldset>
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
        {existing && (
          <button type="button" className="danger" onClick={() => void remove()}>
            {confirmDelete ? 'Tap again to delete' : 'Delete meal'}
          </button>
        )}
      </div>
    </div>
  );
}
