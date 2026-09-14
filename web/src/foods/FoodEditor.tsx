import {
  isValidPortionCarbs,
  isValidPortionGrams,
  MAX_PORTION_CARBS_G,
  type FoodData,
  type PortionData,
  type PortionKind,
  type Synced,
  VOLUME_UNITS,
} from '@carbbook/core';
import { useState } from 'react';
import { useServices } from '../app/services';
import type { Change } from '../db/store';
import { uuidv7 } from '../lib/ids';
import { parseNonNegative, unitLabel } from '../ui/format';
import { labelBasisFromEntry, type FoodPrefill, type LabelPortionPatch, type LabelUnit } from './label';

interface PortionDraft {
  key: string;
  id: string | null;
  label: string;
  kind: PortionKind;
  quantity: string;
  /** Empty string means unknown (any-unit foods addendum: grams is nullable). */
  grams: string;
  /** Empty string means unknown. */
  carbsG: string;
}

const VOLUME_LABELS = Object.keys(VOLUME_UNITS);
const LABEL_SERVING = 'label serving';
const LABEL_UNITS: LabelUnit[] = ['g', ...(VOLUME_LABELS as LabelUnit[]), 'other'];
const numText = (n: number | null | undefined) => (n == null ? '' : String(n));
const labelUnitName = (unit: LabelUnit) => (unit === 'other' ? 'piece / serving' : unitLabel(unit, []));

/** What the "From label" fields should show when opening an existing food for edit. */
function initialLabelFields(
  food: Synced<FoodData> | undefined,
  portions: Synced<PortionData>[],
): { mode: 'per100' | 'label'; unit: LabelUnit; amount: string; carbs: string; weight: string; name: string } {
  const blank = { unit: 'g' as LabelUnit, amount: '', carbs: '', weight: '', name: '' };
  if (!food || food.carbs_per_100g != null) return { mode: 'per100', ...blank };
  if (food.carbs_per_100ml != null) {
    return { mode: 'label', unit: 'ml', amount: '100', carbs: String(food.carbs_per_100ml), weight: '', name: '' };
  }
  const withCarbs = portions.find((p) => p.kind !== 'volume' && p.carbs_g != null);
  if (withCarbs) {
    return {
      mode: 'label',
      unit: 'other',
      amount: String(withCarbs.quantity),
      carbs: String(withCarbs.carbs_g),
      weight: withCarbs.grams == null ? '' : String(withCarbs.grams),
      name: withCarbs.label,
    };
  }
  return { mode: 'per100', ...blank };
}

