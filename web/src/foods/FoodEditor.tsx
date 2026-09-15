import {
  isValidCarbsPer100ml,
  isValidPortionCarbs,
  isValidPortionGrams,
  MAX_CARBS_PER_100ML,
  MAX_PORTION_CARBS_G,
  type FoodData,
  type PortionData,
  type PortionKind,
  type Synced,
  VOLUME_UNITS,
  type VolumeUnit,
} from '@carbbook/core';
import { useState } from 'react';
import { useServices } from '../app/services';
import type { Change } from '../db/store';
import { uuidv7 } from '../lib/ids';
import { parseAmount, parseNonNegative, unitLabel } from '../ui/format';
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

/** A single volume-basis reading: a "From label" volume entry, or a Portions-section volume row with carbs. */
interface VolumeCarbsEntry {
  /** e.g. "2/3 cup = 30 g", for naming conflicts to the user. */
  name: string;
  /** Implied carbs per 100 ml. */
  value: number;
}

/** The "From label" entry, when it is a volume unit with a valid amount and carbs. */
function labelVolumeEntry(params: { unit: LabelUnit; amountText: string; carbsText: string }): VolumeCarbsEntry | null {
  const { unit, amountText, carbsText } = params;
  if (!VOLUME_LABELS.includes(unit)) return null;
  const amount = parseAmount(amountText);
  const carbs = parseNonNegative(carbsText);
  if (amount === null || !(amount > 0) || carbs === null) return null;
  const value = (carbs / (amount * VOLUME_UNITS[unit as VolumeUnit])) * 100;
  return { name: `${amountText.trim()} ${unit} = ${carbsText.trim()} g`, value };
}

/**
 * Every volume-basis reading in play: the "From label" volume entry (if any) plus every
 * Portions-section volume row with carbs entered (with or without weight) — each implies the
 * food's carbs_per_100ml, the same math as the "From label" volume entry:
 * carbs / (quantity * unit ml) * 100. A carbs-only row (no weight) sets this without creating a
 * portion row. When two readings disagree by more than 1%, saving is blocked rather than
 * silently picking one — a wrong carbs-per-volume basis is a wrong insulin dose. When they all
 * agree, the "From label" entry wins if present, else the first Portions-section row.
 */
