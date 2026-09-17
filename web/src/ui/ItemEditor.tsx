import {
  type Catalog,
  type CarbResult,
  foodUnits,
  isValidQuickCarbs,
  itemCarbs,
  mealUnits,
  normalizeQuickLabel,
  PORTION_PREFIX,
  QUICK_LABEL_MAX,
  QUICK_UNIT,
  quickDisplayName,
  quickUnits,
  type RefType,
} from '@carbbook/core';
import { formatCarbs, parseAmount, parseNonNegative } from './format';
import { UnitPicker } from './UnitPicker';

/** An item being edited: amount is the raw text so half-typed numbers survive. */
export interface DraftItem {
  key: string;
  ref_type: RefType;
  ref_id: string;
  amount: string;
  unit: string;
  /** Quick carbs rows only: the label text as typed (quick-carbs spec §2). */
  label?: string;
}

const INCOMPLETE: CarbResult = { carbs_g: 0, complete: false };

export function itemName(catalog: Catalog, refType: RefType, refId: string): string {
  if (refType === 'quick') return quickDisplayName(null);
  const name = refType === 'food' ? catalog.food(refId)?.name : catalog.meal(refId)?.name;
  // The server does not enforce references: a synced item can point at a row that has not arrived.
  return name ?? '(missing item)';
}

/** Display name for any stored or draft row; quick rows use their label (quick-carbs spec §2). */
export function itemLabel(catalog: Catalog, item: { ref_type: RefType; ref_id: string; label?: string | null }): string {
  return item.ref_type === 'quick' ? quickDisplayName(item.label) : itemName(catalog, item.ref_type, item.ref_id);
}

export function unitsFor(catalog: Catalog, refType: RefType, refId: string): string[] {
  if (refType === 'quick') return quickUnits();
  if (refType === 'meal') {
    const meal = catalog.meal(refId);
    return meal ? mealUnits(meal) : [];
  }
  const food = catalog.food(refId);
  return food ? foodUnits(food, catalog.portions(refId)) : [];
}

/**
 * A draft row's amount, or null when missing/invalid. Quick rows are grams of carbs: a plain decimal
 * (never a fraction) within the dose limit, so a bad entry fails closed. Other rows use `parseAmount`.
 */
export function draftAmount(item: DraftItem): number | null {
  if (item.ref_type !== 'quick') return parseAmount(item.amount);
  const grams = parseNonNegative(item.amount);
  return grams !== null && isValidQuickCarbs(grams) ? grams : null;
}

/** The label to store: trimmed text for quick rows (null when blank), always null otherwise. */
export function draftLabel(item: DraftItem): string | null {
  return item.ref_type === 'quick' ? normalizeQuickLabel(item.label) : null;
}

/** Carbs for a draft item via core; a missing or invalid amount counts as incomplete. */
export function draftItemCarbs(catalog: Catalog, item: DraftItem): CarbResult {
  const amount = draftAmount(item);
  return amount === null ? INCOMPLETE : itemCarbs(catalog, item.ref_type, item.ref_id, amount, item.unit);
}

/** "+ Carbs": an empty quick row. ref_id is its own key; save paths re-point it at the stored row id. */
export function newQuickItem(key: string): DraftItem {
  return { key, ref_type: 'quick', ref_id: key, amount: '', unit: QUICK_UNIT, label: '' };
}

/** "Ranch & salad — 7 g carbs" (quick-carbs spec §2). */
export function quickRowText(label: string | null | undefined, amountText: string): string {
  const grams = parseNonNegative(amountText);
  const carbs = grams !== null && isValidQuickCarbs(grams) ? `${formatCarbs(grams)} carbs` : 'enter grams of carbs';
  return `${quickDisplayName(label)} — ${carbs}`;
}

/** Meals default to 1 serving; foods to their first count/serving portion, else 100 g. */
export function newDraftItem(catalog: Catalog, refType: RefType, refId: string, key: string): DraftItem {
  if (refType === 'quick') return newQuickItem(key);
  if (refType === 'meal') return { key, ref_type: refType, ref_id: refId, amount: '1', unit: 'serving' };
  const portionUnit = unitsFor(catalog, 'food', refId).find((u) => u.startsWith(PORTION_PREFIX));
  return portionUnit
    ? { key, ref_type: refType, ref_id: refId, amount: '1', unit: portionUnit }
    : { key, ref_type: refType, ref_id: refId, amount: '100', unit: 'g' };
}

/** Longest label a quick row accepts (input maxLength). */
export const QUICK_LABEL_INPUT_MAX = QUICK_LABEL_MAX;

export function ItemEditor(props: {
  items: DraftItem[];
  catalog: Catalog;
  onChange: (items: DraftItem[]) => void;
  reorderable?: boolean;
}) {
  const { items, catalog, onChange } = props;
  const update = (key: string, patch: Partial<DraftItem>) =>
    onChange(items.map((item) => (item.key === key ? { ...item, ...patch } : item)));
  const move = (index: number, delta: number) => {
    const next = [...items];
    const [moved] = next.splice(index, 1);
    next.splice(index + delta, 0, moved!);
    onChange(next);
  };

  return (
    <ul className="items" aria-label="Items">
      {items.map((item, index) => {
        const name = itemName(catalog, item.ref_type, item.ref_id);
        const result = draftItemCarbs(catalog, item);
        const amountMissing = parseAmount(item.amount) === null;
        return (
          <li key={item.key} className="item-row" data-testid="item-row">
            <div className="item-name">
              {name}
              {!result.complete && <span className="flag">{amountMissing ? 'enter an amount' : 'missing data'}</span>}
            </div>
            <div className="item-controls">
              <input
                aria-label={`Amount of ${name}`}
                inputMode="text"
                placeholder="e.g. 2/3"
                value={item.amount}
                onChange={(e) => update(item.key, { amount: e.target.value })}
              />
              <UnitPicker
                label={`Unit for ${name}`}
                units={unitsFor(catalog, item.ref_type, item.ref_id)}
                portions={item.ref_type === 'food' ? catalog.portions(item.ref_id) : []}
                value={item.unit}
                onChange={(unit) => update(item.key, { unit })}
              />
              <span className="item-carbs" aria-label={`Carbs in ${name}`}>
                {result.complete ? formatCarbs(result.carbs_g) : '—'}
              </span>
              {props.reorderable && (
                <>
                  <button type="button" aria-label={`Move ${name} up`} disabled={index === 0} onClick={() => move(index, -1)}>
                    ↑
                  </button>
                  <button
                    type="button"
                    aria-label={`Move ${name} down`}
                    disabled={index === items.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    ↓
                  </button>
                </>
              )}
              <button type="button" aria-label={`Remove ${name}`} onClick={() => onChange(items.filter((i) => i.key !== item.key))}>
                ✕
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