/** Adds a portion, or updates the one that matches (a re-entered label updates its basis rather than duplicating it). */
function mergePortion(rows: PortionDraft[], patch: LabelPortionPatch): PortionDraft[] {
  const matchIndex = rows.findIndex((p) =>
    patch.kind === 'volume' ? p.kind === 'volume' && p.label === patch.label : p.kind !== 'volume' && p.label.trim().toLowerCase() === patch.label.trim().toLowerCase(),
  );
  const draft: PortionDraft = {
    key: matchIndex === -1 ? uuidv7() : rows[matchIndex]!.key,
    id: matchIndex === -1 ? null : rows[matchIndex]!.id,
    label: patch.label,
    kind: patch.kind,
    quantity: String(patch.quantity),
    grams: patch.grams == null ? '' : String(patch.grams),
    carbsG: patch.carbs_g == null ? '' : String(patch.carbs_g),
  };
  if (matchIndex === -1) return [...rows, draft];
  const next = [...rows];
  next[matchIndex] = draft;
  return next;
}

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
  const initialLabel = initialLabelFields(base, props.existing?.portions ?? []);

  const [name, setName] = useState(base?.name ?? prefill.name ?? '');
  const [brand, setBrand] = useState(base?.brand ?? prefill.brand ?? '');
  const [carbsMode, setCarbsMode] = useState<'per100' | 'label'>(initialLabel.mode);
  const [carbsText, setCarbsText] = useState(numText(base ? base.carbs_per_100g : prefill.carbs_per_100g));
  const [labelUnit, setLabelUnit] = useState<LabelUnit>(initialLabel.unit);
  const [labelAmountText, setLabelAmountText] = useState(initialLabel.amount);
  const [labelCarbsText, setLabelCarbsText] = useState(initialLabel.carbs);
  const [labelWeightText, setLabelWeightText] = useState(initialLabel.weight);
  const [labelName, setLabelName] = useState(initialLabel.name);
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
      grams: numText('grams' in p ? p.grams : null),
      carbsG: numText('carbs_g' in p ? p.carbs_g : null),
    })),
  );
  const [errors, setErrors] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const labelEntry = labelBasisFromEntry({
    unit: labelUnit,
    amount: parseNonNegative(labelAmountText),
    carbs: parseNonNegative(labelCarbsText),
    weight: parseNonNegative(labelWeightText),
    label: labelName,
  });
  const labelResultText =
    labelAmountText.trim() === '' || labelCarbsText.trim() === ''
      ? 'Enter the amount and carbs from the label.'
      : 'error' in labelEntry
        ? labelEntry.error
        : labelEntry.carbs_per_100g !== null && labelUnit === 'g'
          ? `= ${labelEntry.carbs_per_100g} g carbs per 100 g`
          : labelEntry.carbs_per_100ml !== null
            ? `= ${labelEntry.carbs_per_100ml} g carbs per 100 ml`
            : `Adds "${labelName.trim() || 'piece'}": ${labelCarbsText.trim()} g carbs`;

  const updatePortion = (key: string, patch: Partial<PortionDraft>) =>
    setPortions((rows) => rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  async function save() {
    const problems: string[] = [];
    if (!name.trim()) problems.push('Name is required.');
    let carbsPer100g: number | null = null;
    let carbsPer100ml: number | null = null;
    let rows = [...portions];

    if (carbsMode === 'per100') {
      if (carbsText.trim() === '') {
        problems.push('Carbs are missing: enter them from the label.');
      } else {
        carbsPer100g = parseNonNegative(carbsText);
        if (carbsPer100g === null || carbsPer100g > 100) problems.push('Carbs per 100 g must be a number from 0 to 100.');
      }
    } else {
      if ('error' in labelEntry) {
        problems.push(labelEntry.error);
      } else {
        carbsPer100g = labelEntry.carbs_per_100g;
        carbsPer100ml = labelEntry.carbs_per_100ml;
        if (labelEntry.portion) rows = mergePortion(rows, labelEntry.portion);
      }
      if (labelUnit === 'g') {
        const amount = parseNonNegative(labelAmountText);
        if (amount !== null && amount > 0) {
          rows = mergePortion(rows, { label: LABEL_SERVING, kind: 'serving', quantity: 1, grams: amount, carbs_g: null });
        }
      }
    }

    // The server rejects fiber outside 0..100 g per 100 g.
    const fiber = parseNonNegative(fiberText);
    if (fiberText.trim() !== '' && (fiber === null || fiber > 100)) problems.push('Fiber per 100 g must be a number from 0 to 100.');
    if (fiber !== null && carbsPer100g !== null && fiber > carbsPer100g) problems.push('Fiber per 100 g cannot be more than carbs per 100 g.');
    const density = parseNonNegative(densityText);
    if (densityText.trim() !== '' && !(density !== null && density > 0)) problems.push('Density must be greater than 0.');

    const parsedRows = rows.map((p, i) => {
      const quantity = parseNonNegative(p.quantity);
      const gramsText = p.grams.trim();
      const grams = gramsText === '' ? null : parseNonNegative(p.grams);
      const carbsText2 = p.carbsG.trim();
      const carbsG = carbsText2 === '' ? null : parseNonNegative(p.carbsG);
      if (!p.label.trim()) problems.push(`Portion ${i + 1} needs a label.`);
      if (p.kind === 'volume' && !VOLUME_LABELS.includes(p.label)) problems.push(`Portion ${i + 1}: pick a volume unit.`);
      if (!(quantity && quantity > 0)) problems.push(`Portion ${i + 1} needs a quantity above 0.`);
      if (gramsText !== '' && !isValidPortionGrams(grams)) problems.push(`Portion ${i + 1}: grams must be a number above 0.`);
      if (carbsText2 !== '' && (carbsG === null || !isValidPortionCarbs(carbsG))) {
        problems.push(`Portion ${i + 1}: carbs must be a number from 0 to ${MAX_PORTION_CARBS_G}.`);
      }
      if (p.kind === 'volume' && !isValidPortionGrams(grams)) problems.push(`Portion ${i + 1} needs grams above 0.`);
      if (p.kind !== 'volume' && grams === null && carbsG === null) problems.push(`Portion ${i + 1} needs grams or carbs.`);
      return { ...p, quantity, grams, carbsG };
    });

    const hasBasis =
      (carbsPer100g !== null && carbsPer100g >= 0 && carbsPer100g <= 100) ||
      (carbsPer100ml !== null && carbsPer100ml >= 0) ||
      parsedRows.some((p) => p.carbsG !== null);
    if (!hasBasis) problems.push('Enter carbs: per 100 g, per cup/etc., or for a piece.');

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
      carbs_per_100g: carbsPer100g,
      carbs_per_100ml: carbsPer100ml,
      fiber_per_100g: fiber,
      density_g_per_ml: density,
      notes: notes.trim() || null,
    };
    const kept = new Set<string>();
    const changes: Change[] = [{ table: 'food', data: food }];
    for (const p of parsedRows) {
      const id = keepId && p.id ? p.id : uuidv7(now());
      kept.add(id);
      changes.push({
        table: 'portion',
        data: { id, food_id: foodId, label: p.label.trim(), kind: p.kind, quantity: p.quantity!, grams: p.grams, carbs_g: p.carbsG },
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
            <p className="note">Amount [unit] contains N g carbs.</p>
            <label>
              Amount
              <input inputMode="decimal" value={labelAmountText} onChange={(e) => setLabelAmountText(e.target.value)} />
            </label>
            <label>
              Unit
              <select value={labelUnit} onChange={(e) => setLabelUnit(e.target.value as LabelUnit)}>
                {LABEL_UNITS.map((unit) => (
                  <option key={unit} value={unit}>
                    {labelUnitName(unit)}
                  </option>
                ))}
              </select>
            </label>
            {labelUnit === 'other' && (
              <label>
                Portion name
                <input placeholder="bar" value={labelName} onChange={(e) => setLabelName(e.target.value)} />
              </label>
            )}
            <label>
              Carbs (g)
              <input inputMode="decimal" value={labelCarbsText} onChange={(e) => setLabelCarbsText(e.target.value)} />
            </label>
            {labelUnit !== 'g' && (
              <label>
                Weighs (g)
                <input inputMode="decimal" value={labelWeightText} onChange={(e) => setLabelWeightText(e.target.value)} />
              </label>
            )}
            <p className="note" data-testid="label-result">
              {labelResultText}
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
              placeholder={p.kind === 'volume' ? '' : 'optional'}
              value={p.grams}
              onChange={(e) => updatePortion(p.key, { grams: e.target.value })}
            />
            {p.kind !== 'volume' && (
              <input
                aria-label={`Portion ${i + 1} carbs (g)`}
                inputMode="decimal"
                placeholder="optional"
                value={p.carbsG}
                onChange={(e) => updatePortion(p.key, { carbsG: e.target.value })}
              />
            )}
            <button type="button" aria-label={`Remove portion ${i + 1}`} onClick={() => setPortions((rows) => rows.filter((r) => r.key !== p.key))}>
              ✕
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => setPortions((rows) => [...rows, { key: uuidv7(), id: null, label: '', kind: 'count', quantity: '1', grams: '', carbsG: '' }])}
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
        {base && !isUsda && (
          <button type="button" className="danger" onClick={() => void remove()}>
            {confirmDelete ? 'Tap again to delete' : 'Delete food'}
          </button>
        )}
      </div>
    </form>
  );
}
