import { activeSettings, sumCarbs } from '@carbbook/core';
import { useState } from 'react';
import { lastDoseAt, useBgStatus, useCatalogData, useEligibleDoseVersions, useLogData, useNow, useUsdaPicks } from '../app/hooks';
import { useServices } from '../app/services';
import { bgPrefill } from '../bg/bg';
import { resolveBarcode } from '../barcode/resolve';
import { buildCatalog } from '../db/catalog';
import { isLive } from '../db/db';
import type { Change } from '../db/store';
import { estimateFor } from '../dose/dose';
import { FoodEditor } from '../foods/FoodEditor';
import { type FoodPrefill, prefillFromDraft } from '../foods/label';
import { parseUsdaFoodId, uuidv7 } from '../lib/ids';
import { saveMeal } from '../meals/saveMeal';
import type { SearchResult } from '../search/search';
import { BgField, resolveBg } from '../ui/BgField';
import { DoseCard } from '../ui/DoseCard';
import { formatCarbs, formatTime, fromDateTimeLocal, parseNonNegative, toDateTimeLocal } from '../ui/format';
import { type DraftItem, draftItemCarbs, ItemEditor, itemName, newDraftItem } from '../ui/ItemEditor';
import { ScannerDialog } from '../ui/ScannerDialog';
import { SearchPanel } from '../ui/SearchPanel';
import { saveUsdaFoodsFor } from '../usda/materialize';

interface MealForm {
  name: string;
  yieldText: string;
  weightText: string;
}