function resolveVolumeCarbs(rows: PortionDraft[], label: VolumeCarbsEntry | null): { value: number } | { error: string } | null {
  const entries: VolumeCarbsEntry[] = label ? [label] : [];
  for (const p of rows) {
    if (p.kind !== 'volume' || p.carbsG.trim() === '') continue;
    if (!VOLUME_LABELS.includes(p.label)) continue;
    const unit = p.label as VolumeUnit;
    const carbs = parseNonNegative(p.carbsG);
    const quantity = parseAmount(p.quantity);
    if (carbs === null || quantity === null || !(quantity > 0)) continue;
    const value = (carbs / (quantity * VOLUME_UNITS[unit])) * 100;
    entries.push({ name: `${p.quantity.trim()} ${unit} = ${p.carbsG.trim()} g`, value });
  }
  if (entries.length === 0) return null;
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i]!;
      const b = entries[j]!;
      const diff = Math.abs(a.value - b.value) / Math.max(Math.abs(a.value), Math.abs(b.value), 1e-9);
      if (diff > 0.01) return { error: `${a.name} and ${b.name} give different carbs per volume.` };
    }
  }
  const value = entries[0]!.value;
  if (!isValidCarbsPer100ml(value)) return { error: `Carbs per 100 ml must be a number from 0 to ${MAX_CARBS_PER_100ML}.` };
  return { value };
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
  /** Stored bases the user explicitly removed ("Remove carbs per 100 ml"). */
  const [removedBases, setRemovedBases] = useState({ g: false, ml: false });
  const [errors, setErrors] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const labelEntry = labelBasisFromEntry({
    unit: labelUnit,
    amount: parseAmount(labelAmountText),
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

  // Only the basis the current entry edits changes on save; the other stored basis is kept
  // unless explicitly removed (never nulled as a side effect of saving in one mode).
  const labelWeight = parseNonNegative(labelWeightText);
  const editsG = carbsMode === 'per100' || labelUnit === 'g' || (labelUnit === 'other' && labelWeight !== null && labelWeight > 0);
  const editsMl = carbsMode === 'label' && labelUnit !== 'g' && labelUnit !== 'other';
  const keptG = !editsG && !removedBases.g ? (base?.carbs_per_100g ?? null) : null;
  const keptMl = !editsMl && !removedBases.ml ? (base?.carbs_per_100ml ?? null) : null;

  // The "From label" entry, when it names a volume unit — folded into the same conflict check as
  // the Portions-section volume rows (spec: label + rows must agree within 1%, or saving is blocked).
  const activeLabelVolumeEntry =
    carbsMode === 'label' ? labelVolumeEntry({ unit: labelUnit, amountText: labelAmountText, carbsText: labelCarbsText }) : null;

  // Inline warning (before save): a conflict between volume readings (surfaced early, in the
  // same words save() will block with), or — absent a conflict — that a portion row would
  // replace a different saved carbs_per_100ml.
  const portionsOverridePreview = resolveVolumeCarbs(portions, activeLabelVolumeEntry);
  const overrideNote =
    portionsOverridePreview && 'error' in portionsOverridePreview
      ? portionsOverridePreview.error
      : portionsOverridePreview &&
          base?.carbs_per_100ml != null &&
          Math.abs(base.carbs_per_100ml - portionsOverridePreview.value) / Math.max(Math.abs(base.carbs_per_100ml), 1e-9) > 0.01
        ? 'This replaces the saved carbs per cup/ml.'
        : null;

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
        const amount = parseAmount(labelAmountText);
        if (amount !== null && amount > 0) {
          rows = mergePortion(rows, { label: LABEL_SERVING, kind: 'serving', quantity: 1, grams: amount, carbs_g: null });
        }
      }
      // A malformed (non-empty, unparseable) "Weighs (g)" entry must not silently drop the portion.
      if (labelUnit !== 'g' && labelWeightText.trim() !== '' && !(labelWeight !== null && labelWeight > 0)) {
        problems.push('Weight must be a number greater than 0.');
      }
    }

    if (!editsG) carbsPer100g = keptG;
    if (!editsMl) carbsPer100ml = keptMl;

    // A volume portion row with carbs entered fixes carbs_per_100ml from the label, and must agree
    // with the "From label" volume entry and every other such row — taking precedence over any
    // previously saved value once they do.
    const portionsOverride = resolveVolumeCarbs(rows, activeLabelVolumeEntry);
    if (portionsOverride) {
      if ('error' in portionsOverride) problems.push(portionsOverride.error);
      else carbsPer100ml = portionsOverride.value;
    }

    // The server rejects fiber outside 0..100 g per 100 g.
    const fiber = parseNonNegative(fiberText);
    if (fiberText.trim() !== '' && (fiber === null || fiber > 100)) problems.push('Fiber per 100 g must be a number from 0 to 100.');
    if (fiber !== null && carbsPer100g !== null && fiber > carbsPer100g) problems.push('Fiber per 100 g cannot be more than carbs per 100 g.');
    const density = parseNonNegative(densityText);
    if (densityText.trim() !== '' && !(density !== null && density > 0)) problems.push('Density must be greater than 0.');

    const parsedRows = rows.map((p, i) => {
      const quantity = parseAmount(p.quantity);
      const gramsText = p.grams.trim();
      const grams = gramsText === '' ? null : parseNonNegative(p.grams);
      const carbsText2 = p.carbsG.trim();
      const carbsRaw = carbsText2 === '' ? null : parseNonNegative(p.carbsG);
      // Volume portions never carry carbs_g (server rejects it): entered carbs there feed
      // carbs_per_100ml instead (via volumeCarbsOverride), so the portion row itself gets null.
      const carbsG = p.kind === 'volume' ? null : carbsRaw;
      if (!p.label.trim()) problems.push(`Portion ${i + 1} needs a label.`);
      if (p.kind === 'volume' && !VOLUME_LABELS.includes(p.label)) problems.push(`Portion ${i + 1}: pick a volume unit.`);
      if (!(quantity && quantity > 0)) problems.push(`Portion ${i + 1} needs a quantity above 0.`);
      if (gramsText !== '' && !isValidPortionGrams(grams)) problems.push(`Portion ${i + 1}: grams must be a number above 0.`);
      if (carbsText2 !== '' && (carbsRaw === null || !isValidPortionCarbs(carbsRaw))) {
        problems.push(`Portion ${i + 1}: carbs must be a number from 0 to ${MAX_PORTION_CARBS_G}.`);
      }
      if (p.kind === 'volume' && gramsText === '' && carbsText2 === '') problems.push(`Portion ${i + 1} needs grams or carbs.`);
      if (p.kind !== 'volume' && grams === null && carbsG === null) problems.push(`Portion ${i + 1} needs grams or carbs.`);
      // A carbs-only volume row (no weight) sets carbs_per_100ml but creates no portion row.
      const skip = p.kind === 'volume' && grams === null;
      return { ...p, quantity, grams, carbsG, skip };
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
      if (p.skip) continue;
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
          From label (cup, tbsp, piece, g…)
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
              <input inputMode="text" placeholder="e.g. 2/3" value={labelAmountText} onChange={(e) => setLabelAmountText(e.target.value)} />
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
        {keptG !== null && (
          <p className="note" data-testid="kept-basis-g">
            Also saved: {numText(Number(keptG.toFixed(2)))} g carbs per 100 g{' '}
            <button type="button" onClick={() => setRemovedBases((r) => ({ ...r, g: true }))}>
              Remove carbs per 100 g
            </button>
          </p>
        )}
        {keptMl !== null && (
          <p className="note" data-testid="kept-basis-ml">
            Also saved: {numText(Number(keptMl.toFixed(2)))} g carbs per 100 ml{' '}
            <button type="button" onClick={() => setRemovedBases((r) => ({ ...r, ml: true }))}>
              Remove carbs per 100 ml
            </button>
          </p>
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
                // Carbs on the old kind don't carry meaning under the new one: a piece's carbs_g
                // isn't a volume's carbs-per-100ml input, and vice versa.
                updatePortion(p.key, { kind, label: kind === 'volume' ? 'cup' : p.kind === 'volume' ? '' : p.label, carbsG: '' });
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
              inputMode="text"
              placeholder="e.g. 2/3"
              value={p.quantity}
              onChange={(e) => updatePortion(p.key, { quantity: e.target.value })}
            />
            <input
              aria-label={`Portion ${i + 1} grams`}
              inputMode="decimal"
              placeholder="optional"
              value={p.grams}
              onChange={(e) => updatePortion(p.key, { grams: e.target.value })}
            />
            <input
              aria-label={`Portion ${i + 1} carbs (g)`}
              inputMode="decimal"
              placeholder="optional"
              value={p.carbsG}
              onChange={(e) => updatePortion(p.key, { carbsG: e.target.value })}
            />
            <button type="button" aria-label={`Remove portion ${i + 1}`} onClick={() => setPortions((rows) => rows.filter((r) => r.key !== p.key))}>
              ✕
            </button>
          </div>
        ))}
        {overrideNote && (
          <p className="note" data-testid="portion-carbs-override-note">
            {overrideNote}
          </p>
        )}
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
