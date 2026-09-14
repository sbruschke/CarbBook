import { type FoodData, type PortionData, type PortionKind, type Synced, VOLUME_UNITS } from '@carbbook/core';
import { useState } from 'react';
import { useServices } from '../app/services';
import type { Change } from '../db/store';
import { uuidv7 } from '../lib/ids';
import { parseNonNegative, unitLabel } from '../ui/format';
import { carbsPer100gFromLabel, type FoodPrefill } from './label';

interface PortionDraft {
  key: string;
  id: string | null;
  label: string;
  kind: PortionKind;
  quantity: string;
  grams: string;
}

const VOLUME_LABELS = Object.keys(VOLUME_UNITS);
const LABEL_SERVING = 'label serving';
const numText = (n: number | null | undefined) => (n == null ? '' : String(n));

export function FoodEditor(props: {
  existing?: { food: Synced<FoodData>; portions: Synced<PortionData>[] };
  prefill?: FoodPrefill;
  /** Called with the saved food id, or null when cancelled or deleted. */
  onDone: (foodId: string | null) => void;
}) {
  const { store, now } = useServices();
  const base = props.existing?.food;
  const prefill = props.prefill ?? {};
  const isUsda = base?.source === 'usda';

  const [name, setName] = useState(base?.name ?? prefill.name ?? '');
  const [brand, setBrand] = useState(base?.brand ?? prefill.brand ?? '');
  const [carbsMode, setCarbsMode] = useState<'per100' | 'label'>('per100');
  const [carbsText, setCarbsText] = useState(numText(base ? base.carbs_per_100g : prefill.carbs_per_100g));
  const [servingText, setServingText] = useState('');
  const [labelCarbsText, setLabelCarbsText] = useState('');
  const [fiberText, setFiberText] = useState(numText(base ? base.fiber_per_100g : prefill.fiber_per_100g));
  const [densityText, setDensityText] = useState(numText(base?.density_g_per_ml));
  const [notes, setNotes] = useState(base?.notes ?? '');
  const [portions, setPortions] = useState<PortionDraft[]>(() =>
    (props.existing?.portions ?? prefill.portions ?? []).map((p) => ({
      key: uuidv7(),
      id: 'id' in p ? (p.id as string) : null,
      label: p.label,
      kind: p.kind,
      quantity: String(p.quantity),
      grams: String(p.grams),
    })),
  );
  const [errors, setErrors] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const labelPreview = carbsPer100gFromLabel(parseNonNegative(servingText), parseNonNegative(labelCarbsText));
  const updatePortion = (key: string, patch: Partial<PortionDraft>) =>
    setPortions((rows) => rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  async function save() {
    const problems: string[] = [];
    if (!name.trim()) problems.push('Name is required.');
    let carbs: number | null = null;
    if (carbsMode === 'label') {
      carbs = labelPreview;
      if (carbs === null) problems.push('Enter the serving size (g) and carbs per serving from the label.');
      else if (carbs > 100) problems.push('Carbs per serving cannot be more than the serving size.');
    } else if (carbsText.trim() === '') {
      problems.push('Carbs are missing: enter them from the label.');
    } else {
      carbs = parseNonNegative(carbsText);
      if (carbs === null || carbs > 100) problems.push('Carbs per 100 g must be a number from 0 to 100.');
    }
    // The server rejects carbs/fiber outside 0..100 g per 100 g.
    const fiber = parseNonNegative(fiberText);
    if (fiberText.trim() !== '' && (fiber === null || fiber > 100)) problems.push('Fiber per 100 g must be a number from 0 to 100.');
    const density = parseNonNegative(densityText);
    if (densityText.trim() !== '' && !(density !== null && density > 0)) problems.push('Density must be greater than 0.');

    const rows = [...portions];
    const servingGrams = parseNonNegative(servingText);
    if (carbsMode === 'label' && servingGrams && !rows.some((p) => p.kind === 'serving' && p.label === LABEL_SERVING)) {
      rows.push({ key: 'label', id: null, label: LABEL_SERVING, kind: 'serving', quantity: '1', grams: String(servingGrams) });
    }
    rows.forEach((p, i) => {
      if (!p.label.trim()) problems.push(`Portion ${i + 1} needs a label.`);
      if (p.kind === 'volume' && !VOLUME_LABELS.includes(p.label)) problems.push(`Portion ${i + 1}: pick a volume unit.`);
      const quantity = parseNonNegative(p.quantity);
      const grams = parseNonNegative(p.grams);
      if (!(quantity && quantity > 0) || !(grams && grams > 0)) problems.push(`Portion ${i + 1} needs a quantity and grams above 0.`);
    });
    setErrors(problems);
    if (problems.length > 0) return;

    // Editing a USDA food makes a custom copy; the original stays untouched (spec §3).
    const keepId = base !== undefined && !isUsda;
    const foodId = keepId ? base.id : uuidv7(now());
    const food: FoodData = {
      id: foodId,
      name: name.trim(),
      brand: brand.trim() || null,
      source: keepId ? (base.source ?? 'custom') : isUsda ? 'custom' : (prefill.source ?? 'custom'),
      source_ref: keepId ? (base.source_ref ?? null) : isUsda ? null : (prefill.source_ref ?? null),
      derived_from: base && isUsda ? base.id : (base?.derived_from ?? null),
      carbs_per_100g: carbs,
      fiber_per_100g: fiber,
      density_g_per_ml: density,
      notes: notes.trim() || null,
    };
    const kept = new Set<string>();
    const changes: Change[] = [{ table: 'food', data: food }];
    for (const p of rows) {
      const id = keepId && p.id ? p.id : uuidv7(now());
      kept.add(id);
      changes.push({
        table: 'portion',
        data: { id, food_id: foodId, label: p.label.trim(), kind: p.kind, quantity: parseNonNegative(p.quantity)!, grams: parseNonNegative(p.grams)! },
      });
    }
    if (!base && prefill.barcode) changes.push({ table: 'barcode', data: { id: uuidv7(now()), code: prefill.barcode, food_id: foodId } });
    await store.saveMany(changes);
    if (keepId) {
      for (const p of props.existing!.portions) if (!kept.has(p.id)) await store.remove('portion', p.id);
    }
    props.onDone(foodId);
  }

  async function remove() {
    if (!base) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    for (const p of props.existing!.portions) await store.remove('portion', p.id);
    await store.remove('food', base.id);
    props.onDone(null);
  }

  return (
    <form
      className="screen editor"
      aria-label="Food"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h1>{base ? 'Edit food' : 'New food'}</h1>
      {isUsda && <p className="note">USDA food: saving creates your own copy. The USDA original stays unchanged.</p>}
      {prefill.note && <p className="note">{prefill.note}</p>}
      {prefill.barcode && (
        <p>
          Barcode <strong>{prefill.barcode}</strong>
        </p>
      )}
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        Brand
        <input value={brand} onChange={(e) => setBrand(e.target.value)} />
      </label>
      <fieldset>
        <legend>Carbs</legend>
        <label className="inline">
          <input type="radio" name="carbs-mode" checked={carbsMode === 'per100'} onChange={() => setCarbsMode('per100')} />
          Per 100 g
        </label>
        <label className="inline">
          <input type="radio" name="carbs-mode" checked={carbsMode === 'label'} onChange={() => setCarbsMode('label')} />
          From label
        </label>
        {carbsMode === 'per100' ? (
          <>
            <label>
              Carbs per 100 g
              <input inputMode="decimal" value={carbsText} onChange={(e) => setCarbsText(e.target.value)} />
            </label>
            {carbsText.trim() === '' && (
              <p className="flag" data-testid="carbs-missing">
                Carbs missing: enter them from the label
              </p>
            )}
          </>
        ) : (
          <>
            <label>
              Serving size (g)
              <input inputMode="decimal" value={servingText} onChange={(e) => setServingText(e.target.value)} />
            </label>
            <label>
              Carbs per serving (g)
              <input inputMode="decimal" value={labelCarbsText} onChange={(e) => setLabelCarbsText(e.target.value)} />
            </label>
            <p className="note" data-testid="label-result">
              {labelPreview === null ? 'Enter both values.' : `= ${labelPreview} g carbs per 100 g`}
            </p>
          </>
        )}
      </fieldset>
      <label>
        Fiber per 100 g
        <input inputMode="decimal" value={fiberText} onChange={(e) => setFiberText(e.target.value)} />
      </label>
      <label>
        Density (g per ml)
        <input inputMode="decimal" value={densityText} onChange={(e) => setDensityText(e.target.value)} />
      </label>
      <fieldset>
        <legend>Portions</legend>
        {portions.map((p, i) => (
          <div className="portion-row" key={p.key}>
            <select
              aria-label={`Portion ${i + 1} kind`}
              value={p.kind}
              onChange={(e) => {
                const kind = e.target.value as PortionKind;
                updatePortion(p.key, { kind, label: kind === 'volume' ? 'cup' : p.kind === 'volume' ? '' : p.label });
              }}
            >
              <option value="count">count</option>
              <option value="serving">serving</option>
              <option value="volume">volume</option>
            </select>
            {p.kind === 'volume' ? (
              <select aria-label={`Portion ${i + 1} label`} value={p.label} onChange={(e) => updatePortion(p.key, { label: e.target.value })}>
                {VOLUME_LABELS.map((unit) => (
                  <option key={unit} value={unit}>
                    {unitLabel(unit, [])}
                  </option>
                ))}
              </select>
            ) : (
              <input
                aria-label={`Portion ${i + 1} label`}
                placeholder="slice"
                value={p.label}
                onChange={(e) => updatePortion(p.key, { label: e.target.value })}
              />
            )}
            <input
              aria-label={`Portion ${i + 1} quantity`}
              inputMode="decimal"
              value={p.quantity}
              onChange={(e) => updatePortion(p.key, { quantity: e.target.value })}
            />
            <input
              aria-label={`Portion ${i + 1} grams`}
              inputMode="decimal"
              value={p.grams}
              onChange={(e) => updatePortion(p.key, { grams: e.target.value })}
            />
            <button type="button" aria-label={`Remove portion ${i + 1}`} onClick={() => setPortions((rows) => rows.filter((r) => r.key !== p.key))}>
              ✕
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => setPortions((rows) => [...rows, { key: uuidv7(), id: null, label: '', kind: 'count', quantity: '1', grams: '' }])}
        >
          Add portion
        </button>
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
        <button type="submit" className="primary">
          Save
        </button>
        <button type="button" onClick={() => props.onDone(null)}>
          Cancel
        </button>
        {base && (
          <button type="button" className="danger" onClick={() => void remove()}>
            {confirmDelete ? 'Tap again to delete' : 'Delete food'}
          </button>
        )}
      </div>
    </form>
  );
}