export function Calculator() {
  const { db, api, store, now } = useServices();
  const data = useCatalogData();
  const versions = useEligibleDoseVersions();
  const log = useLogData();
  const usda = useUsdaPicks();
  const bgStatus = useBgStatus();
  const clock = useNow();
  const [items, setItems] = useState<DraftItem[]>([]);
  const [eatenText, setEatenText] = useState(() => toDateTimeLocal(now()));
  const [windowName, setWindowName] = useState<string | null>(null);
  const [manualMode, setManualMode] = useState(false);
  const [manualText, setManualText] = useState('');
  const [takenText, setTakenText] = useState('');
  const [takenEdited, setTakenEdited] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [foodPrefill, setFoodPrefill] = useState<FoodPrefill | null>(null);
  const [mealForm, setMealForm] = useState<MealForm | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  if (!data || !versions || !log) return <p>Loading…</p>;

  const catalog = buildCatalog(data, usda.entries);
  const results = items.map((item) => draftItemCarbs(catalog, item));
  const carbs = sumCarbs(results);
  const eatenAt = fromDateTimeLocal(eatenText) ?? Number.NaN;
  const prefill = bgStatus ? bgPrefill(bgStatus, clock) : null;
  const bg = resolveBg(prefill, manualMode, manualText);
  const settings = activeSettings(versions, eatenAt);
  const estimate = settings ? estimateFor({ settings, windowName, eatenAt, carbs, bg: bg.mgdl }) : null;
  const suggested = estimate?.ok ? estimate.units : null;
  const takenValue = takenEdited ? takenText : suggested === null ? '' : String(suggested);
  const autoWindow = windowName === null ? (estimate?.window?.name ?? null) : null;
  const badAmounts = items.some((item) => parseNonNegative(item.amount) === null);

  function addFood(refType: 'food' | 'meal', refId: string, extra = catalog) {
    setItems((current) => [...current, newDraftItem(extra, refType, refId, uuidv7(now()))]);
  }

  async function pick(result: SearchResult) {
    if (result.kind !== 'usda') return addFood(result.kind, result.id);
    const entry = await usda.add(parseUsdaFoodId(result.id)!);
    if (entry) addFood('food', result.id, buildCatalog(data!, [...usda.entries, entry]));
  }

  async function addSavedFood(foodId: string) {
    const food = await db.food.get(foodId);
    if (!food) return;
    const portions = await db.portion.where('food_id').equals(foodId).filter(isLive).toArray();
    addFood('food', foodId, buildCatalog(data!, [{ food, portions }]));
  }

  async function lookUp(code: string) {
    setScanning(false);
    try {
      const result = await resolveBarcode(db, api, code, now);
      if (result.kind === 'local' || result.kind === 'known') await addSavedFood(result.food.id);
      else if (result.kind === 'draft') setFoodPrefill(prefillFromDraft(result.draft));
      else if (result.kind === 'manual') setFoodPrefill({ barcode: result.code, note: result.message });
      else if (result.kind === 'invalid') setMessage(result.message);
      else setMessage(`No connection. Barcode ${result.code} is saved in Foods to look up later.`);
    } catch (error) {
      setMessage(`Barcode lookup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function reset() {
    setItems([]);
    setTakenEdited(false);
    setTakenText('');
    setWindowName(null);
    setManualMode(false);
    setManualText('');
    setEatenText(toDateTimeLocal(now()));
  }

  async function logIt() {
    if (badAmounts) return setMessage('Enter an amount for every item before logging.');
    if (!Number.isFinite(eatenAt)) return setMessage('Enter when you ate.');
    const taken = parseNonNegative(takenValue);
    if (takenValue.trim() !== '' && taken === null) return setMessage('Taken dose must be a number.');
    await saveUsdaFoodsFor(store, items);
    const entryId = uuidv7(now());
    const changes: Change[] = [
      {
        table: 'log_entry',
        data: {
          id: entryId,
          eaten_at: eatenAt,
          window_name: estimate?.window?.name ?? windowName,
          bg_mgdl: bg.mgdl,
          bg_source: bg.source,
          bg_trend: bg.trend,
          total_carbs_g: carbs.carbs_g,
          suggested_units: suggested,
          taken_units: taken,
          settings_version_id: settings?.id ?? null,
          notes: null,
        },
      },
      ...items.map(
        (item, index): Change => ({
          table: 'log_item',
          data: {
            id: uuidv7(now()),
            log_entry_id: entryId,
            ref_type: item.ref_type,
            ref_id: item.ref_id,
            display_name: itemName(catalog, item.ref_type, item.ref_id),
            amount: parseNonNegative(item.amount)!,
            unit: item.unit,
            carbs_g: results[index]!.carbs_g,
          },
        }),
      ),
    ];
    await store.saveMany(changes);
    reset();
    setMessage(`Logged ${formatCarbs(carbs.carbs_g)} carbs at ${formatTime(eatenAt)}.`);
  }

  async function saveAsMeal(form: MealForm) {
    const yieldServings = parseNonNegative(form.yieldText);
    const weight = form.weightText.trim() === '' ? null : parseNonNegative(form.weightText);
    if (!form.name.trim()) return setMessage('Give the meal a name.');
    if (!(yieldServings !== null && yieldServings > 0)) return setMessage('Yield must be more than 0 servings.');
    if (form.weightText.trim() !== '' && !(weight !== null && weight > 0)) return setMessage('Total weight must be empty or more than 0 g.');
    if (badAmounts) return setMessage('Enter an amount for every item before saving.');
    // Fresh item ids: saving the same calculator twice must not move items between meals.
    const mealItems = items.map((item) => ({ ...item, key: uuidv7(now()) }));
    await saveMeal(store, { id: uuidv7(now()), name: form.name.trim(), yield_servings: yieldServings, total_weight_g: weight, notes: null }, mealItems);
    setMealForm(null);
    setMessage(`Saved meal "${form.name.trim()}".`);
  }

  if (foodPrefill) {
    return (
      <FoodEditor
        prefill={foodPrefill}
        onDone={(foodId) => {
          setFoodPrefill(null);
          if (foodId) void addSavedFood(foodId);
        }}
      />
    );
  }

  return (
    <div className="screen calculator">
      <h1>Calculator</h1>
      {message && (
        <p role="status" className="message">
          {message}
        </p>
      )}
      <SearchPanel onPick={(result) => void pick(result)} onScan={() => setScanning(true)} />
      {scanning && <ScannerDialog onCode={(code) => void lookUp(code)} onClose={() => setScanning(false)} />}
      <ItemEditor items={items} catalog={catalog} onChange={setItems} />
      {items.length > 0 && (
        <p className="total" data-testid="total-carbs">
          Total {formatCarbs(carbs.carbs_g)} carbs{carbs.complete ? '' : ' (incomplete)'}
        </p>
      )}
      <section className="card">
        <label>
          Eaten at
          <input type="datetime-local" value={eatenText} onChange={(e) => setEatenText(e.target.value)} />
        </label>
        <label>
          Window
          <select value={windowName ?? ''} onChange={(e) => setWindowName(e.target.value || null)}>
            <option value="">{autoWindow ? `Auto (${autoWindow})` : 'Auto'}</option>
            {settings?.windows.map((w) => (
              <option key={w.name} value={w.name}>
                {w.name} (1:{w.ratio_g_per_unit})
              </option>
            ))}
          </select>
        </label>
        <BgField
          status={bgStatus}
          prefill={prefill}
          manualMode={manualMode}
          manualText={manualText}
          onManualModeChange={setManualMode}
          onManualTextChange={setManualText}
        />
      </section>
      <DoseCard estimate={estimate} hasItems={items.length > 0} bg={bg.mgdl} lastDoseAt={lastDoseAt(log.entries)} now={clock} />
      <section className="card">
        <label>
          Taken dose (u)
          <input
            inputMode="decimal"
            value={takenValue}
            onChange={(e) => {
              setTakenEdited(true);
              setTakenText(e.target.value);
            }}
          />
        </label>
        <div className="button-row">
          <button type="button" className="primary" disabled={items.length === 0} onClick={() => void logIt()}>
            Log it
          </button>
          <button type="button" disabled={items.length === 0} onClick={() => setMealForm({ name: '', yieldText: '1', weightText: '' })}>
            Save as meal
          </button>
        </div>
      </section>
      {mealForm && (
        <form
          className="card"
          aria-label="Save as meal"
          onSubmit={(e) => {
            e.preventDefault();
            void saveAsMeal(mealForm);
          }}
        >
          <label>
            Meal name
            <input value={mealForm.name} onChange={(e) => setMealForm({ ...mealForm, name: e.target.value })} />
          </label>
          <label>
            Yield (servings)
            <input inputMode="decimal" value={mealForm.yieldText} onChange={(e) => setMealForm({ ...mealForm, yieldText: e.target.value })} />
          </label>
          <label>
            Total weight (g, optional)
            <input inputMode="decimal" value={mealForm.weightText} onChange={(e) => setMealForm({ ...mealForm, weightText: e.target.value })} />
          </label>
          <div className="button-row">
            <button type="submit" className="primary">
              Save meal
            </button>
            <button type="button" onClick={() => setMealForm(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
