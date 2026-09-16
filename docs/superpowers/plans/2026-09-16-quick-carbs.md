# Quick Carbs Rows + Per-Meal-Only Goals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user add carbs without a food ("+ Carbs" rows: `ref_type: 'quick'`, grams of carbs, optional label) in the Calculator, meal editor and plan slot editor on web and iOS, drop the day-total goal colour from the Plan screen, then fix tonight's dinner and backfill the meal plan from the log on the live Pi.

**Architecture:** A quick row is an ordinary `meal_item` / `log_item` / `plan_item` with `ref_type = 'quick'`, `unit = 'carbs'`, `amount` = grams of carbs, `ref_id` = its own row id, and (meal/plan only) a nullable `label`; `log_item` keeps using `display_name`/`carbs_g`. Core `itemCarbs` returns the amount for a valid quick row and "incomplete" otherwise, so totals, dose estimates and goal colours pick quick rows up with no other math change. The server widens the `ref_type` CHECK with an atomic table rebuild (migration 005) and validates quick rows; web and iOS add the row type to their editors; a one-off script run through the server's own push path fixes live data after both clients are released.

**Tech Stack:** TypeScript 7 + Vitest 5 (`packages/core`, `server` with Fastify 5 + better-sqlite3 13, `web` with React 19 + Dexie 4 + Playwright 1.63), Swift 6 packages (`CarbBookCore`, `CarbBookKit` with GRDB 7.11.1) tested on Linux via `ios/scripts/swift-test.sh`, SwiftUI app built on GitHub Actions (`build-ipa.yml`, `release.yml`), ipa-hub (`https://ipa.dxshdw.dev/source.json`).

**Spec (source of truth):** `docs/superpowers/specs/2026-09-16-quick-carbs-design.md`. Base: `main` at `f5bbd4d`.

---

## Ground rules (read before Task 1)

- **Branch/worktree.** Work in a worktree: `git -C ~/Projects/CarbBook worktree add ~/Projects/CarbBook-quick-carbs -b feat/quick-carbs f5bbd4d`. All paths below are relative to that worktree unless they start with `~`. Never add, edit or delete `HANDOFF.md`.
- **Merge order.** Parts A–D are committed to `feat/quick-carbs` in order; each part's own tests must be green before the next part starts. Nothing merges to `main` until Task 23: a push to `main` that touches `ios/` publishes an iOS release automatically, and iOS 0.2.0 cannot decode `ref_type: 'quick'`, so the server/web deploy (Parts B/C) and the iOS 0.2.1 release (Part D) must land together. Part E runs only after both are live **and** the user has updated the iPhone app.
- **Part A changes `testdata/units-vectors.json`.** The iOS copies are re-synced in Task 15 (Part D). Do not push the branch to GitHub before Task 15 is committed, or the `testdata-copies` / Swift vector CI jobs go red.
- **Never change an existing expectation in `testdata/`.** Vector edits are additions only.
- **Dose math is unchanged** except that quick rows now count toward carbs. Quick amounts fail closed: blank, fractional text (`1/2`), negative, non-finite or above `DOSE_LIMITS.maxCarbsG` (2000) → the row is incomplete, no dose is shown, and saving/logging is blocked.
- **Commands.** Run from the worktree root unless a step says otherwise. `pnpm install` once after creating the worktree.

## Interpretations (decisions this plan makes where the spec is silent)

1. `ref_id` of a quick row is set to the row's own id by every client write path (log, meal, plan, copy). The server does **not** enforce `ref_id = id` (it is never resolved; a copied row legitimately gets a fresh id and ref_id together, and old rows need no rewrite) — it only requires the usual non-empty `ref_id`.
2. The server rejects a non-null `label` on a food/meal row, requires `carbs_g = amount` on a quick `log_item`, and the rebuilt tables carry matching CHECKs as a backstop.
3. Blank labels are stored as `null` and shown as "Extra carbs"; labels are trimmed and capped at 80 characters (web input `maxLength`, Swift/TS `normalizeQuickLabel`).
4. Quick rows get no unit picker; the row shows "label — N g carbs" plus a label field and a grams field. The unit id `carbs` displays as "g carbs" (web `unitLabel`, Swift `displayUnitName`), so the Log editor reads "Ranch & salad · 7 g carbs" with no further change.
5. Web `dayTotal()` becomes `dayCarbs()` + `dayTotalText()` (no goal). Core `dayGoal` and its vectors stay untouched; iOS `PlanModel.dayGoalFor` is deleted.
6. iOS local migration `v4-quick-carbs` adds `label` and resets the pull cursor (same reason as `v2`: an older app may have pulled rows it could not store fully); rows pending at migration time push without the `label` key so the server keeps its value.
7. Part E backfill orders a slot's items by `log_item.rowid` (insertion order — `log_item` has no position), skips entries without a window, skips a slot that already has a live plan entry (reported), and skips a log entry already linked to a plan entry.

## File structure

**Part A — core TS + vectors**
- Modify `packages/core/src/types.ts` — `RefType` gains `'quick'`; `MealItemData.label?`, `PlanItemData.label?`.
- Modify `packages/core/src/units.ts` — `QUICK_UNIT`, `QUICK_LABEL_MAX`, `QUICK_DEFAULT_LABEL`, `isValidQuickCarbs`, `quickUnits`, `normalizeQuickLabel`, `quickDisplayName`, `itemRefId`.
- Modify `packages/core/src/carbs.ts` — `quickItemCarbs`; `resolveItem` becomes a switch.
- Create `packages/core/test/quick.test.ts`.
- Modify `testdata/units-vectors.json` (additions only), `packages/core/test/vectors.test.ts` (quick unit lists).

**Part B — server**
- Create `server/migrations/005_quick_carbs.sql`, `server/test/migration-005.test.ts`, `server/test/sync-quick.test.ts`.
- Modify `server/test/migration-004.test.ts` (pin to migrations 001–004).
- Modify `server/src/sync/tables.ts` — `REF_TYPES`, `itemLabel`, `checkItemKind`, item specs.
- Modify `server/test/sync-validate.test.ts` (two expectations that now include `quick`/`label`, plus new cases).

**Part C — web**
- Modify `web/src/ui/ItemEditor.tsx` (full rewrite below), `web/src/ui/format.ts`, `web/src/ui/SearchPanel.tsx`.
- Modify `web/src/screens/Calculator.tsx`, `web/src/meals/MealEditor.tsx`, `web/src/meals/saveMeal.ts`.
- Modify `web/src/plan/SlotEditor.tsx`, `web/src/plan/saveSlot.ts`, `web/src/plan/copy.ts`, `web/src/plan/suggestion.ts`, `web/src/plan/slots.ts`, `web/src/screens/Plan.tsx`.
- Modify `web/src/log/LogEntryEditor.tsx`.
- Create `web/test/quick-items.test.ts`; modify `web/test/calculator.test.tsx`, `meals.test.tsx`, `plan.test.tsx`, `plan-slots.test.ts`, `plan-copy.test.ts`, `plan-calculator.test.tsx`, `log.test.tsx`, `web/e2e/carbbook.spec.ts`.

**Part D — iOS**
- Modify `ios/CarbBookCore/Sources/CarbBookCore/{Types,Plan,Units,Carbs,Calculator,LogRecalc}.swift`; create `ios/CarbBookCore/Tests/CarbBookCoreTests/QuickCarbsTests.swift`; modify `VectorTests.swift`; re-sync `Tests/CarbBookCoreTests/Resources/units-vectors.json`.
- Modify `ios/CarbBookKit/Sources/CarbBookKit/{Schema,TableCodec,LocalSyncStore,CalculatorInputs,PlanEditing,PlanSuggestion,FoodLabel}.swift`; create `ItemDisplay.swift`; create `Tests/CarbBookKitTests/QuickCarbsKitTests.swift`.
- Create `ios/CarbBook/Calculator/QuickCarbsSheet.swift`; modify `ios/CarbBook/Calculator/{CalculatorView,CalculatorModel}.swift`, `ios/CarbBook/Meals/MealEditorView.swift`, `ios/CarbBook/Plan/{PlanSlotEditorView,PlanWeekView,PlanModel}.swift`, `ios/project.yml`.

**Part E — live data**
- Create `deploy/data-fixes/2026-09-16-quick-carbs.mts` (not part of the image: `deploy/` is excluded from the deploy rsync; it is piped into the container).

---

# Part A — Core TypeScript + shared vectors

### Task 1: Quick-row types and unit helpers

**Files:**
- Modify: `packages/core/src/types.ts:76` (RefType), `:78-86` (MealItemData), `:170-178` (PlanItemData)
- Modify: `packages/core/src/units.ts:1` (imports) and append at end of file
- Test: `packages/core/test/quick.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/quick.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  QUICK_DEFAULT_LABEL,
  QUICK_LABEL_MAX,
  QUICK_UNIT,
  isValidQuickCarbs,
  itemRefId,
  normalizeQuickLabel,
  quickDisplayName,
  quickUnits,
} from '../src/units';

describe('quick carbs helpers', () => {
  it('uses grams of carbs as the only unit', () => {
    expect(QUICK_UNIT).toBe('carbs');
    expect(quickUnits()).toEqual(['carbs']);
  });

  it('accepts 0..2000 g and fails closed on everything else', () => {
    for (const ok of [0, 7, 7.5, 2000]) expect(isValidQuickCarbs(ok), String(ok)).toBe(true);
    for (const bad of [-1, 2000.01, 2001, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(isValidQuickCarbs(bad), String(bad)).toBe(false);
    }
  });

  it('stores labels trimmed, capped at 80 characters, and null when blank', () => {
    expect(QUICK_LABEL_MAX).toBe(80);
    expect(normalizeQuickLabel('  Ranch & salad ')).toBe('Ranch & salad');
    expect(normalizeQuickLabel('   ')).toBeNull();
    expect(normalizeQuickLabel(undefined)).toBeNull();
    expect(normalizeQuickLabel(null)).toBeNull();
    expect(normalizeQuickLabel('x'.repeat(90))).toBe('x'.repeat(80));
  });

  it('shows a blank label as "Extra carbs"', () => {
    expect(QUICK_DEFAULT_LABEL).toBe('Extra carbs');
    expect(quickDisplayName(null)).toBe('Extra carbs');
    expect(quickDisplayName(' Salsa ')).toBe('Salsa');
  });

  it('points a quick row at itself and leaves other refs alone', () => {
    expect(itemRefId('quick', '', 'row-1')).toBe('row-1');
    expect(itemRefId('quick', 'stale', 'row-2')).toBe('row-2');
    expect(itemRefId('food', 'rice', 'row-3')).toBe('rice');
    expect(itemRefId('meal', 'bowl', 'row-4')).toBe('bowl');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --dir packages/core exec vitest run test/quick.test.ts`
Expected: FAIL — `SyntaxError`/`does not provide an export named 'QUICK_DEFAULT_LABEL'` (or every test failing with `... is not a function`).

- [ ] **Step 3: Write minimal implementation**

In `packages/core/src/types.ts` replace

```ts
export type RefType = 'food' | 'meal';
```

with

```ts
/** `quick` = a carbs-only row with no food (quick-carbs spec §2): amount is grams of carbs, unit `carbs`. */
export type RefType = 'food' | 'meal' | 'quick';
```

In the same file, in **both** `MealItemData` and `PlanItemData`, add after `position: number;`:

```ts
  /** Quick carbs rows only (quick-carbs spec §2): optional text, at most 80 characters. */
  label?: string | null;
```

In `packages/core/src/units.ts` replace line 1

```ts
import type { FoodData, MealData, PortionData } from './types';
```

with

```ts
import { DOSE_LIMITS } from './dose';
import type { FoodData, Id, MealData, PortionData, RefType } from './types';
```

(`dose.ts` only imports *types* from `carbs.ts`, so this adds no runtime import cycle.) Append to the end of `units.ts`:

```ts
/** Quick carbs rows (quick-carbs spec §2): `amount` is grams of carbs and this is the only unit. */
export const QUICK_UNIT = 'carbs';
export const QUICK_LABEL_MAX = 80;
export const QUICK_DEFAULT_LABEL = 'Extra carbs';

/** Grams of carbs on a quick row: finite and 0 <= amount <= DOSE_LIMITS.maxCarbsG. */
export function isValidQuickCarbs(amount: number): boolean {
  return Number.isFinite(amount) && amount >= 0 && amount <= DOSE_LIMITS.maxCarbsG;
}

export function quickUnits(): string[] {
  return [QUICK_UNIT];
}

/** Stored form of a quick row's label: trimmed, at most 80 characters, null when blank. */
export function normalizeQuickLabel(label: string | null | undefined): string | null {
  const trimmed = (label ?? '').trim().slice(0, QUICK_LABEL_MAX).trim();
  return trimmed === '' ? null : trimmed;
}

/** What a quick row is called on screen and in log snapshots. */
export function quickDisplayName(label: string | null | undefined): string {
  return normalizeQuickLabel(label) ?? QUICK_DEFAULT_LABEL;
}

/** ref_id to store for a row: a quick row points at itself (keeps ref_id non-null); others keep theirs. */
export function itemRefId(refType: RefType, refId: Id, rowId: Id): Id {
  return refType === 'quick' ? rowId : refId;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --dir packages/core exec vitest run test/quick.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm --dir packages/core typecheck`
Expected: exits 0 with no output. (If `carbs.ts` reports that `refType === 'food' ? … : …` no longer covers `'quick'`, that is fixed in Task 2 — it is a ternary, so it should still compile.)

```bash
git add packages/core/src/types.ts packages/core/src/units.ts packages/core/test/quick.test.ts
git commit -m "core: quick carbs types and unit helpers"
```

### Task 2: `itemCarbs` for quick rows

**Files:**
- Modify: `packages/core/src/carbs.ts:2-15` (imports), `:156-172` (`resolveItem` / `itemCarbs`)
- Test: `packages/core/test/quick.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `packages/core/test/quick.test.ts` (add `createCatalog, itemCarbs, sumCarbs, wouldCreateCycle` import at the top: `import { createCatalog, itemCarbs, sumCarbs, wouldCreateCycle } from '../src/carbs';`):

```ts
describe('itemCarbs for quick rows', () => {
  const catalog = createCatalog({
    foods: [{ id: 'tortilla', name: 'Tortilla', carbs_per_100g: 48 }],
    meals: [{ id: 'plate', name: 'Plate', yield_servings: 2, total_weight_g: null }],
    meal_items: [
      { id: 'm1', meal_id: 'plate', ref_type: 'food', ref_id: 'tortilla', amount: 100, unit: 'g', position: 0 },
      { id: 'm2', meal_id: 'plate', ref_type: 'quick', ref_id: 'm2', amount: 7, unit: 'carbs', position: 1, label: 'Salsa' },
    ],
  });

  it('is the amount itself, without looking up ref_id', () => {
    expect(itemCarbs(catalog, 'quick', 'no-such-row', 7, 'carbs')).toEqual({ carbs_g: 7, complete: true });
    expect(itemCarbs(catalog, 'quick', '', 0, 'carbs')).toEqual({ carbs_g: 0, complete: true });
    expect(itemCarbs(catalog, 'quick', 'q', 2000, 'carbs')).toEqual({ carbs_g: 2000, complete: true });
  });

  it('fails closed on a bad amount or unit', () => {
    for (const [amount, unit] of [
      [2001, 'carbs'],
      [-1, 'carbs'],
      [Number.NaN, 'carbs'],
      [Number.POSITIVE_INFINITY, 'carbs'],
      [7, 'g'],
      [7, 'serving'],
    ] as const) {
      expect(itemCarbs(catalog, 'quick', 'q', amount, unit), `${amount} ${unit}`).toEqual({ carbs_g: 0, complete: false });
    }
  });

  it('counts inside meals and totals like any other row', () => {
    expect(itemCarbs(catalog, 'meal', 'plate', 1, 'serving')).toEqual({ carbs_g: 27.5, complete: true });
    const total = sumCarbs([itemCarbs(catalog, 'food', 'tortilla', 100, 'g'), itemCarbs(catalog, 'quick', 'q', 7, 'carbs')]);
    expect(total).toEqual({ carbs_g: 55, complete: true });
  });

  it('never creates a meal cycle', () => {
    expect(wouldCreateCycle(catalog, 'plate', 'm2')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --dir packages/core exec vitest run test/quick.test.ts`
Expected: FAIL — "is the amount itself" gets `{ carbs_g: 0, complete: false }` (quick rows currently fall into the meal branch and find no meal).

- [ ] **Step 3: Write minimal implementation**

In `packages/core/src/carbs.ts`, add `QUICK_UNIT,` after `PORTION_PREFIX,` and `isValidQuickCarbs,` after `isValidPortionCarbs,` in the `./units` import. Replace the whole `resolveItem` function and the doc comment of `itemCarbs`:

```ts
/** Quick carbs row: the amount is the carbs. Anything else (wrong unit, out of range) is incomplete. */
function quickItemCarbs(amount: number, unit: string): CarbResult {
  return unit === QUICK_UNIT && isValidQuickCarbs(amount) ? { carbs_g: amount, complete: true } : INCOMPLETE;
}

function resolveItem(
  catalog: Catalog,
  refType: RefType,
  refId: Id,
  amount: number,
  unit: string,
  visiting: Set<Id>,
): CarbResult {
  switch (refType) {
    case 'food':
      return foodItemCarbs(catalog, refId, amount, unit);
    case 'meal':
      return mealItemCarbs(catalog, refId, amount, unit, visiting);
    case 'quick':
      return quickItemCarbs(amount, unit);
    default:
      return INCOMPLETE;
  }
}

/** Carbs for one line item (a food, a meal or a quick carbs row) at the given amount and unit. */
```

(The `export function itemCarbs(...)` line below the comment stays as it is.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --dir packages/core test`
Expected: all test files pass, 0 failed (the existing `carbs.test.ts`, `vectors.test.ts`, `goal.test.ts`, `dose.test.ts` are unchanged and still green).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/carbs.ts packages/core/test/quick.test.ts
git commit -m "core: quick carbs rows count as their own grams of carbs"
```

### Task 3: Shared vectors (additions only)

**Files:**
- Modify: `testdata/units-vectors.json` (add lines only)
- Modify: `packages/core/test/vectors.test.ts:944-947` (imports), `:981-1011` (unit list loop + presence check)

- [ ] **Step 1: Write the failing test**

In `packages/core/test/vectors.test.ts` change the units import to

```ts
import { foodAmountToGrams, foodUnits, mealUnits, quickUnits } from '../src/units';
```

Inside `it('has cases to run', …)` of `describe('units vectors')` add:

```ts
    expect(u.carb_cases.some((c) => c.ref_type === 'quick')).toBe(true);
    expect(u.unit_list_cases.some((c) => c.ref_type === 'quick')).toBe(true);
```

Replace the unit-list loop body with:

```ts
  for (const c of u.unit_list_cases) {
    it(`unit list: ${c.ref_id}`, () => {
      const units =
        c.ref_type === 'quick'
          ? quickUnits()
          : c.ref_type === 'food'
            ? foodUnits(catalog.food(c.ref_id)!, catalog.portions(c.ref_id))
            : mealUnits(catalog.meal(c.ref_id)!);
      expect(units).toEqual(c.expect);
    });
  }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --dir packages/core exec vitest run test/vectors.test.ts`
Expected: FAIL — `units vectors > has cases to run` (`expected false to be true`).

- [ ] **Step 3: Add the vectors (never edit an existing line's values)**

In `testdata/units-vectors.json`:

1. In `"meals"`, replace the last line
   `    { "id": "bad", "name": "Has an unlabeled food", "yield_servings": 1, "total_weight_g": null }`
   with
   ```json
       { "id": "bad", "name": "Has an unlabeled food", "yield_servings": 1, "total_weight_g": null },
       { "id": "with-quick", "name": "Bread with extra carbs", "yield_servings": 2, "total_weight_g": null }
   ```
2. In `"meal_items"`, replace the last line
   `    { "id": "i6", "meal_id": "bad", "ref_type": "food", "ref_id": "mystery", "amount": 50, "unit": "g", "position": 1 }`
   with
   ```json
       { "id": "i6", "meal_id": "bad", "ref_type": "food", "ref_id": "mystery", "amount": 50, "unit": "g", "position": 1 },
       { "id": "i7", "meal_id": "with-quick", "ref_type": "food", "ref_id": "bread", "amount": 2, "unit": "p:bread-slice", "position": 0 },
       { "id": "i8", "meal_id": "with-quick", "ref_type": "quick", "ref_id": "i8", "amount": 7, "unit": "carbs", "label": "Ranch & salad", "position": 1 }
   ```
3. In `"carb_cases"`, replace the last line
   `    { "name": "volume portion carbs_g is ignored", "ref_type": "food", "ref_id": "vol-portion-carbs", "amount": 1, "unit": "p:vp-cup", "expect": { "carbs_g": 40, "complete": true } }`
   with
   ```json
       { "name": "volume portion carbs_g is ignored", "ref_type": "food", "ref_id": "vol-portion-carbs", "amount": 1, "unit": "p:vp-cup", "expect": { "carbs_g": 40, "complete": true } },
       { "name": "quick carbs zero", "ref_type": "quick", "ref_id": "q1", "amount": 0, "unit": "carbs", "expect": { "carbs_g": 0, "complete": true } },
       { "name": "quick carbs 7 g", "ref_type": "quick", "ref_id": "q1", "amount": 7, "unit": "carbs", "expect": { "carbs_g": 7, "complete": true } },
       { "name": "quick carbs decimal", "ref_type": "quick", "ref_id": "q1", "amount": 7.5, "unit": "carbs", "expect": { "carbs_g": 7.5, "complete": true } },
       { "name": "quick carbs at the 2000 g limit", "ref_type": "quick", "ref_id": "q1", "amount": 2000, "unit": "carbs", "expect": { "carbs_g": 2000, "complete": true } },
       { "name": "quick carbs above the limit", "ref_type": "quick", "ref_id": "q1", "amount": 2001, "unit": "carbs", "expect": { "carbs_g": 0, "complete": false } },
       { "name": "quick carbs negative", "ref_type": "quick", "ref_id": "q1", "amount": -1, "unit": "carbs", "expect": { "carbs_g": 0, "complete": false } },
       { "name": "quick carbs wrong unit", "ref_type": "quick", "ref_id": "q1", "amount": 7, "unit": "g", "expect": { "carbs_g": 0, "complete": false } },
       { "name": "quick carbs ref_id is never looked up", "ref_type": "quick", "ref_id": "not-a-row", "amount": 12, "unit": "carbs", "expect": { "carbs_g": 12, "complete": true } },
       { "name": "meal with a quick component", "ref_type": "meal", "ref_id": "with-quick", "amount": 1, "unit": "serving", "expect": { "carbs_g": 15.75, "complete": true } }
   ```
4. In `"unit_list_cases"`, replace the last line
   `    { "ref_type": "food", "ref_id": "vol-portion-carbs", "expect": ["g", "kg", "oz", "lb", "ml", "l", "tsp", "tbsp", "floz", "cup"] }`
   with
   ```json
       { "ref_type": "food", "ref_id": "vol-portion-carbs", "expect": ["g", "kg", "oz", "lb", "ml", "l", "tsp", "tbsp", "floz", "cup"] },
       { "ref_type": "quick", "ref_id": "q1", "expect": ["carbs"] }
   ```

(JSON has no NaN; non-finite amounts are covered by `quick.test.ts` and Swift `QuickCarbsTests` instead. "meal with a quick component": 2 bread slices = 24.5 g, + 7 g = 31.5 g over 2 servings = 15.75 g.)

- [ ] **Step 4: Verify no existing vector changed, then run tests**

Run: `git diff -U0 testdata/units-vectors.json | grep '^-' | grep -v '^---'`
Expected: exactly four `-` lines, each identical to a `+` line apart from the added trailing comma (check by eye).

Run: `pnpm --dir packages/core test && pnpm --dir packages/core typecheck`
Expected: all pass (the 10 new vector cases appear as `carbs: quick carbs …`, `unit list: q1`), typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add testdata/units-vectors.json packages/core/test/vectors.test.ts
git commit -m "testdata: quick carbs vectors (additions only)"
```

---

# Part B — Server

### Task 4: Migration 005 (atomic rebuild of the item tables)

**Files:**
- Create: `server/migrations/005_quick_carbs.sql`
- Create: `server/test/migration-005.test.ts`
- Modify: `server/test/migration-004.test.ts:1-18, 36-56`

- [ ] **Step 1: Pin the 004 test to migrations 001–004**

`migration-004.test.ts` calls `migrate(db)` with the default directory and expects version 4; with 005 present it would get 5. In that file add below `dbAtVersion3()`:

```ts
/** A migrations directory holding exactly 001-004, so migrate() stops at version 4. */
function dirThrough004() {
  const dir = mkdtempSync(join(tmpdir(), 'carbbook-mig4-through-'));
  for (const file of ['001_init.sql', '002_usda_search.sql', '003_any_unit_foods.sql', '004_meal_plan.sql']) {
    copyFileSync(join(MIGRATIONS_DIR, file), join(dir, file));
  }
  return dir;
}
```

and change the two assertions:
- in `'upgrades a version-3 database with real rows without touching them'`: `expect(migrate(db)).toBe(4);` → `expect(migrate(db, dirThrough004())).toBe(4);`
- in `'migrates a fresh database straight to version 4'`: `expect(migrate(db)).toBe(4);` → `expect(migrate(db, dirThrough004())).toBe(4);`

- [ ] **Step 2: Write the failing test**

Create `server/test/migration-005.test.ts`:

```ts
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type Db, MIGRATIONS_DIR, migrate, openDb } from '../src/db';

const THROUGH_004 = ['001_init.sql', '002_usda_search.sql', '003_any_unit_foods.sql', '004_meal_plan.sql'];
const ITEM_TABLES = ['meal_item', 'log_item', 'plan_item'] as const;

/** A DB at exactly version 4, as the live Pi database is before this deploy. */
function dbAtVersion4() {
  const dir = mkdtempSync(join(tmpdir(), 'carbbook-mig5-'));
  for (const file of THROUGH_004) copyFileSync(join(MIGRATIONS_DIR, file), join(dir, file));
  const db = openDb(':memory:');
  expect(migrate(db, dir)).toBe(4);
  return { db, dir };
}

/** Rows shaped like the live data on 2026-09-16: uuidv7 ids, portion units, a soft delete, device ids. */
function seedLiveLikeRows(db: Db) {
  db.exec(`
    INSERT INTO meal_item (id, meal_id, ref_type, ref_id, amount, unit, position, updated_at, updated_by, deleted, server_seq) VALUES
      ('01a0a519-3167-7aa1-8000-000000000001', '01a0a519-3167-7e92-8587-de9485f35723', 'food', 'usda-170903', 170, 'g', 0, 1789480000000, 'web-01a0a2c1', 0, 21),
      ('01a0a519-3167-7aa1-8000-000000000002', '01a0a519-3167-7e92-8587-de9485f35723', 'food', '01a0a518-9f00-7000-8000-000000000001', 0.5, 'p:01a0a518-9f00-7000-8000-000000000002', 1, 1789480000001, 'web-01a0a2c1', 0, 22),
      ('01a0a519-3167-7aa1-8000-000000000003', '01a0a519-3167-7e92-8587-de9485f35723', 'meal', '01a0a517-0000-7000-8000-000000000001', 1, 'serving', 2, 1789480000002, 'ios-01a0a2c9', 1, 23);
    INSERT INTO log_entry (id, eaten_at, window_name, bg_mgdl, bg_source, bg_trend, total_carbs_g, suggested_units, taken_units, settings_version_id, notes, updated_at, updated_by, deleted, server_seq) VALUES
      ('01a0ac75-2c6b-7128-ab9f-4d8930778697', 1789599755000, 'Dinner', NULL, 'none', NULL, 73.1, 9, 9, '01a0a9f0-0000-7000-8000-000000000001', NULL, 1789599755000, 'ios-01a0a2c9', 0, 40);
    INSERT INTO log_item (id, log_entry_id, ref_type, ref_id, display_name, amount, unit, carbs_g, updated_at, updated_by, deleted, server_seq) VALUES
      ('01a0ac75-2c6c-7000-8000-000000000001', '01a0ac75-2c6b-7128-ab9f-4d8930778697', 'food', '01a0ac6c-2f11-72fe-a0e5-3681ce8dedb0', 'Taquitos', 4.3, 'p:01a0ac6c-2f11-7e22-8c4b-97f9cf5c0683', 73.1, 1789599755000, 'ios-01a0a2c9', 0, 41),
      ('01a0ab23-bf2b-7000-8000-000000000001', '01a0ab23-bf2b-7bbd-8967-229be21606c2', 'food', 'usda-2263891', 'Grapes, green, seedless, raw', 85, 'g', 15.8131875, 1789577641000, 'web-01a0a2c1', 0, 42);
    INSERT INTO plan_entry (id, date, window_name, status, note, log_entry_id, updated_at, updated_by, deleted, server_seq) VALUES
      ('01a0ad00-0000-7000-8000-000000000001', '2026-09-17', 'Lunch', 'planned', 'leftovers', NULL, 1789600000000, 'web-01a0a2c1', 0, 43);
    INSERT INTO plan_item (id, plan_entry_id, ref_type, ref_id, amount, unit, position, updated_at, updated_by, deleted, server_seq) VALUES
      ('01a0ad00-0000-7000-8000-000000000002', '01a0ad00-0000-7000-8000-000000000001', 'meal', '01a0a519-3167-7e92-8587-de9485f35723', 1, 'serving', 0, 1789600000001, 'web-01a0a2c1', 0, 44),
      ('01a0ad00-0000-7000-8000-000000000003', '01a0ad00-0000-7000-8000-000000000001', 'food', 'usda-170903', 0, 'g', 1, 1789600000002, 'web-01a0a2c1', 1, 45);
    UPDATE seq_counter SET value = 45;
  `);
}

const rows = (db: Db, table: string) => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all() as Record<string, unknown>[];
const indexNames = (db: Db, table: string) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? ORDER BY name").pluck().all(table) as string[]);
const columns = (db: Db, table: string) => db.prepare(`SELECT name FROM pragma_table_info('${table}')`).pluck().all() as string[];

describe('migration 005 (quick carbs)', () => {
  it('upgrades a version-4 database keeping every row, server_seq, index and the sequence counter', () => {
    const { db } = dbAtVersion4();
    seedLiveLikeRows(db);
    const before = Object.fromEntries(ITEM_TABLES.map((t) => [t, rows(db, t)]));
    const indexesBefore = Object.fromEntries(ITEM_TABLES.map((t) => [t, indexNames(db, t)]));

    expect(migrate(db)).toBe(5);
    expect(db.pragma('user_version', { simple: true })).toBe(5);

    for (const table of ITEM_TABLES) {
      const after = rows(db, table).map(({ label, ...rest }) => {
        if (table !== 'log_item') expect(label, table).toBeNull();
        return rest;
      });
      expect(after, table).toEqual(before[table]);
      expect(indexNames(db, table), table).toEqual(indexesBefore[table]);
    }
    expect(columns(db, 'meal_item')).toContain('label');
    expect(columns(db, 'plan_item')).toContain('label');
    expect(columns(db, 'log_item')).not.toContain('label');
    expect(db.prepare('SELECT value FROM seq_counter').pluck().get()).toBe(45);
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    // No temp helper tables are left behind.
    expect(db.prepare("SELECT count(*) FROM temp.sqlite_master WHERE name LIKE 'migration_005%'").pluck().get()).toBe(0);
  });

  it('accepts well-formed quick rows and rejects malformed ones at the table level', () => {
    const db = openDb(':memory:');
    migrate(db);
    const meal = (fields: Record<string, unknown>) =>
      db
        .prepare(
          `INSERT INTO meal_item (id, meal_id, ref_type, ref_id, amount, unit, position, label, updated_at, updated_by, deleted, server_seq)
           VALUES (@id, 'm1', @ref_type, @id, @amount, @unit, 0, @label, 1, 'd', 0, 1)`,
        )
        .run({ ref_type: 'quick', amount: 7, unit: 'carbs', label: 'Ranch & salad', ...fields });
    const log = (fields: Record<string, unknown>) =>
      db
        .prepare(
          `INSERT INTO log_item (id, log_entry_id, ref_type, ref_id, display_name, amount, unit, carbs_g, updated_at, updated_by, deleted, server_seq)
           VALUES (@id, 'e1', 'quick', @id, 'Ranch & salad', @amount, 'carbs', @carbs_g, 1, 'd', 0, 1)`,
        )
        .run({ amount: 7, carbs_g: 7, ...fields });
    const plan = (fields: Record<string, unknown>) =>
      db
        .prepare(
          `INSERT INTO plan_item (id, plan_entry_id, ref_type, ref_id, amount, unit, position, label, updated_at, updated_by, deleted, server_seq)
           VALUES (@id, 'p1', @ref_type, @id, @amount, @unit, 0, @label, 1, 'd', 0, 1)`,
        )
        .run({ ref_type: 'quick', amount: 7, unit: 'carbs', label: null, ...fields });

    expect(() => meal({ id: 'ok1' })).not.toThrow();
    expect(() => meal({ id: 'ok2', amount: 2000, label: null })).not.toThrow();
    expect(() => log({ id: 'ok3' })).not.toThrow();
    expect(() => plan({ id: 'ok4', amount: 0 })).not.toThrow();

    expect(() => meal({ id: 'b1', unit: 'g' })).toThrow(/CHECK constraint failed/);
    expect(() => meal({ id: 'b2', amount: 2001 })).toThrow(/CHECK constraint failed/);
    expect(() => meal({ id: 'b3', amount: -1 })).toThrow(/CHECK constraint failed/);
    expect(() => meal({ id: 'b4', label: 'x'.repeat(81) })).toThrow(/CHECK constraint failed/);
    expect(() => meal({ id: 'b5', ref_type: 'food', unit: 'g', label: 'not on food rows' })).toThrow(/CHECK constraint failed/);
    expect(() => meal({ id: 'b6', ref_type: 'snack' })).toThrow(/CHECK constraint failed/);
    expect(() => log({ id: 'b7', carbs_g: 8 })).toThrow(/CHECK constraint failed/);
    expect(() => plan({ id: 'b8', amount: 2001 })).toThrow(/CHECK constraint failed/);
    expect(() => plan({ id: 'b9', amount: -1 })).toThrow(/CHECK constraint failed/);
  });

  it('refuses to run, changing nothing, when an item table already has a label column', () => {
    const { db } = dbAtVersion4();
    seedLiveLikeRows(db);
    db.exec('ALTER TABLE plan_item ADD COLUMN label TEXT');
    const before = rows(db, 'meal_item');

    expect(() => migrate(db)).toThrow(/migration 005: unexpected item data/);
    expect(db.pragma('user_version', { simple: true })).toBe(4);
    expect(columns(db, 'meal_item')).not.toContain('label');
    expect(rows(db, 'meal_item')).toEqual(before);
  });

  it('rolls everything back when a later statement in the file fails', () => {
    const { db, dir } = dbAtVersion4();
    seedLiveLikeRows(db);
    const sql = readFileSync(join(MIGRATIONS_DIR, '005_quick_carbs.sql'), 'utf8');
    writeFileSync(join(dir, '005_quick_carbs.sql'), `${sql}\nSELECT this_function_does_not_exist();\n`);
    const before = Object.fromEntries(ITEM_TABLES.map((t) => [t, rows(db, t)]));

    expect(() => migrate(db, dir)).toThrow();
    expect(db.pragma('user_version', { simple: true })).toBe(4);
    for (const table of ITEM_TABLES) expect(rows(db, table), table).toEqual(before[table]);
    expect(columns(db, 'meal_item')).not.toContain('label');
    expect(() =>
      db
        .prepare(
          `INSERT INTO plan_item (id, plan_entry_id, ref_type, ref_id, amount, unit, position, updated_at, updated_by, deleted, server_seq)
           VALUES ('q', 'p', 'quick', 'q', 7, 'carbs', 0, 1, 'd', 0, 1)`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/);
    expect(db.prepare("SELECT count(*) FROM sqlite_master WHERE name LIKE '%_new'").pluck().get()).toBe(0);
  });

  it('migrates a fresh database straight to version 5', () => {
    const db = openDb(':memory:');
    expect(migrate(db)).toBe(5);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --dir server exec vitest run test/migration-005.test.ts test/migration-004.test.ts`
Expected: `migration-004` PASS; `migration-005` FAIL (`expected 4 to be 5`, then `ENOENT … 005_quick_carbs.sql` in the rollback test).

- [ ] **Step 4: Write the migration**

Create `server/migrations/005_quick_carbs.sql`:

```sql
-- Quick carbs rows (docs/superpowers/specs/2026-09-16-quick-carbs-design.md §2): ref_type 'quick' on
-- meal_item, log_item and plan_item, and a nullable label on meal_item and plan_item. SQLite cannot
-- change a CHECK in place, so the three tables are rebuilt with every row, server_seq value and index
-- kept (the 003 pattern). The runner (server/src/db.ts) wraps this file in one transaction: any
-- failure below rolls the whole file back and leaves user_version at 4.

-- Deploy guard: refuse unexpected data instead of failing on an opaque CHECK or silently changing it.
CREATE TEMP TABLE migration_005_guard (problems INTEGER NOT NULL);
CREATE TEMP TRIGGER migration_005_guard_check BEFORE INSERT ON migration_005_guard
  WHEN NEW.problems > 0
  BEGIN
    SELECT RAISE(ABORT, 'migration 005: unexpected item data (ref_type other than food/meal, a negative plan_item amount, or a label column that already exists); inspect meal_item, log_item and plan_item before upgrading');
  END;
INSERT INTO migration_005_guard (problems) SELECT
    (SELECT count(*) FROM meal_item WHERE ref_type NOT IN ('food', 'meal'))
  + (SELECT count(*) FROM log_item WHERE ref_type NOT IN ('food', 'meal'))
  + (SELECT count(*) FROM plan_item WHERE ref_type NOT IN ('food', 'meal') OR amount < 0)
  + (SELECT count(*) FROM pragma_table_info('meal_item') WHERE name = 'label')
  + (SELECT count(*) FROM pragma_table_info('plan_item') WHERE name = 'label');
DROP TRIGGER migration_005_guard_check;
DROP TABLE migration_005_guard;

-- Row counts before the rebuild; compared with the rebuilt tables at the end.
CREATE TEMP TABLE migration_005_before AS SELECT
  (SELECT count(*) FROM meal_item) AS meal_items,
  (SELECT count(*) FROM log_item) AS log_items,
  (SELECT count(*) FROM plan_item) AS plan_items;

-- meal_item
CREATE TABLE meal_item_new (
  id TEXT PRIMARY KEY,
  meal_id TEXT NOT NULL,
  ref_type TEXT NOT NULL CHECK (ref_type IN ('food', 'meal', 'quick')),
  ref_id TEXT NOT NULL,
  amount REAL NOT NULL,
  unit TEXT NOT NULL,
  position INTEGER NOT NULL,
  label TEXT CHECK (label IS NULL OR length(label) <= 80),
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  server_seq INTEGER NOT NULL,
  CHECK (ref_type <> 'quick' OR (unit = 'carbs' AND amount >= 0 AND amount <= 2000)),
  CHECK (ref_type = 'quick' OR label IS NULL)
);
INSERT INTO meal_item_new (id, meal_id, ref_type, ref_id, amount, unit, position, label, updated_at, updated_by, deleted, server_seq)
  SELECT id, meal_id, ref_type, ref_id, amount, unit, position, NULL, updated_at, updated_by, deleted, server_seq FROM meal_item;
DROP TABLE meal_item;
ALTER TABLE meal_item_new RENAME TO meal_item;
CREATE INDEX meal_item_server_seq ON meal_item (server_seq);
CREATE INDEX meal_item_meal ON meal_item (meal_id);

-- log_item (no label: display_name already carries it; carbs_g must equal amount for quick rows)
CREATE TABLE log_item_new (
  id TEXT PRIMARY KEY,
  log_entry_id TEXT NOT NULL,
  ref_type TEXT NOT NULL CHECK (ref_type IN ('food', 'meal', 'quick')),
  ref_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  amount REAL NOT NULL,
  unit TEXT NOT NULL,
  carbs_g REAL NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  server_seq INTEGER NOT NULL,
  CHECK (ref_type <> 'quick' OR (unit = 'carbs' AND amount >= 0 AND amount <= 2000 AND carbs_g = amount))
);
INSERT INTO log_item_new (id, log_entry_id, ref_type, ref_id, display_name, amount, unit, carbs_g, updated_at, updated_by, deleted, server_seq)
  SELECT id, log_entry_id, ref_type, ref_id, display_name, amount, unit, carbs_g, updated_at, updated_by, deleted, server_seq FROM log_item;
DROP TABLE log_item;
ALTER TABLE log_item_new RENAME TO log_item;
CREATE INDEX log_item_server_seq ON log_item (server_seq);
CREATE INDEX log_item_entry ON log_item (log_entry_id);
CREATE INDEX log_item_ref ON log_item (ref_id);

-- plan_item
CREATE TABLE plan_item_new (
  id TEXT PRIMARY KEY,
  plan_entry_id TEXT NOT NULL,
  ref_type TEXT NOT NULL CHECK (ref_type IN ('food', 'meal', 'quick')),
  ref_id TEXT NOT NULL,
  amount REAL NOT NULL CHECK (amount >= 0),
  unit TEXT NOT NULL,
  position INTEGER NOT NULL,
  label TEXT CHECK (label IS NULL OR length(label) <= 80),
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  server_seq INTEGER NOT NULL,
  CHECK (ref_type <> 'quick' OR (unit = 'carbs' AND amount <= 2000)),
  CHECK (ref_type = 'quick' OR label IS NULL)
);
INSERT INTO plan_item_new (id, plan_entry_id, ref_type, ref_id, amount, unit, position, label, updated_at, updated_by, deleted, server_seq)
  SELECT id, plan_entry_id, ref_type, ref_id, amount, unit, position, NULL, updated_at, updated_by, deleted, server_seq FROM plan_item;
DROP TABLE plan_item;
ALTER TABLE plan_item_new RENAME TO plan_item;
CREATE INDEX plan_item_server_seq ON plan_item (server_seq);
CREATE INDEX plan_item_entry ON plan_item (plan_entry_id);

-- Every row survived the rebuild.
CREATE TEMP TABLE migration_005_after (lost INTEGER NOT NULL);
CREATE TEMP TRIGGER migration_005_after_check BEFORE INSERT ON migration_005_after
  WHEN NEW.lost <> 0
  BEGIN
    SELECT RAISE(ABORT, 'migration 005: row counts changed during the item table rebuild');
  END;
INSERT INTO migration_005_after (lost) SELECT
    abs((SELECT count(*) FROM meal_item) - b.meal_items)
  + abs((SELECT count(*) FROM log_item) - b.log_items)
  + abs((SELECT count(*) FROM plan_item) - b.plan_items)
  FROM migration_005_before AS b;
DROP TRIGGER migration_005_after_check;
DROP TABLE migration_005_after;
DROP TABLE migration_005_before;
```

(This exact SQL was dry-run against a copy of the 2026-09-16 03:15 Pi backup while writing this plan: 2 meal_items / 10 log_items preserved byte-for-byte, indexes identical, `integrity_check` ok, guard aborts and leaves `user_version` 4.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --dir server exec vitest run test/migration-003.test.ts test/migration-004.test.ts test/migration-005.test.ts test/db.test.ts`
Expected: PASS, 0 failed.

- [ ] **Step 6: Commit**

```bash
git add server/migrations/005_quick_carbs.sql server/test/migration-005.test.ts server/test/migration-004.test.ts
git commit -m "server: migration 005 rebuilds item tables for quick carbs rows"
```

### Task 5: Sync validation for quick rows

**Files:**
- Modify: `server/src/sync/tables.ts:1-9` (imports), `:125-132` (`REF_TYPES`), `:193-203` (meal_item), `:220-231` (log_item), `:256-267` (plan_item)
- Test: `server/test/sync-validate.test.ts:291-321` (two updated expectations) + new `describe`

- [ ] **Step 1: Update the two expectations that change by design, and write the failing tests**

In `server/test/sync-validate.test.ts`:
- in `'accepts a complete plan item'`, add `label: null,` after `position: 0,` in the expected `row`;
- in the `rejects plan_item %j` table, change `'ref_type must be one of food, meal'` to `'ref_type must be one of food, meal, quick'`.

Append at the end of the file:

```ts
describe('quick carbs rows (quick-carbs spec §2)', () => {
  const meta = { updated_at: 1000, updated_by: 'phone', deleted: 0 };
  const quickMeal = (fields: Record<string, unknown> = {}) => ({
    id: 'q1', meal_id: 'm1', ref_type: 'quick', ref_id: 'q1', amount: 7, unit: 'carbs', position: 1, label: 'Ranch & salad', ...meta, ...fields,
  });
  const quickLog = (fields: Record<string, unknown> = {}) => ({
    id: 'l1', log_entry_id: 'e1', ref_type: 'quick', ref_id: 'l1', display_name: 'Ranch & salad', amount: 7, unit: 'carbs', carbs_g: 7, ...meta, ...fields,
  });
  const quickPlan = (fields: Record<string, unknown> = {}) => planItem('p1', { id: 'qp', ref_type: 'quick', ref_id: 'qp', amount: 7, unit: 'carbs', label: null, ...fields });

  it('accepts quick rows in all three tables, trimming the label', () => {
    const meal = validateRecord(TABLE_SPECS.meal_item, quickMeal({ label: '  Ranch & salad  ' }));
    expect(meal).toEqual({ ok: true, row: expect.objectContaining({ ref_type: 'quick', unit: 'carbs', amount: 7, label: 'Ranch & salad' }) });
    expect(validateRecord(TABLE_SPECS.log_item, quickLog()).ok).toBe(true);
    expect(validateRecord(TABLE_SPECS.plan_item, quickPlan()).ok).toBe(true);
    expect(validateRecord(TABLE_SPECS.plan_item, quickPlan({ amount: 0 })).ok).toBe(true);
    expect(validateRecord(TABLE_SPECS.plan_item, quickPlan({ amount: 2000 })).ok).toBe(true);
  });

  it('never resolves ref_id for a quick row', () => {
    expect(validateRecord(TABLE_SPECS.meal_item, quickMeal({ ref_id: 'anything-at-all' })).ok).toBe(true);
  });

  it('treats a missing label as null', () => {
    const { label: _label, ...noLabel } = quickMeal();
    const result = validateRecord(TABLE_SPECS.meal_item, noLabel);
    expect(result.ok && result.row.label).toBeNull();
  });

  it.each([
    [quickMeal({ unit: 'g' }), 'quick carbs rows need unit "carbs"'],
    [quickMeal({ amount: 2001 }), 'quick carbs amount must be 0-2000 g'],
    [quickMeal({ amount: -1 }), 'amount must be >= 0'],
    [quickMeal({ amount: 'lots' }), 'amount must be a finite number'],
    [quickMeal({ label: 'x'.repeat(81) }), 'label is longer than 80 characters'],
    [quickMeal({ ref_type: 'food', unit: 'g' }), 'label is only allowed on quick carbs rows'],
    [quickMeal({ ref_type: 'snack' }), 'ref_type must be one of food, meal, quick'],
  ])('rejects meal_item %#', (record, message) => {
    expect(validateRecord(TABLE_SPECS.meal_item, record)).toEqual({ ok: false, message });
  });

  it.each([
    [quickLog({ carbs_g: 8 }), 'quick carbs rows need carbs_g equal to amount'],
    [quickLog({ unit: 'serving' }), 'quick carbs rows need unit "carbs"'],
    [quickLog({ amount: 2001, carbs_g: 2001 }), 'quick carbs amount must be 0-2000 g'],
  ])('rejects log_item %#', (record, message) => {
    expect(validateRecord(TABLE_SPECS.log_item, record)).toEqual({ ok: false, message });
  });

  it.each([
    [quickPlan({ unit: 'g' }), 'quick carbs rows need unit "carbs"'],
    [quickPlan({ amount: 2001 }), 'quick carbs amount must be 0-2000 g'],
    [planItem('p1', { label: 'Salsa' }), 'label is only allowed on quick carbs rows'],
  ])('rejects plan_item %#', (record, message) => {
    expect(validateRecord(TABLE_SPECS.plan_item, record)).toEqual({ ok: false, message });
  });

  it('still accepts food and meal rows with no label', () => {
    expect(validateRecord(TABLE_SPECS.meal_item, mealItem('m1', 'food', 'f1')).ok).toBe(true);
    expect(validateRecord(TABLE_SPECS.plan_item, planItem('p1', { label: null })).ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --dir server exec vitest run test/sync-validate.test.ts`
Expected: FAIL — `ref_type must be one of food, meal` returned for quick records, and `label` missing from the plan_item row.

- [ ] **Step 3: Write minimal implementation**

In `server/src/sync/tables.ts`, add `isValidQuickCarbs,` after `isValidCarbGoal,` and `QUICK_LABEL_MAX,` + `QUICK_UNIT,` after `parseHHMM,` in the `@carbbook/core` import. Replace

```ts
const REF_TYPES = ['food', 'meal'] as const;
```

with

```ts
const REF_TYPES = ['food', 'meal', 'quick'] as const;

/** meal_item.label / plan_item.label: optional, quick rows only (quick-carbs spec §2). */
const itemLabel: FieldSpec = { type: 'text', nullable: true, max: QUICK_LABEL_MAX, trim: true };

/**
 * Cross-field rules for item rows (quick-carbs spec §2). A quick row is grams of carbs with unit
 * "carbs" inside the dose limit; its ref_id is never resolved (it is the row's own id by
 * convention). `labels`: the table has a label column, which only quick rows may fill.
 * `snapshotCarbs`: log_item, whose carbs_g must equal the amount for a quick row.
 */
export function checkItemKind(
  r: Record<string, unknown>,
  options: { labels: boolean; snapshotCarbs: boolean },
): string | null {
  if (r.ref_type !== 'quick') {
    return options.labels && r.label != null ? 'label is only allowed on quick carbs rows' : null;
  }
  if (r.unit !== QUICK_UNIT) return `quick carbs rows need unit "${QUICK_UNIT}"`;
  if (!isValidQuickCarbs(r.amount as number)) return `quick carbs amount must be 0-${DOSE_LIMITS.maxCarbsG} g`;
  if (options.snapshotCarbs && r.carbs_g !== r.amount) return 'quick carbs rows need carbs_g equal to amount';
  return null;
}
```

In `TABLE_SPECS`:
- `meal_item`: add `label: itemLabel,` after `position: …,` inside `fields`, and after the closing `},` of `fields` add `check: (r) => checkItemKind(r, { labels: true, snapshotCarbs: false }),`
- `log_item`: after its `fields` block add `check: (r) => checkItemKind(r, { labels: false, snapshotCarbs: true }),`
- `plan_item`: add `label: itemLabel,` after `position: …,` and `check: (r) => checkItemKind(r, { labels: true, snapshotCarbs: false }),` after `fields`.

(`check` runs on the merged raw record after every field passed, so `r.amount` is already a finite number ≥ 0 and `r.label` is `undefined`/`null`/string.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --dir server exec vitest run test/sync-validate.test.ts && pnpm --dir server typecheck`
Expected: PASS, typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add server/src/sync/tables.ts server/test/sync-validate.test.ts
git commit -m "server: validate quick carbs rows and item labels"
```

### Task 6: Push/pull behaviour for quick rows

**Files:**
- Test: `server/test/sync-quick.test.ts` (create)
- Modify (only if a test fails): `server/src/sync/push.ts`

- [ ] **Step 1: Write the test**

Create `server/test/sync-quick.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { currentServerSeq } from '../src/db';
import { initDatabase } from '../src/init';
import { pullChanges } from '../src/sync/pull';
import { applyPush } from '../src/sync/push';
import { meal, mealItem, planEntry, planItem } from './sync-helpers';

const meta = (updated_at = 1000) => ({ updated_at, updated_by: 'phone', deleted: 0 });
const quickMealItem = (fields: Record<string, unknown> = {}) => ({
  id: 'q1', meal_id: 'm1', ref_type: 'quick', ref_id: 'q1', amount: 7, unit: 'carbs', position: 1, label: 'Salsa', ...meta(), ...fields,
});

describe('quick carbs through applyPush', () => {
  it('accepts quick rows in every item table as the owner and as a viewer', () => {
    const db = initDatabase(':memory:');
    const owner = applyPush(db, 'owner', [
      { table: 'meal', record: meal({ id: 'm1' }) },
      { table: 'meal_item', record: quickMealItem() },
      { table: 'log_item', record: { id: 'l1', log_entry_id: 'e1', ref_type: 'quick', ref_id: 'l1', display_name: 'Ranch & salad', amount: 7, unit: 'carbs', carbs_g: 7, ...meta() } },
      { table: 'plan_entry', record: planEntry({ id: 'p1' }) },
    ]);
    expect(owner.map((r) => r.status)).toEqual(['accepted', 'accepted', 'accepted', 'accepted']);
    const viewer = applyPush(db, 'viewer', [
      { table: 'plan_item', record: planItem('p1', { id: 'qp', ref_type: 'quick', ref_id: 'qp', amount: 7, unit: 'carbs', label: 'Ranch & salad' }) },
    ]);
    expect(viewer.map((r) => r.status)).toEqual(['accepted']);
  });

  it('rejects a bad quick row on its own without failing the rest of the batch', () => {
    const db = initDatabase(':memory:');
    const results = applyPush(db, 'owner', [
      { table: 'meal_item', record: quickMealItem({ id: 'bad', ref_id: 'bad', amount: 2001 }) },
      { table: 'meal_item', record: quickMealItem({ id: 'good', ref_id: 'good' }) },
    ]);
    expect(results).toEqual([
      { table: 'meal_item', id: 'bad', status: 'rejected', reason: 'invalid', message: 'quick carbs amount must be 0-2000 g' },
      expect.objectContaining({ id: 'good', status: 'accepted' }),
    ]);
    expect(db.prepare('SELECT id FROM meal_item').pluck().all()).toEqual(['good']);
  });

  it('keeps a stored label when an older client pushes the row without the label key', () => {
    const db = initDatabase(':memory:');
    applyPush(db, 'owner', [{ table: 'meal_item', record: quickMealItem() }]);
    const { label: _label, ...olderClient } = quickMealItem({ amount: 8, ...meta(2000) });
    expect(applyPush(db, 'owner', [{ table: 'meal_item', record: olderClient }])[0]!.status).toBe('accepted');
    expect(db.prepare('SELECT amount, label FROM meal_item WHERE id = ?').get('q1')).toEqual({ amount: 8, label: 'Salsa' });
  });

  it('clears a label only on an explicit null', () => {
    const db = initDatabase(':memory:');
    applyPush(db, 'owner', [{ table: 'meal_item', record: quickMealItem() }]);
    applyPush(db, 'owner', [{ table: 'meal_item', record: quickMealItem({ label: null, ...meta(2000) }) }]);
    expect(db.prepare('SELECT label FROM meal_item WHERE id = ?').pluck().get('q1')).toBeNull();
  });

  it('pulls quick rows with their label, and food rows with label null', () => {
    const db = initDatabase(':memory:');
    const since = currentServerSeq(db);
    applyPush(db, 'owner', [
      { table: 'meal_item', record: mealItem('m1', 'food', 'f1', { position: 0 }) },
      { table: 'meal_item', record: quickMealItem() },
    ]);
    const records = pullChanges(db, since, 50).changes.map((c) => c.record);
    expect(records[0]).toMatchObject({ ref_type: 'food', label: null });
    expect(records[1]).toMatchObject({ ref_type: 'quick', ref_id: 'q1', amount: 7, unit: 'carbs', label: 'Salsa' });
  });

  it('does not treat a quick row as a meal reference in the cycle check', () => {
    const db = initDatabase(':memory:');
    const results = applyPush(db, 'owner', [
      { table: 'meal', record: meal({ id: 'm1' }) },
      // ref_id equal to the meal's own id would be a cycle for a meal row; for a quick row it means nothing.
      { table: 'meal_item', record: quickMealItem({ ref_id: 'm1' }) },
    ]);
    expect(results.map((r) => r.status)).toEqual(['accepted', 'accepted']);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `pnpm --dir server exec vitest run test/sync-quick.test.ts`
Expected: PASS (6 tests). `applyPush` only runs `createsCycle` for `ref_type === 'meal'` and `upsert` writes every spec field by name, so no `push.ts` change should be needed. If any test fails, fix `push.ts` minimally and re-run; do not weaken the test.

- [ ] **Step 3: Run the whole server suite and typecheck**

Run: `pnpm --dir server test && pnpm --dir server typecheck`
Expected: all test files pass, 0 failed; typecheck exits 0.

- [ ] **Step 4: Commit**

```bash
git add server/test/sync-quick.test.ts
git commit -m "server: push/pull tests for quick carbs rows"
```

### Task 7: Rehearse migration 005 on a copy of the live database

No code change. Nothing is written to the Pi: `sqlite3 .backup` reads the live file into the container's `/tmp`, which is streamed out and deleted.

- [ ] **Step 1: Take a read-only snapshot of the live DB**

```bash
mkdir -p /tmp/carbbook-rehearsal
ssh pi 'docker exec carbs-server sqlite3 -readonly /data/carbbook.db ".backup /tmp/rehearsal.db" && docker exec carbs-server cat /tmp/rehearsal.db && docker exec carbs-server rm /tmp/rehearsal.db' > /tmp/carbbook-rehearsal/live.db
sqlite3 /tmp/carbbook-rehearsal/live.db 'PRAGMA user_version; PRAGMA integrity_check;'
```

Expected: `4` then `ok`.

- [ ] **Step 2: Migrate the copy with the branch's code**

```bash
cd server && node --import tsx --input-type=module -e "
const { openDb, migrate } = await import('./src/db.ts');
const db = openDb('/tmp/carbbook-rehearsal/live.db');
const tables = ['meal_item', 'log_item', 'plan_item'];
const dump = () => tables.map((t) => db.prepare('SELECT * FROM ' + t + ' ORDER BY id').all());
const before = JSON.stringify(dump());
const counts = dump().map((r) => r.length);
const t0 = Date.now();
console.log('version', migrate(db), 'in', Date.now() - t0, 'ms; rows', counts.join('/'));
const after = JSON.stringify(dump().map((rows) => rows.map(({ label, ...rest }) => rest)));
console.log('rows identical:', before === after, '| integrity:', db.pragma('integrity_check', { simple: true }));
"
```

Expected: `version 5 in <N> ms; rows <meal_items>/<log_items>/<plan_items>` and `rows identical: true | integrity: ok`. Record the three counts — Task 23 compares the live DB against them. Any other output: stop and investigate before continuing.

- [ ] **Step 3: Clean up**

Run: `rm -rf /tmp/carbbook-rehearsal`
(Nothing to commit.)

---

# Part C — Web

Web conventions used below: quick rows are `DraftItem`s with `ref_type: 'quick'`, `unit: 'carbs'`, `amount` = the grams text and `label` = the label text. The N-th quick row in an editor is named "carbs row N" in its accessible labels (`Label for carbs row 1`, `Grams of carbs for carbs row 1`, `Carbs in carbs row 1`, `Remove carbs row 1`), so the names stay stable while the user types a label.

### Task 8: Draft-row helpers for quick rows

**Files:**
- Modify: `web/src/ui/ItemEditor.tsx:1-50` (helpers; the component body is replaced in Task 9)
- Modify: `web/src/ui/format.ts:3-15` (`UNIT_NAMES`)
- Test: `web/test/quick-items.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `web/test/quick-items.test.ts`:

```ts
import { createCatalog } from '@carbbook/core';
import { describe, expect, it } from 'vitest';
import { unitLabel } from '../src/ui/format';
import {
  type DraftItem,
  draftAmount,
  draftItemCarbs,
  draftLabel,
  itemLabel,
  newDraftItem,
  newQuickItem,
  quickRowText,
  unitsFor,
} from '../src/ui/ItemEditor';

const catalog = createCatalog({ foods: [{ id: 'taquitos', name: 'Taquitos', carbs_per_100g: 20 }] });
const quick = (amount: string, label = ''): DraftItem => ({ ...newQuickItem('k1'), amount, label });

describe('quick carbs draft rows', () => {
  it('start empty with the carbs unit and their own key as ref_id', () => {
    expect(newQuickItem('k1')).toEqual({ key: 'k1', ref_type: 'quick', ref_id: 'k1', amount: '', unit: 'carbs', label: '' });
    expect(newDraftItem(catalog, 'quick', 'ignored', 'k2')).toEqual(newQuickItem('k2'));
    expect(unitsFor(catalog, 'quick', 'k1')).toEqual(['carbs']);
  });

  it('parse grams of carbs as a plain decimal within the dose limit (fail closed)', () => {
    expect(draftAmount(quick('7'))).toBe(7);
    expect(draftAmount(quick(' 7,5 '))).toBe(7.5);
    expect(draftAmount(quick('2000'))).toBe(2000);
    for (const bad of ['', ' ', '1/2', '½', '-1', '2001', '1e3', 'abc']) expect(draftAmount(quick(bad)), bad).toBeNull();
    // Food rows keep the fraction parser.
    expect(draftAmount({ key: 'f', ref_type: 'food', ref_id: 'taquitos', amount: '1/2', unit: 'g' })).toBe(0.5);
  });

  it('count a valid quick row as complete carbs and an invalid one as incomplete', () => {
    expect(draftItemCarbs(catalog, quick('7'))).toEqual({ carbs_g: 7, complete: true });
    expect(draftItemCarbs(catalog, quick('2001'))).toEqual({ carbs_g: 0, complete: false });
    expect(draftItemCarbs(catalog, quick(''))).toEqual({ carbs_g: 0, complete: false });
  });

  it('name quick rows by their label, or "Extra carbs" when blank', () => {
    expect(itemLabel(catalog, { ref_type: 'quick', ref_id: 'x', label: '  Ranch & salad ' })).toBe('Ranch & salad');
    expect(itemLabel(catalog, { ref_type: 'quick', ref_id: 'x', label: null })).toBe('Extra carbs');
    expect(itemLabel(catalog, { ref_type: 'quick', ref_id: 'x' })).toBe('Extra carbs');
    expect(itemLabel(catalog, { ref_type: 'food', ref_id: 'taquitos' })).toBe('Taquitos');
    expect(itemLabel(catalog, { ref_type: 'food', ref_id: 'gone' })).toBe('(missing item)');
  });

  it('store a trimmed label for quick rows and null for everything else', () => {
    expect(draftLabel(quick('7', '  Salsa '))).toBe('Salsa');
    expect(draftLabel(quick('7', '   '))).toBeNull();
    expect(draftLabel({ key: 'f', ref_type: 'food', ref_id: 'taquitos', amount: '1', unit: 'g', label: 'stray' })).toBeNull();
  });

  it('describe a quick row as "label — N g carbs"', () => {
    expect(quickRowText('Ranch & salad', '7')).toBe('Ranch & salad — 7 g carbs');
    expect(quickRowText('', '7.25')).toBe('Extra carbs — 7.3 g carbs');
    expect(quickRowText(undefined, 'x')).toBe('Extra carbs — enter grams of carbs');
    expect(quickRowText('Big', '2001')).toBe('Big — enter grams of carbs');
  });

  it('shows the carbs unit as "g carbs"', () => {
    expect(unitLabel('carbs', [])).toBe('g carbs');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --dir web exec vitest run test/quick-items.test.ts`
Expected: FAIL — `draftAmount`/`draftLabel`/`itemLabel`/`newQuickItem`/`quickRowText` are not exported.

- [ ] **Step 3: Write minimal implementation**

In `web/src/ui/format.ts` add `carbs: 'g carbs',` after `serving: 'servings',` in `UNIT_NAMES`.

In `web/src/ui/ItemEditor.tsx` replace everything **above** `export function ItemEditor(` with:

```tsx
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
```

(`QUICK_LABEL_INPUT_MAX` is used by the component in Task 9; keeping it here avoids a second import list.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --dir web exec vitest run test/quick-items.test.ts test/components.test.tsx test/calculator.test.tsx`
Expected: PASS, 0 failed.

- [ ] **Step 5: Commit**

```bash
git add web/src/ui/ItemEditor.tsx web/src/ui/format.ts web/test/quick-items.test.ts
git commit -m "web: draft helpers for quick carbs rows"
```

### Task 9: Quick rows in `ItemEditor` and the "+ Carbs" button

**Files:**
- Modify: `web/src/ui/ItemEditor.tsx` (`ItemEditor` component, below the helpers from Task 8)
- Modify: `web/src/ui/SearchPanel.tsx:16-36`
- Test: `web/test/quick-items.test.ts` (append a component test)

- [ ] **Step 1: Write the failing test**

Append to `web/test/quick-items.test.ts` (add these imports at the top: `import { render, screen } from '@testing-library/react';`, `import userEvent from '@testing-library/user-event';`, `import { useState } from 'react';`, and add `ItemEditor` to the `../src/ui/ItemEditor` import):

```tsx
function Harness(props: { initial: DraftItem[] }) {
  const [items, setItems] = useState(props.initial);
  return (
    <>
      <ItemEditor items={items} catalog={catalog} onChange={setItems} reorderable />
      <output data-testid="state">{JSON.stringify(items)}</output>
    </>
  );
}

describe('ItemEditor quick rows', () => {
  it('edits the label and grams, shows "label — N g carbs", and removes the row', async () => {
    const user = userEvent.setup();
    render(<Harness initial={[{ key: 'f1', ref_type: 'food', ref_id: 'taquitos', amount: '100', unit: 'g' }, newQuickItem('q1')]} />);

    expect(screen.getByText('Extra carbs — enter grams of carbs')).toBeInTheDocument();
    expect(screen.getByLabelText('Carbs in carbs row 1')).toHaveTextContent('—');
    expect(screen.queryByLabelText('Unit for carbs row 1')).not.toBeInTheDocument();

    await user.type(screen.getByLabelText('Label for carbs row 1'), 'Ranch & salad');
    await user.type(screen.getByLabelText('Grams of carbs for carbs row 1'), '7');
    expect(screen.getByText('Ranch & salad — 7 g carbs')).toBeInTheDocument();
    expect(screen.getByLabelText('Carbs in carbs row 1')).toHaveTextContent('7 g');
    expect(screen.getByLabelText('Label for carbs row 1')).toHaveAttribute('maxlength', '80');

    await user.click(screen.getByRole('button', { name: 'Move carbs row 1 up' }));
    expect(JSON.parse(screen.getByTestId('state').textContent!).map((i: DraftItem) => i.key)).toEqual(['q1', 'f1']);

    await user.click(screen.getByRole('button', { name: 'Remove carbs row 1' }));
    expect(JSON.parse(screen.getByTestId('state').textContent!).map((i: DraftItem) => i.key)).toEqual(['f1']);
  });

  it('numbers several quick rows in order', () => {
    render(<Harness initial={[newQuickItem('a'), { ...newQuickItem('b'), label: 'Salsa', amount: '6' }]} />);
    expect(screen.getByLabelText('Label for carbs row 2')).toHaveValue('Salsa');
    expect(screen.getByLabelText('Grams of carbs for carbs row 2')).toHaveValue('6');
  });
});
```

Rename the file to `web/test/quick-items.test.tsx` (it now contains JSX): `git mv web/test/quick-items.test.ts web/test/quick-items.test.tsx`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --dir web exec vitest run test/quick-items.test.tsx`
Expected: FAIL — `Unable to find a label with the text of: Label for carbs row 1` (quick rows still render as food rows).

- [ ] **Step 3: Write minimal implementation**

Replace the whole `export function ItemEditor(...) { ... }` in `web/src/ui/ItemEditor.tsx` with:

```tsx
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
  const rowButtons = (item: DraftItem, index: number, name: string) => (
    <>
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
    </>
  );

  let quickCount = 0;
  return (
    <ul className="items" aria-label="Items">
      {items.map((item, index) => {
        const result = draftItemCarbs(catalog, item);
        if (item.ref_type === 'quick') {
          quickCount += 1;
          const name = `carbs row ${quickCount}`;
          return (
            <li key={item.key} className="item-row quick-row" data-testid="item-row">
              <div className="item-name">{quickRowText(item.label, item.amount)}</div>
              <div className="item-controls">
                <input
                  aria-label={`Label for ${name}`}
                  placeholder="Label (optional)"
                  maxLength={QUICK_LABEL_INPUT_MAX}
                  value={item.label ?? ''}
                  onChange={(e) => update(item.key, { label: e.target.value })}
                />
                <input
                  aria-label={`Grams of carbs for ${name}`}
                  inputMode="decimal"
                  placeholder="g carbs"
                  value={item.amount}
                  onChange={(e) => update(item.key, { amount: e.target.value })}
                />
                <span className="item-carbs" aria-label={`Carbs in ${name}`}>
                  {result.complete ? formatCarbs(result.carbs_g) : '—'}
                </span>
                {rowButtons(item, index, name)}
              </div>
            </li>
          );
        }
        const name = itemName(catalog, item.ref_type, item.ref_id);
        const amountMissing = draftAmount(item) === null;
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
              {rowButtons(item, index, name)}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
```

In `web/src/ui/SearchPanel.tsx` change the props type to

```tsx
export function SearchPanel(props: {
  onPick: (result: SearchResult) => void;
  onScan?: () => void;
  /** "+ Carbs": add a carbs-only row (quick-carbs spec §2). */
  onAddCarbs?: () => void;
  label?: string;
}) {
```

and inside `<div className="search-bar">`, after the `props.onScan` button block, add:

```tsx
        {props.onAddCarbs && (
          <button type="button" onClick={props.onAddCarbs}>
            + Carbs
          </button>
        )}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --dir web exec vitest run test/quick-items.test.tsx test/meals.test.tsx test/plan.test.tsx test/calculator.test.tsx`
Expected: PASS, 0 failed (existing food-row labels are unchanged).

- [ ] **Step 5: Commit**

```bash
git add web/src/ui/ItemEditor.tsx web/src/ui/SearchPanel.tsx web/test/quick-items.test.tsx
git commit -m "web: quick carbs rows in the item editor and a + Carbs button"
```

### Task 10: Calculator — add, total, dose and log quick rows

**Files:**
- Modify: `web/src/screens/Calculator.tsx:1` (core import), `:22` (ItemEditor import), `:66` (`badAmounts`), `:87-89` (new `addQuick`), `:115-130` (`loadSuggestion`), `:175-195` (`logIt` items), `:223` (`SearchPanel`)
- Test: `web/test/calculator.test.tsx` (append), `web/test/plan-calculator.test.tsx` (append)

- [ ] **Step 1: Write the failing tests**

Append to `web/test/calculator.test.tsx`:

```tsx
describe('quick carbs rows', () => {
  it('adds a labelled quick row, counts it in the total and dose, and logs it as a snapshot', async () => {
    const user = await setup();
    renderWith(<Calculator />, services);
    await addItem(user, 'tort', /Tortilla/); // 100 g → 48 g
    await user.click(screen.getByRole('button', { name: '+ Carbs' }));
    await user.type(screen.getByLabelText('Label for carbs row 1'), 'Ranch & salad');
    await user.type(screen.getByLabelText('Grams of carbs for carbs row 1'), '7,5');
    expect(screen.getByText('Ranch & salad — 7.5 g carbs')).toBeInTheDocument();
    expect(screen.getByTestId('total-carbs')).toHaveTextContent('55.5 g');
    expect(screen.getByTestId('dose-breakdown')).toHaveTextContent('55.5g ÷ 8');

    await user.click(screen.getByRole('button', { name: 'Log it' }));
    await screen.findByText(/Logged 55.5 g carbs/);
    const [entry] = await services.db.log_entry.toArray();
    expect(entry!.total_carbs_g).toBe(55.5);
    const quick = (await services.db.log_item.toArray()).find((i) => i.ref_type === 'quick')!;
    expect(quick).toMatchObject({ log_entry_id: entry!.id, display_name: 'Ranch & salad', amount: 7.5, unit: 'carbs', carbs_g: 7.5 });
    expect(quick.ref_id).toBe(quick.id);
  });

  it('logs a blank label as "Extra carbs"', async () => {
    const user = await setup();
    renderWith(<Calculator />, services);
    await user.click(await screen.findByRole('button', { name: '+ Carbs' }));
    await user.type(screen.getByLabelText('Grams of carbs for carbs row 1'), '12');
    await user.click(screen.getByRole('button', { name: 'Log it' }));
    await screen.findByText(/Logged 12 g carbs/);
    expect((await services.db.log_item.toArray())[0]).toMatchObject({ display_name: 'Extra carbs', carbs_g: 12 });
  });

  it.each(['', '1/2', '2001', '-3'])('refuses a dose and blocks logging for quick grams %j (fail closed)', async (text) => {
    const user = await setup();
    renderWith(<Calculator />, services);
    await addItem(user, 'tort', /Tortilla/);
    await user.click(screen.getByRole('button', { name: '+ Carbs' }));
    if (text) await user.type(screen.getByLabelText('Grams of carbs for carbs row 1'), text);
    expect(await screen.findByTestId('dose-refusal')).toHaveTextContent(REFUSAL_MESSAGES.incomplete_carbs);
    expect(screen.queryByTestId('dose-units')).not.toBeInTheDocument();
    expect(screen.getByTestId('total-carbs')).toHaveTextContent('(incomplete)');
    await user.click(screen.getByRole('button', { name: 'Log it' }));
    expect(await screen.findByText('Enter an amount for every item before logging.')).toBeInTheDocument();
    expect(await services.db.log_entry.count()).toBe(0);
  });

  it('saves quick rows into a new meal with their label', async () => {
    const user = await setup();
    renderWith(<Calculator />, services);
    await addItem(user, 'tort', /Tortilla/);
    await user.click(screen.getByRole('button', { name: '+ Carbs' }));
    await user.type(screen.getByLabelText('Label for carbs row 1'), ' Salsa ');
    await user.type(screen.getByLabelText('Grams of carbs for carbs row 1'), '6');
    await user.click(screen.getByRole('button', { name: 'Save as meal' }));
    await user.type(screen.getByLabelText('Meal name'), 'Taco plate');
    await user.click(screen.getByRole('button', { name: 'Save meal' }));
    await screen.findByText('Saved meal "Taco plate".');
    const quick = (await services.db.meal_item.toArray()).find((i) => i.ref_type === 'quick')!;
    expect(quick).toMatchObject({ amount: 6, unit: 'carbs', label: 'Salsa', position: 1 });
    expect(quick.ref_id).toBe(quick.id);
  });
});
```

Append to `web/test/plan-calculator.test.tsx` (add `import type { PlanItemData } from '@carbbook/core';` at the top):

```tsx
describe('loading a slot with a quick carbs row', () => {
  it('brings the label and grams along, and logging snapshots them', async () => {
    const user = await setup();
    await services.db.plan_item.put(
      synced<PlanItemData>({ id: 'i2', plan_entry_id: 'p1', ref_type: 'quick', ref_id: 'i2', amount: 7, unit: 'carbs', position: 1, label: 'Ranch & salad' }),
    );
    renderWith(<Calculator />, services);
    expect(await screen.findByTestId('plan-suggestion')).toHaveTextContent('Planned: Tortilla, Ranch & salad · 79 g');
    await user.click(screen.getByRole('button', { name: 'Load' }));
    expect(screen.getByLabelText('Label for carbs row 1')).toHaveValue('Ranch & salad');
    expect(screen.getByLabelText('Grams of carbs for carbs row 1')).toHaveValue('7');
    expect(screen.getByTestId('total-carbs')).toHaveTextContent('79 g');

    await user.click(screen.getByRole('button', { name: 'Log it' }));
    await screen.findByText(/Logged 79 g carbs/);
    const quick = (await services.db.log_item.toArray()).find((i) => i.ref_type === 'quick')!;
    expect(quick).toMatchObject({ display_name: 'Ranch & salad', amount: 7, unit: 'carbs', carbs_g: 7 });
    expect(quick.id).not.toBe('i2');
    expect(quick.ref_id).toBe(quick.id);
    expect((await services.db.plan_entry.get('p1'))!.status).toBe('logged');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --dir web exec vitest run test/calculator.test.tsx test/plan-calculator.test.tsx`
Expected: FAIL — `Unable to find role="button" and name "+ Carbs"`; the plan-calculator test fails on `Planned: Tortilla, (missing item)` / missing label input.

- [ ] **Step 3: Write minimal implementation**

In `web/src/screens/Calculator.tsx`:

1. Line 1 → `import { activeSettings, itemRefId, type PlanEntryData, type Synced, sumCarbs } from '@carbbook/core';`
2. The ItemEditor import → `import { type DraftItem, draftAmount, draftItemCarbs, ItemEditor, itemLabel, newDraftItem, newQuickItem } from '../ui/ItemEditor';`
3. `const badAmounts = items.some((item) => parseAmount(item.amount) === null);` → `const badAmounts = items.some((item) => draftAmount(item) === null);`
4. Below `function addFood(...) { ... }` add:

```tsx
  /** "+ Carbs": a carbs-only row (quick-carbs spec §2). */
  function addQuick() {
    setItems((current) => [...current, newQuickItem(uuidv7(now()))]);
  }
```

5. In `loadSuggestion`, the mapped object becomes:

```tsx
      ...suggestion.items.map((item) => ({
        key: uuidv7(now()),
        ref_type: item.ref_type,
        ref_id: item.ref_id,
        amount: String(item.amount),
        unit: item.unit,
        label: item.label ?? '',
      })),
```

6. In `logIt`, replace the `...items.map((item, index): Change => ({ ... })),` block with:

```tsx
      ...items.map((item, index): Change => {
        const id = uuidv7(now());
        return {
          table: 'log_item',
          data: {
            id,
            log_entry_id: entryId,
            ref_type: item.ref_type,
            // A quick row points at itself; its label is the logged display name (quick-carbs spec §2).
            ref_id: itemRefId(item.ref_type, item.ref_id, id),
            display_name: itemLabel(catalog, item),
            amount: draftAmount(item)!,
            unit: item.unit,
            carbs_g: results[index]!.carbs_g,
          },
        };
      }),
```

7. `<SearchPanel onPick={(result) => void pick(result)} onScan={() => setScanning(true)} />` → `<SearchPanel onPick={(result) => void pick(result)} onScan={() => setScanning(true)} onAddCarbs={addQuick} />`

`parseAmount` stays imported (yield in `saveAsMeal`); `itemName` is no longer used here — it was removed from the import in item 2. `saveAsMeal` needs no change: it passes the draft rows to `saveMeal`, which Task 11 teaches about quick rows (until then the meal test in this task fails only on `label`/`ref_id` — run it again after Task 11).

- [ ] **Step 4: Run tests**

Run: `pnpm --dir web exec vitest run test/calculator.test.tsx test/plan-calculator.test.tsx`
Expected: all PASS except `quick carbs rows > saves quick rows into a new meal with their label` (fixed by Task 11: `label` is `undefined` and `ref_id` is the draft key). Every other test PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/screens/Calculator.tsx web/test/calculator.test.tsx web/test/plan-calculator.test.tsx
git commit -m "web: + Carbs rows in the Calculator, logged as snapshots"
```

### Task 11: Meals — quick components

**Files:**
- Modify: `web/src/meals/saveMeal.ts` (whole file below)
- Modify: `web/src/meals/MealEditor.tsx:1-10` (imports), `:24-29` (initial items), `:61` (save check), `:108` (`SearchPanel`)
- Test: `web/test/meals.test.tsx` (append)

- [ ] **Step 1: Write the failing tests**

Append to `web/test/meals.test.tsx`:

```tsx
describe('quick carbs components', () => {
  it('adds a labelled quick component and counts it per serving', async () => {
    const user = await setup();
    renderWith(<Meals />, services);
    await user.click(await screen.findByRole('button', { name: 'New meal' }));
    await user.type(screen.getByLabelText('Name'), 'Taco night');
    await user.type(screen.getByLabelText('Add a component'), 'tort');
    await user.click(await screen.findByRole('button', { name: /Tortilla/ }));
    await user.click(screen.getByRole('button', { name: '+ Carbs' }));
    await user.type(screen.getByLabelText('Label for carbs row 1'), 'Salsa');
    await user.type(screen.getByLabelText('Grams of carbs for carbs row 1'), '6');
    expect(screen.getByTestId('meal-carbs')).toHaveTextContent('54 g carbs per serving');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await screen.findByRole('button', { name: /Taco night/ });
    const quick = (await services.db.meal_item.toArray()).find((i) => i.ref_type === 'quick')!;
    expect(quick).toMatchObject({ amount: 6, unit: 'carbs', label: 'Salsa', position: 1 });
    expect(quick.ref_id).toBe(quick.id);
    const food = (await services.db.meal_item.toArray()).find((i) => i.ref_type === 'food')!;
    expect(food.label).toBeNull();
  });

  it('refuses to save a meal whose quick component has no valid grams', async () => {
    const user = await setup();
    renderWith(<Meals />, services);
    await user.click(await screen.findByRole('button', { name: 'New meal' }));
    await user.type(screen.getByLabelText('Name'), 'Mystery');
    await user.click(screen.getByRole('button', { name: '+ Carbs' }));
    await user.type(screen.getByLabelText('Grams of carbs for carbs row 1'), '2001');
    expect(screen.getByTestId('meal-carbs')).toHaveTextContent('Incomplete carb data');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Every component needs an amount.');
    expect(await services.db.meal.count()).toBe(0);
  });

  it('edits an existing quick component', async () => {
    const user = await setup();
    await services.db.meal.put(synced(mealData({ id: 'salsa-plate', name: 'Salsa plate' })));
    await services.db.meal_item.bulkPut([
      synced(mealItemData({ id: 'i-tortilla', meal_id: 'salsa-plate', ref_id: 'tortilla', position: 0 })),
      synced(mealItemData({ id: 'i-salsa', meal_id: 'salsa-plate', ref_type: 'quick', ref_id: 'i-salsa', amount: 6, unit: 'carbs', label: 'Salsa', position: 1 })),
    ]);
    renderWith(<Meals />, services);
    await user.click(await screen.findByRole('button', { name: /Salsa plate/ }));
    expect(screen.getByLabelText('Label for carbs row 1')).toHaveValue('Salsa');
    const grams = screen.getByLabelText('Grams of carbs for carbs row 1');
    await user.clear(grams);
    await user.type(grams, '8');
    expect(screen.getByTestId('meal-carbs')).toHaveTextContent('56 g carbs per serving');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(async () => expect((await services.db.meal_item.get('i-salsa'))?.amount).toBe(8));
    expect(await services.db.meal_item.get('i-salsa')).toMatchObject({ label: 'Salsa', ref_id: 'i-salsa', unit: 'carbs' });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --dir web exec vitest run test/meals.test.tsx`
Expected: FAIL — no `+ Carbs` button in the meal editor; the edit test finds no `Label for carbs row 1` (label not loaded).

- [ ] **Step 3: Write minimal implementation**

Replace `web/src/meals/saveMeal.ts` with:

```ts
import { itemRefId, type MealData, type MealItemData } from '@carbbook/core';
import type { CatalogData } from '../db/catalog';
import type { Change, Store } from '../db/store';
import { draftAmount, type DraftItem, draftLabel } from '../ui/ItemEditor';
import { saveUsdaFoodsFor } from '../usda/materialize';

/**
 * Saves a meal and its components (item key = meal_item id, order = position). Every amount must
 * already be valid (`draftAmount` non-null) — the editors block saving otherwise.
 */
export async function saveMeal(store: Store, meal: MealData, items: DraftItem[], removedItemIds: string[] = []): Promise<void> {
  await saveUsdaFoodsFor(store, items);
  const changes: Change[] = [
    { table: 'meal', data: meal },
    ...items.map(
      (item, position): Change => ({
        table: 'meal_item',
        data: {
          id: item.key,
          meal_id: meal.id,
          ref_type: item.ref_type,
          ref_id: itemRefId(item.ref_type, item.ref_id, item.key),
          amount: draftAmount(item)!,
          unit: item.unit,
          position,
          label: draftLabel(item),
        },
      }),
    ),
  ];
  await store.saveMany(changes);
  for (const id of removedItemIds) await store.remove('meal_item', id);
}

/** Catalog data with an unsaved meal draft in place of the stored meal, for live carbs and cycle checks. */
export function withDraftMeal(data: CatalogData, meal: MealData, items: DraftItem[]): CatalogData {
  const meta = { updated_at: 0, updated_by: 'draft', deleted: 0 as const };
  const draftItems = items.map(
    (item, position): MealItemData & typeof meta => ({
      id: item.key,
      meal_id: meal.id,
      ref_type: item.ref_type,
      ref_id: itemRefId(item.ref_type, item.ref_id, item.key),
      amount: draftAmount(item) ?? Number.NaN,
      unit: item.unit,
      position,
      label: draftLabel(item),
      ...meta,
    }),
  );
  return {
    ...data,
    meals: [...data.meals.filter((m) => m.id !== meal.id), { ...meal, ...meta }],
    meal_items: [...data.meal_items.filter((i) => i.meal_id !== meal.id), ...draftItems],
  };
}
```

In `web/src/meals/MealEditor.tsx`:
1. ItemEditor import → `import { type DraftItem, draftAmount, ItemEditor, newDraftItem, newQuickItem } from '../ui/ItemEditor';`
2. The initial-items `.map(...)` → `.map((i) => ({ key: i.id, ref_type: i.ref_type, ref_id: i.ref_id, amount: String(i.amount), unit: i.unit, label: i.label ?? '' })),`
3. `if (items.some((i) => parseAmount(i.amount) === null)) problems.push('Every component needs an amount.');` → `if (items.some((i) => draftAmount(i) === null)) problems.push('Every component needs an amount.');`
4. `<SearchPanel label="Add a component" onPick={(result) => void pick(result)} />` →

```tsx
      <SearchPanel
        label="Add a component"
        onPick={(result) => void pick(result)}
        onAddCarbs={() => setItems((current) => [...current, newQuickItem(uuidv7(now()))])}
      />
```

(`parseAmount` stays imported for the yield field.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --dir web exec vitest run test/meals.test.tsx test/calculator.test.tsx`
Expected: PASS, 0 failed (including `saves quick rows into a new meal with their label` from Task 10).

- [ ] **Step 5: Commit**

```bash
git add web/src/meals/saveMeal.ts web/src/meals/MealEditor.tsx web/test/meals.test.tsx
git commit -m "web: quick carbs components in meals"
```

### Task 12: Plans — slot editor, save, copy, suggestion and cell names

**Files:**
- Modify: `web/src/plan/saveSlot.ts:1-40`
- Modify: `web/src/plan/SlotEditor.tsx:1-12` (imports), `:32-34` (initial items), `:53` (save check), `:87` (`SearchPanel`)
- Modify: `web/src/plan/copy.ts:1-3` (imports), `:66-80` and `:94-108` (item writes)
- Modify: `web/src/plan/suggestion.ts:1-3, 40`
- Modify: `web/src/screens/Plan.tsx:13, 223` (`itemLabel`)
- Test: `web/test/plan.test.tsx`, `web/test/plan-copy.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

In `web/test/plan.test.tsx` add `import type { PlanItemData } from '@carbbook/core';` at the top, then add inside `describe('SlotEditor', …)`:

```tsx
  it('adds a quick carbs row and saves it with its label', async () => {
    const { user, data } = await setup();
    renderWith(<SlotEditor date="2026-09-16" windowName="Dinner" slot={null} data={data} onDone={() => {}} />, services);
    await user.type(screen.getByLabelText('Add to this slot'), 'tort');
    await user.click(await screen.findByRole('button', { name: /Tortilla/ }));
    await user.click(screen.getByRole('button', { name: '+ Carbs' }));
    await user.type(screen.getByLabelText('Label for carbs row 1'), 'Ranch & salad');
    await user.type(screen.getByLabelText('Grams of carbs for carbs row 1'), '7');
    expect(screen.getByTestId('slot-carbs')).toHaveTextContent('55 g');
    await user.click(screen.getByRole('button', { name: 'Save slot' }));

    const items = (await services.db.plan_item.toArray()).sort((a, b) => a.position - b.position);
    expect(items.map((i) => [i.ref_type, i.amount, i.unit, i.label])).toEqual([
      ['food', 100, 'g', null],
      ['quick', 7, 'carbs', 'Ranch & salad'],
    ]);
    expect(items[1]!.ref_id).toBe(items[1]!.id);
  });

  it('refuses to save a slot whose quick row has no valid grams', async () => {
    const { user, data } = await setup();
    renderWith(<SlotEditor date="2026-09-16" windowName="Dinner" slot={null} data={data} onDone={() => {}} />, services);
    await user.click(screen.getByRole('button', { name: '+ Carbs' }));
    await user.type(screen.getByLabelText('Grams of carbs for carbs row 1'), '1/2');
    await user.click(screen.getByRole('button', { name: 'Save slot' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Every item needs an amount.');
    expect(await services.db.plan_entry.count()).toBe(0);
  });
```

and inside `describe('Plan cells', …)`:

```tsx
  it('names a quick carbs row by its label and counts it in the slot', async () => {
    await setup();
    await seedLunch(); // 72 g
    await services.db.plan_item.put(
      sync<PlanItemData>({ id: 'q-2026-09-16', plan_entry_id: 'p-2026-09-16', ref_type: 'quick', ref_id: 'q-2026-09-16', amount: 7, unit: 'carbs', position: 1, label: 'Ranch & salad' }),
    );
    renderWith(<Plan />, services);
    const cell = await screen.findByTestId('plan-cell-2026-09-16-Lunch');
    expect(cell).toHaveTextContent('Tortilla, Ranch & salad');
    expect(cell).toHaveTextContent('79 g · goal 50–80');
  });
```

Append to `web/test/plan-copy.test.ts` (inside `describe('copyChanges', …)`):

```ts
  it('copies a quick carbs row with its label and re-points ref_id at the new row', () => {
    counter = 0;
    const quick = synced<PlanItemData>({ id: 'q1', plan_entry_id: 'src', ref_type: 'quick', ref_id: 'q1', amount: 7, unit: 'carbs', position: 2, label: 'Ranch & salad' });
    const result = copyChanges({
      pairs: [{ from: '2026-09-16', to: '2026-09-17' }],
      entries: source,
      items: [...sourceItems, quick],
      mode: 'skip',
      newId,
    });
    const items = result.changes.filter((c) => c.table === 'plan_item').map((c) => c.data as PlanItemData);
    expect(items.find((i) => i.ref_type === 'quick')).toEqual({
      id: 'new-4', plan_entry_id: 'new-1', ref_type: 'quick', ref_id: 'new-4', amount: 7, unit: 'carbs', position: 2, label: 'Ranch & salad',
    });
    expect(items.filter((i) => i.ref_type === 'food').map((i) => [i.ref_id, i.label])).toEqual([
      ['tortilla', null],
      ['tortilla', null],
    ]);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --dir web exec vitest run test/plan.test.tsx test/plan-copy.test.ts`
Expected: FAIL — no `+ Carbs` in the slot editor; the cell shows `(missing item)`; the copied quick row has `ref_id: 'q1'` and no `label`.

- [ ] **Step 3: Write minimal implementation**

`web/src/plan/saveSlot.ts` — replace the imports and the item mapping:

```ts
import { itemRefId, type PlanEntryData } from '@carbbook/core';
import type { Change, Store } from '../db/store';
import { draftAmount, type DraftItem, draftLabel } from '../ui/ItemEditor';
import { saveUsdaFoodsFor } from '../usda/materialize';
```

and in `saveSlot` the `data` object becomes:

```ts
        data: {
          id: item.key,
          plan_entry_id: entry.id,
          ref_type: item.ref_type,
          ref_id: itemRefId(item.ref_type, item.ref_id, item.key),
          amount: draftAmount(item)!,
          unit: item.unit,
          position,
          label: draftLabel(item),
        },
```

Update its doc comment's "Every amount must already parse with `parseAmount`" to "Every amount must already be valid (`draftAmount` non-null)".

`web/src/plan/SlotEditor.tsx`:
1. `import { formatDayLabel, parseAmount } from '../ui/format';` → `import { formatDayLabel } from '../ui/format';`
2. ItemEditor import → `import { type DraftItem, draftAmount, draftItemCarbs, ItemEditor, newDraftItem, newQuickItem } from '../ui/ItemEditor';`
3. Initial items map → `(slot?.items ?? []).map((i) => ({ key: i.id, ref_type: i.ref_type, ref_id: i.ref_id, amount: String(i.amount), unit: i.unit, label: i.label ?? '' })),`
4. `if (items.some((i) => parseAmount(i.amount) === null)) problems.push('Every item needs an amount.');` → `if (items.some((i) => draftAmount(i) === null)) problems.push('Every item needs an amount.');`
5. `<SearchPanel label="Add to this slot" onPick={(result) => void pick(result)} />` →

```tsx
      <SearchPanel
        label="Add to this slot"
        onPick={(result) => void pick(result)}
        onAddCarbs={() => setItems((current) => [...current, newQuickItem(uuidv7(now()))])}
      />
```

`web/src/plan/copy.ts`: add `import { itemRefId } from '@carbbook/core';` (merge into the existing type import: `import { itemRefId, type PlanEntryData, type PlanItemData, type Synced } from '@carbbook/core';`). In the merge branch replace the `changes.push({ table: 'plan_item', data: { id: newId(), … } })` with:

```ts
        sourceItems.forEach((item, offset) => {
          const id = newId();
          changes.push({
            table: 'plan_item',
            data: {
              id,
              plan_entry_id: existing.id,
              ref_type: item.ref_type,
              ref_id: itemRefId(item.ref_type, item.ref_id, id),
              amount: item.amount,
              unit: item.unit,
              position: base + offset,
              label: item.label ?? null,
            },
          });
        });
```

and in the new-entry branch:

```ts
      sourceItems.forEach((item, position) => {
        const id = newId();
        changes.push({
          table: 'plan_item',
          data: {
            id,
            plan_entry_id: entryId,
            ref_type: item.ref_type,
            ref_id: itemRefId(item.ref_type, item.ref_id, id),
            amount: item.amount,
            unit: item.unit,
            position,
            label: item.label ?? null,
          },
        });
      });
```

(`newId()` is still called once per item in the same order, so existing copy tests keep their ids.)

`web/src/plan/suggestion.ts`: import `itemLabel` instead of `itemName` (`import { itemLabel } from '../ui/ItemEditor';`) and change `names: items.map((i) => itemName(args.catalog, i.ref_type, i.ref_id)),` → `names: items.map((i) => itemLabel(args.catalog, i)),`.

`web/src/screens/Plan.tsx`: `import { itemName } from '../ui/ItemEditor';` → `import { itemLabel } from '../ui/ItemEditor';` and in `PlanCell` `const names = slot.items.map((i) => itemName(catalog, i.ref_type, i.ref_id)).join(', ');` → `const names = slot.items.map((i) => itemLabel(catalog, i)).join(', ');`

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --dir web exec vitest run test/plan.test.tsx test/plan-copy.test.ts test/plan-suggestion.test.ts test/plan-db.test.tsx test/plan-calculator.test.tsx`
Expected: PASS, 0 failed.

- [ ] **Step 5: Commit**

```bash
git add web/src/plan web/src/screens/Plan.tsx web/test/plan.test.tsx web/test/plan-copy.test.ts
git commit -m "web: quick carbs rows in plan slots, copies and suggestions"
```

### Task 13: Log editor keeps quick rows; Plan day total is plain grams

**Files:**
- Modify: `web/src/log/LogEntryEditor.tsx:92-104` (`recalculate`)
- Modify: `web/src/plan/slots.ts:1-17` (imports), `:84-100` (`dayTotal` → `dayCarbs` + `dayTotalText`)
- Modify: `web/src/screens/Plan.tsx:11` (import), `:191-196` (day total)
- Test: `web/test/log.test.tsx` (append), `web/test/plan-slots.test.ts:4, 88-116`, `web/test/plan.test.tsx:119-125`

- [ ] **Step 1: Write the failing tests**

Append to `web/test/log.test.tsx`:

```tsx
describe('quick carbs rows in the log', () => {
  it('shows "label · N g carbs" and keeps the label and carbs through a recalculation', async () => {
    const user = await setup();
    await services.db.log_item.put(
      item({ id: 'li-quick', log_entry_id: 'today', ref_type: 'quick', ref_id: 'li-quick', display_name: 'Ranch & salad', amount: 7, unit: 'carbs', carbs_g: 7 }),
    );
    renderWith(<Log />, services);
    await user.click(await screen.findByRole('button', { name: /11:00 Lunch/ }));
    expect(await screen.findByText('Ranch & salad · 7 g carbs')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Recalculate from current meal' }));
    expect(screen.getByTestId('entry-carbs')).toHaveTextContent('Total 55 g carbs');
    expect(screen.getByRole('status')).toHaveTextContent('Recalculated from current foods and meals.');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(async () => expect((await services.db.log_entry.get('today'))?.total_carbs_g).toBe(55));
    expect(await services.db.log_item.get('li-quick')).toMatchObject({ display_name: 'Ranch & salad', amount: 7, carbs_g: 7 });
  });
});
```

In `web/test/plan-slots.test.ts` change the import to `import { buildSlots, dayCarbs, dayTotalText, slotKey, windowsFor } from '../src/plan/slots';` and replace the whole `describe('dayTotal', …)` block with:

```ts
describe('dayCarbs / dayTotalText (quick-carbs spec §3: no day goal)', () => {
  it('sums the slots carbs', () => {
    const slots = buildSlots({ dates: ['2026-09-16'], windows: WINDOWS, entries: [entry({})], items: [item({})], catalog });
    expect(dayCarbs(slots)).toEqual({ carbs_g: 48, complete: true });
  });

  it('counts quick carbs rows', () => {
    const slots = buildSlots({
      dates: ['2026-09-16'],
      windows: WINDOWS,
      entries: [entry({})],
      items: [item({}), item({ id: 'q1', ref_type: 'quick', ref_id: 'q1', amount: 7, unit: 'carbs', position: 1, label: 'Salsa' })],
      catalog,
    });
    expect(dayCarbs(slots)).toEqual({ carbs_g: 55, complete: true });
  });

  it('is incomplete when any slot in the day is incomplete', () => {
    const slots = buildSlots({
      dates: ['2026-09-16'],
      windows: WINDOWS,
      entries: [entry({})],
      items: [item({ ref_id: 'not-here-yet' })],
      catalog,
    });
    expect(dayCarbs(slots).complete).toBe(false);
  });

  it('formats plain grams, or "missing data"', () => {
    expect(dayTotalText({ carbs_g: 72, complete: true })).toBe('72 g');
    expect(dayTotalText({ carbs_g: 80.4167, complete: true })).toBe('80.4 g');
    expect(dayTotalText({ carbs_g: 12, complete: false })).toBe('missing data');
  });
});
```

In `web/test/plan.test.tsx` replace the test `'shows a day total against the summed day goal'` with:

```tsx
  it('shows the day total as plain grams with no goal colour or goal text', async () => {
    await setup();
    await seedLunch();
    renderWith(<Plan />, services);
    const total = await screen.findByTestId('plan-day-total-2026-09-16');
    expect(total).toHaveTextContent('Day total: 72 g');
    expect(total).not.toHaveTextContent('goal');
    expect(total).not.toHaveTextContent('on target');
    expect(total).not.toHaveClass('goal');
    expect(total.querySelector('.goal')).toBeNull();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --dir web exec vitest run test/log.test.tsx test/plan-slots.test.ts test/plan.test.tsx`
Expected: FAIL — the log recalculation renames the quick row to `Extra carbs`; `dayCarbs`/`dayTotalText` are not exported; the day total still reads `72 g · goal 160–300`.

- [ ] **Step 3: Write minimal implementation**

`web/src/log/LogEntryEditor.tsx`, in `recalculate`, replace

```tsx
        return { ...row, carbs_g: result.carbs_g, display_name: itemName(catalog, row.ref_type, row.ref_id) };
```

with

```tsx
        return {
          ...row,
          carbs_g: result.carbs_g,
          // A quick row has no food to take a name from: it keeps its logged label.
          display_name: row.ref_type === 'quick' ? row.display_name : itemName(catalog, row.ref_type, row.ref_id),
        };
```

`web/src/plan/slots.ts`:
1. Remove `dayGoal,` from the `@carbbook/core` import.
2. `import { dayRange } from '../ui/format';` → `import { dayRange, formatCarbs } from '../ui/format';`
3. Replace the whole `dayTotal` doc comment + function with:

```ts
/** A day's planned carbs. Day totals carry no goal and no colour (quick-carbs spec §3). */
export function dayCarbs(slots: Slot[]): CarbResult {
  return sumCarbs(slots.map((s) => s.carbs));
}

/** "72 g", or "missing data" when any slot in the day is incomplete. */
export function dayTotalText(carbs: CarbResult): string {
  return carbs.complete ? formatCarbs(carbs.carbs_g) : 'missing data';
}
```

(`DoseWindow` and `CarbGoal` are still used elsewhere in the file; keep those imports.)

`web/src/screens/Plan.tsx`:
1. `import { buildSlots, dayTotal, type Slot, windowsFor } from '../plan/slots';` → `import { buildSlots, dayCarbs, dayTotalText, type Slot, windowsFor } from '../plan/slots';`
2. Replace

```tsx
            <p className="total">
              <GoalReadout
                view={goalView(dayTotal(byDate.get(date) ?? []).carbs, dayTotal(byDate.get(date) ?? []).goal)}
                testId={`plan-day-total-${date}`}
              />
            </p>
```

with

```tsx
            <p className="total" data-testid={`plan-day-total-${date}`}>
              Day total: {dayTotalText(dayCarbs(byDate.get(date) ?? []))}
            </p>
```

(`GoalReadout` and `goalView` stay: `PlanCell` still uses them.)

- [ ] **Step 4: Run the whole web suite and typecheck**

Run: `pnpm --dir web test && pnpm --dir web typecheck`
Expected: all test files pass, 0 failed; typecheck exits 0. (`grep -rn "dayTotal\b\|dayGoal" web/src` must print nothing.)

- [ ] **Step 5: Commit**

```bash
git add web/src/log/LogEntryEditor.tsx web/src/plan/slots.ts web/src/screens/Plan.tsx web/test/log.test.tsx web/test/plan-slots.test.ts web/test/plan.test.tsx
git commit -m "web: keep quick rows on log recalc; plain-gram day totals on the Plan screen"
```

### Task 14: Playwright end-to-end + full TS verification

**Files:**
- Modify: `web/e2e/carbbook.spec.ts` (append a test)

- [ ] **Step 1: Write the e2e test**

Append to `web/e2e/carbbook.spec.ts`:

```ts
test('quick carbs: plan 4 taquitos + 7 g, load, log 75 g, slot logged with both rows (quick-carbs spec §5)', async ({
  page,
  playwright,
  baseURL,
}) => {
  // A portion-only food (17 g per taquito), pushed through the API as another device would.
  const api = await playwright.request.newContext({ baseURL });
  expect((await api.post('/api/auth/login', { data: { username: USERNAME, password: PASSWORD } })).ok()).toBe(true);
  const meta = { updated_at: Date.now(), updated_by: 'e2e-seed', deleted: 0 };
  const seeded = await api.post('/api/sync/push', {
    data: {
      changes: [
        { table: 'food', record: { id: 'e2e-taquitos', name: 'Taquitos', source: 'custom', carbs_per_100g: null, ...meta } },
        {
          table: 'portion',
          record: { id: 'e2e-taquito', food_id: 'e2e-taquitos', label: 'taquito', kind: 'count', quantity: 1, grams: null, carbs_g: 17, ...meta },
        },
      ],
    },
  });
  expect(((await seeded.json()) as { results: { status: string }[] }).results.map((r) => r.status)).toEqual(['accepted', 'accepted']);

  await page.goto('/');
  await page.getByLabel('Username').fill(USERNAME);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Calculator' })).toBeVisible();
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Sync now' }).click();
  await expect(page.getByTestId('pending-count')).toHaveText('0 pending changes');

  const today = await page.evaluate(() => {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  });

  // Plan tonight's dinner: 4 taquitos + a quick row.
  await page.getByRole('link', { name: 'Plan' }).click();
  const cell = page.getByTestId(`plan-cell-${today}-Dinner`);
  await cell.getByRole('button').click();
  await page.getByLabel('Add to this slot').fill('taquito');
  await page.getByRole('button', { name: /Taquitos/ }).click();
  await page.getByLabel('Amount of Taquitos').fill('4');
  await page.getByRole('button', { name: '+ Carbs' }).click();
  await page.getByLabel('Label for carbs row 1').fill('Ranch & salad');
  await page.getByLabel('Grams of carbs for carbs row 1').fill('7');
  await expect(page.getByText('Ranch & salad — 7 g carbs')).toBeVisible();
  await expect(page.getByTestId('slot-carbs')).toContainText('75 g');
  await page.getByRole('button', { name: 'Save slot' }).click();
  await expect(cell).toContainText('Taquitos, Ranch & salad');
  await expect(page.getByTestId(`plan-carbs-${today}-Dinner`)).toContainText('75 g');
  await expect(page.getByTestId(`plan-day-total-${today}`)).toContainText('Day total:');
  await expect(page.getByTestId(`plan-day-total-${today}`)).not.toContainText('goal');

  // Load it in the Calculator (Dinner chosen explicitly so the test doesn't depend on the clock) and log it.
  await page.getByRole('link', { name: 'Calculator' }).click();
  await page.getByLabel('Window').selectOption('Dinner');
  await expect(page.getByTestId('plan-suggestion')).toContainText('Planned: Taquitos, Ranch & salad · 75 g');
  await page.getByRole('button', { name: 'Load' }).click();
  await expect(page.getByLabel('Label for carbs row 1')).toHaveValue('Ranch & salad');
  await expect(page.getByTestId('total-carbs')).toContainText('75 g');
  await page.getByRole('button', { name: 'Log it' }).click();
  await expect(page.getByRole('status')).toContainText('Logged 75 g carbs');

  await page.getByRole('link', { name: 'Plan' }).click();
  await expect(cell).toContainText('logged');
  await expect(cell).toContainText('Taquitos, Ranch & salad');

  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByTestId('pending-count')).toHaveText('0 pending changes', { timeout: 15_000 });

  // Server state: the slot is logged and linked; the log and the plan both hold both rows.
  const pull = (await (await api.get('/api/sync/pull?since=0&limit=1000')).json()) as { changes: { table: string; record: Record }[] };
  const rows = (table: string) => pull.changes.filter((c) => c.table === table).map((c) => c.record);
  const slot = rows('plan_entry').find((e) => e.deleted === 0 && e.date === today && e.window_name === 'Dinner')!;
  expect(slot.status).toBe('logged');
  const logged = rows('log_entry').find((e) => e.id === slot.log_entry_id)!;
  expect(logged.total_carbs_g).toBe(75);
  const logItems = rows('log_item').filter((i) => i.log_entry_id === logged.id);
  expect(logItems.map((i) => [i.ref_type, i.display_name, i.amount, i.unit, i.carbs_g])).toEqual(
    expect.arrayContaining([
      ['food', 'Taquitos', 4, 'p:e2e-taquito', 68],
      ['quick', 'Ranch & salad', 7, 'carbs', 7],
    ]),
  );
  expect(logItems).toHaveLength(2);
  const planItems = rows('plan_item')
    .filter((i) => i.plan_entry_id === slot.id && i.deleted === 0)
    .sort((a, b) => (a.position as number) - (b.position as number));
  expect(planItems.map((i) => [i.ref_type, i.amount, i.label])).toEqual([
    ['food', 4, null],
    ['quick', 7, 'Ranch & salad'],
  ]);
  await api.dispose();
});
```

- [ ] **Step 2: Run the e2e suite**

Run: `pnpm --dir web exec playwright test`
Expected: `3 passed` (the two existing tests and the new one). If Chromium is missing: `pnpm --dir web exec playwright install chromium`, then re-run.

- [ ] **Step 3: Full TypeScript verification**

Run: `pnpm -r typecheck && pnpm -r test && pnpm --dir web build`
Expected: typecheck exits 0 in all three packages; core, server and web report 0 failed; the build prints `✓ built` and writes `web/dist/sw.js`.

- [ ] **Step 4: Commit**

```bash
git add web/e2e/carbbook.spec.ts
git commit -m "web: e2e for quick carbs through plan, calculator and log"
```

---

# Part D — iOS

Swift packages are tested locally on Linux through Docker (`ios/scripts/swift-test.sh <package> [--filter X]`, first run builds the `carbbook-swift:6.3.3` image). The SwiftUI app target only compiles on macOS, so Tasks 19–21 are verified by the `build-ipa` workflow in Task 22 — keep their code exactly as written and re-read every edited view for balanced braces before committing.

### Task 15: Swift core mirror — types, units, `itemCarbs`, vectors

**Files:**
- Modify: `ios/CarbBookCore/Sources/CarbBookCore/Types.swift:122-146` (`RefType`, `MealItemData`)
- Modify: `ios/CarbBookCore/Sources/CarbBookCore/Plan.swift:48-73` (`PlanItemData`)
- Modify: `ios/CarbBookCore/Sources/CarbBookCore/Units.swift:4-19` (constants) + new functions after `isValidAmount`
- Modify: `ios/CarbBookCore/Sources/CarbBookCore/Carbs.swift:125-139` (`resolveItem`)
- Modify: `ios/CarbBookCore/Sources/CarbBookCore/LogRecalc.swift:35-38` (exhaustive switch)
- Modify: `ios/CarbBookCore/Tests/CarbBookCoreTests/VectorTests.swift:83-114`
- Copy: `ios/CarbBookCore/Tests/CarbBookCoreTests/Resources/units-vectors.json` (via script)
- Create: `ios/CarbBookCore/Tests/CarbBookCoreTests/QuickCarbsTests.swift`

- [ ] **Step 1: Sync the vectors and write the failing tests**

Run: `ios/scripts/sync-testdata.sh && ios/scripts/sync-testdata.sh --check`
Expected: `testdata vectors in sync` (twice).

In `VectorTests.swift` `testUnitsVectors()`, add after `XCTAssertFalse(u.cycle_cases.isEmpty)`:

```swift
        XCTAssertTrue(u.carb_cases.contains { $0.ref_type == .quick }, "quick carbs vectors present")
        XCTAssertTrue(u.unit_list_cases.contains { $0.ref_type == .quick })
```

and replace the unit-list loop with:

```swift
        for c in u.unit_list_cases {
            let units: [String]
            switch c.ref_type {
            case .food: units = foodUnits(try XCTUnwrap(catalog.food(c.ref_id)), catalog.portions(c.ref_id))
            case .meal: units = mealUnits(try XCTUnwrap(catalog.meal(c.ref_id)))
            case .quick: units = quickUnits()
            }
            XCTAssertEqual(units, c.expect, "unit list: \(c.ref_id)")
        }
```

Create `ios/CarbBookCore/Tests/CarbBookCoreTests/QuickCarbsTests.swift`:

```swift
import XCTest
@testable import CarbBookCore

final class QuickCarbsTests: XCTestCase {
    let catalog = InMemoryCatalog(
        foods: [FoodData(id: "tortilla", name: "Tortilla", carbsPer100g: 48)],
        meals: [MealData(id: "plate", name: "Plate", yieldServings: 2)],
        mealItems: [
            MealItemData(id: "m1", mealId: "plate", refType: .food, refId: "tortilla", amount: 100, unit: "g", position: 0),
            MealItemData(id: "m2", mealId: "plate", refType: .quick, refId: "m2", amount: 7, unit: Units.quick, position: 1,
                         label: "Salsa"),
        ])

    func testQuickRowsAreTheirOwnCarbs() {
        XCTAssertEqual(itemCarbs(catalog, .quick, "no-such-row", 7, Units.quick), CarbResult(carbsG: 7, complete: true))
        XCTAssertEqual(itemCarbs(catalog, .quick, "", 0, Units.quick), CarbResult(carbsG: 0, complete: true))
        XCTAssertEqual(itemCarbs(catalog, .quick, "q", 2000, Units.quick), CarbResult(carbsG: 2000, complete: true))
    }

    func testInvalidQuickRowsFailClosed() {
        let cases: [(Double, String)] = [
            (2001, Units.quick), (-1, Units.quick), (Double.nan, Units.quick), (Double.infinity, Units.quick), (7, "g"), (7, "serving"),
        ]
        for (amount, unit) in cases {
            XCTAssertEqual(itemCarbs(catalog, .quick, "q", amount, unit), .incomplete, "\(amount) \(unit)")
        }
    }

    func testMealsCountQuickComponentsAndNeverCycle() {
        XCTAssertEqual(itemCarbs(catalog, .meal, "plate", 1, Units.serving).carbsG, 27.5, accuracy: 1e-9)
        XCTAssertFalse(wouldCreateCycle(catalog, "plate", "m2"))
    }

    func testLabelsNamesUnitsAndRefIds() {
        XCTAssertEqual(Units.quick, "carbs")
        XCTAssertEqual(quickUnits(), ["carbs"])
        XCTAssertTrue(isValidQuickCarbs(0))
        XCTAssertTrue(isValidQuickCarbs(2000))
        XCTAssertFalse(isValidQuickCarbs(2000.01))
        XCTAssertFalse(isValidQuickCarbs(.nan))
        XCTAssertNil(normalizeQuickLabel("   "))
        XCTAssertNil(normalizeQuickLabel(nil))
        XCTAssertEqual(normalizeQuickLabel("  Ranch & salad "), "Ranch & salad")
        XCTAssertEqual(normalizeQuickLabel(String(repeating: "x", count: 90)), String(repeating: "x", count: 80))
        XCTAssertEqual(quickDisplayName(nil), "Extra carbs")
        XCTAssertEqual(quickDisplayName(" Salsa "), "Salsa")
        XCTAssertEqual(itemRefId(.quick, "", rowId: "row"), "row")
        XCTAssertEqual(itemRefId(.food, "rice", rowId: "row"), "rice")
    }

    func testItemsEncodeLabelAsExplicitNullAndDecodeQuickRows() throws {
        let food = MealItemData(id: "a", mealId: "m", refType: .food, refId: "f", amount: 1, unit: "g", position: 0)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(food)) as? [String: Any])
        XCTAssertTrue(json["label"] is NSNull, "label is sent as an explicit null, never omitted")
        let plan = PlanItemData(id: "p", planEntryId: "e", refType: .food, refId: "f", amount: 1, unit: "g", position: 0)
        let planJson = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(plan)) as? [String: Any])
        XCTAssertTrue(planJson["label"] is NSNull)

        let decoded = try JSONDecoder().decode(PlanItemData.self, from: Data("""
        {"id":"q","plan_entry_id":"p","ref_type":"quick","ref_id":"q","amount":7,"unit":"carbs","position":1,"label":"Ranch & salad"}
        """.utf8))
        XCTAssertEqual(decoded.refType, .quick)
        XCTAssertEqual(decoded.label, "Ranch & salad")
        let older = try JSONDecoder().decode(MealItemData.self, from: Data("""
        {"id":"a","meal_id":"m","ref_type":"food","ref_id":"f","amount":1,"unit":"g","position":0}
        """.utf8))
        XCTAssertNil(older.label)
        let log = try JSONDecoder().decode(LogItemData.self, from: Data("""
        {"id":"l","log_entry_id":"e","ref_type":"quick","ref_id":"l","display_name":"Ranch & salad","amount":7,"unit":"carbs","carbs_g":7}
        """.utf8))
        XCTAssertEqual(log.refType, .quick)
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `ios/scripts/swift-test.sh CarbBookCore`
Expected: build FAILS — `type 'RefType' has no member 'quick'`, `type 'Units' has no member 'quick'`, `extra argument 'label' in call`.

- [ ] **Step 3: Write minimal implementation**

`Types.swift` — replace `RefType` and `MealItemData` with:

```swift
public enum RefType: String, Codable, Sendable {
    /// `quick`: a carbs-only row with no food (quick-carbs spec §2) — amount is grams of carbs, unit "carbs".
    case food, meal, quick
}

public struct MealItemData: Codable, Equatable, Sendable {
    public var id: Id
    public var mealId: Id
    public var refType: RefType
    public var refId: Id
    public var amount: Double
    public var unit: String
    public var position: Int
    /// Quick carbs rows only: optional text, at most 80 characters.
    public var label: String?
    public var deleted: Int?

    public init(id: Id, mealId: Id, refType: RefType, refId: Id, amount: Double, unit: String, position: Int,
                label: String? = nil, deleted: Int? = nil) {
        self.id = id; self.mealId = mealId; self.refType = refType; self.refId = refId
        self.amount = amount; self.unit = unit; self.position = position; self.label = label; self.deleted = deleted
    }

    enum CodingKeys: String, CodingKey {
        case id, amount, unit, position, label, deleted
        case mealId = "meal_id"
        case refType = "ref_type"
        case refId = "ref_id"
    }

    /// Explicit, so a nil `label` is sent as JSON `null`: the server reads a missing key as "keep the
    /// stored value", so only an explicit null clears a label.
    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(mealId, forKey: .mealId)
        try container.encode(refType, forKey: .refType)
        try container.encode(refId, forKey: .refId)
        try container.encode(amount, forKey: .amount)
        try container.encode(unit, forKey: .unit)
        try container.encode(position, forKey: .position)
        try container.encode(label, forKey: .label)
        try container.encodeIfPresent(deleted, forKey: .deleted)
    }
}
```

`Plan.swift` — replace `PlanItemData` with:

```swift
/// One row inside a planned slot: the same shape as `log_item` minus the snapshot fields
/// (`display_name`, `carbs_g`), plus the quick-row `label`. Plans never snapshot; carbs are computed
/// live with `itemCarbs`.
public struct PlanItemData: Codable, Equatable, Sendable {
    public var id: Id
    public var planEntryId: Id
    public var refType: RefType
    public var refId: Id
    public var amount: Double
    public var unit: String
    public var position: Int
    /// Quick carbs rows only: optional text, at most 80 characters.
    public var label: String?
    public var deleted: Int?

    public init(id: Id, planEntryId: Id, refType: RefType, refId: Id, amount: Double, unit: String,
                position: Int, label: String? = nil, deleted: Int? = nil) {
        self.id = id; self.planEntryId = planEntryId; self.refType = refType; self.refId = refId
        self.amount = amount; self.unit = unit; self.position = position; self.label = label; self.deleted = deleted
    }

    enum CodingKeys: String, CodingKey {
        case id, amount, unit, position, label, deleted
        case planEntryId = "plan_entry_id"
        case refType = "ref_type"
        case refId = "ref_id"
    }

    /// Explicit, so a nil `label` is sent as JSON `null` (see `MealItemData.encode`).
    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(planEntryId, forKey: .planEntryId)
        try container.encode(refType, forKey: .refType)
        try container.encode(refId, forKey: .refId)
        try container.encode(amount, forKey: .amount)
        try container.encode(unit, forKey: .unit)
        try container.encode(position, forKey: .position)
        try container.encode(label, forKey: .label)
        try container.encodeIfPresent(deleted, forKey: .deleted)
    }
}
```

`Units.swift` — inside `public enum Units { … }`, after `public static let maxPortionCarbsG = 500.0`, add:

```swift

    /// Quick carbs rows (quick-carbs spec §2): amount is grams of carbs and this is the only unit.
    public static let quick = "carbs"
    public static let quickLabelMax = 80
    public static let quickDefaultLabel = "Extra carbs"
```

and after `public func isValidAmount(...)` add:

```swift
/// Grams of carbs on a quick row: finite and 0 ... DoseLimits.maxCarbsG. Mirrors units.ts.
public func isValidQuickCarbs(_ amount: Double) -> Bool {
    amount.isFinite && amount >= 0 && amount <= DoseLimits.maxCarbsG
}

public func quickUnits() -> [String] { [Units.quick] }

/// Stored form of a quick row's label: trimmed, at most 80 UTF-16 units (the server counts JS
/// string length), nil when blank. Mirrors units.ts `normalizeQuickLabel`.
public func normalizeQuickLabel(_ label: String?) -> String? {
    let trimmed = (label ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    let capped = String(decoding: trimmed.utf16.prefix(Units.quickLabelMax), as: UTF16.self)
        .trimmingCharacters(in: .whitespacesAndNewlines)
    return capped.isEmpty ? nil : capped
}

/// What a quick row is called on screen and in log snapshots.
public func quickDisplayName(_ label: String?) -> String {
    normalizeQuickLabel(label) ?? Units.quickDefaultLabel
}

/// ref_id to store for a row: a quick row points at itself; food and meal rows keep theirs.
public func itemRefId(_ refType: RefType, _ refId: Id, rowId: Id) -> Id {
    refType == .quick ? rowId : refId
}
```

`Carbs.swift` — replace `resolveItem` with:

```swift
/// Quick carbs row: the amount is the carbs; a wrong unit or out-of-range amount is incomplete.
private func quickItemCarbs(_ amount: Double, _ unit: String) -> CarbResult {
    unit == Units.quick && isValidQuickCarbs(amount) ? CarbResult(carbsG: amount, complete: true) : .incomplete
}

private func resolveItem(_ catalog: Catalog, _ refType: RefType, _ refId: Id, _ amount: Double, _ unit: String,
                         _ visiting: inout Set<Id>) -> CarbResult {
    switch refType {
    case .food: foodItemCarbs(catalog, refId, amount, unit)
    case .meal: mealItemCarbs(catalog, refId, amount, unit, &visiting)
    case .quick: quickItemCarbs(amount, unit)
    }
}
```

and change the doc comment of `itemCarbs` to `/// Carbs for one line item (a food, a meal or a quick carbs row) at the given amount and unit.`

`LogRecalc.swift` — the name switch becomes:

```swift
        switch item.refType {
        case .food: if let food = catalog.food(item.refId) { updated.displayName = food.name }
        case .meal: if let meal = catalog.meal(item.refId) { updated.displayName = meal.name }
        case .quick: break // a quick row keeps its logged label
        }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `ios/scripts/swift-test.sh CarbBookCore`
Expected: `Executed <N> tests, with 0 failures` (includes `QuickCarbsTests` and the new vector cases in `testUnitsVectors`).

- [ ] **Step 5: Commit**

```bash
git add ios/CarbBookCore testdata
git commit -m "ios core: quick carbs rows, labels and shared vectors"
```

### Task 16: Swift core — Calculator records and log recalculation

**Files:**
- Modify: `ios/CarbBookCore/Sources/CarbBookCore/Calculator.swift:3-17` (`CalculatorLine`), `:103-155` (`buildLogRecords`, `buildMealRecords`)
- Test: `ios/CarbBookCore/Tests/CarbBookCoreTests/QuickCarbsTests.swift` (append)

- [ ] **Step 1: Write the failing tests**

Append inside `final class QuickCarbsTests` (before its closing brace):

```swift
    let utc: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "UTC")!
        return c
    }()
    // 2026-09-14 18:00 UTC → Dinner in seedSettings.
    let dinner = Date(timeIntervalSince1970: 1_789_408_800)

    func testLogAndMealRecordsSnapshotQuickLines() {
        let lines = [
            CalculatorLine(id: "l1", refType: .food, refId: "tortilla", displayName: "Tortilla", amount: 100, unit: "g"),
            CalculatorLine(id: "l2", refType: .quick, refId: "", displayName: "", amount: 7, unit: Units.quick,
                           label: " Ranch & salad "),
            CalculatorLine(id: "l3", refType: .quick, refId: "", displayName: "", amount: 3, unit: Units.quick),
        ]
        let result = evaluateCalculator(lines: lines, catalog: catalog, settingsVersions: [seedSettings], eatenAt: dinner,
                                        calendar: utc, windowOverride: nil, bg: .none, lastDoseAtMs: nil, nowMs: 0)
        XCTAssertEqual(result.total, CarbResult(carbsG: 58, complete: true))
        XCTAssertNotNil(result.breakdown, "quick rows count toward the dose like any other row")

        var n = 0
        let (entry, items) = buildLogRecords(lines: lines, result: result, bg: .none, eatenAt: dinner, takenUnits: nil,
                                             notes: nil, newId: { n += 1; return "id\(n)" })
        XCTAssertEqual(entry.totalCarbsG, 58)
        XCTAssertEqual(items.map(\.displayName), ["Tortilla", "Ranch & salad", "Extra carbs"])
        XCTAssertEqual(items.map(\.refId), ["tortilla", items[1].id, items[2].id])
        XCTAssertEqual(items.map(\.carbsG), [48, 7, 3])
        XCTAssertEqual(items[1].unit, Units.quick)

        let meal = buildMealRecords(name: "Taco", yieldServings: 1, totalWeightG: nil, lines: lines,
                                    newId: { n += 1; return "id\(n)" })
        XCTAssertEqual(meal.items.map(\.label), [nil, "Ranch & salad", nil])
        XCTAssertEqual(meal.items[1].refId, meal.items[1].id)
        XCTAssertEqual(meal.items[0].refId, "tortilla")
    }

    func testAnInvalidQuickLineRefusesTheDose() {
        let lines = [CalculatorLine(id: "l1", refType: .quick, refId: "", displayName: "", amount: 2001, unit: Units.quick)]
        let result = evaluateCalculator(lines: lines, catalog: catalog, settingsVersions: [seedSettings], eatenAt: dinner,
                                        calendar: utc, windowOverride: nil, bg: .none, lastDoseAtMs: nil, nowMs: 0)
        XCTAssertFalse(result.total.complete)
        XCTAssertNil(result.breakdown)
        XCTAssertNotNil(result.refusal)
    }

    func testRecalculationKeepsAQuickRowsLoggedName() {
        let entry = LogEntryData(id: "e1", eatenAt: 1_789_408_800_000, windowName: "Dinner", bgMgdl: nil, bgSource: "none",
                                 bgTrend: nil, totalCarbsG: 55, suggestedUnits: 7, takenUnits: 7, settingsVersionId: "s1", notes: nil)
        let items = [
            LogItemData(id: "x1", logEntryId: "e1", refType: .food, refId: "tortilla", displayName: "Old name", amount: 100, unit: "g", carbsG: 40),
            LogItemData(id: "x2", logEntryId: "e1", refType: .quick, refId: "x2", displayName: "Ranch & salad", amount: 7,
                        unit: Units.quick, carbsG: 7),
        ]
        let result = recalculateLogEntry(entry: entry, items: items, catalog: catalog, settingsVersions: [seedSettings])
        XCTAssertTrue(result.complete)
        XCTAssertEqual(result.items.map(\.displayName), ["Tortilla", "Ranch & salad"])
        XCTAssertEqual(result.items.map(\.carbsG), [48, 7])
        XCTAssertEqual(result.entry.totalCarbsG, 55)
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `ios/scripts/swift-test.sh CarbBookCore --filter QuickCarbsTests`
Expected: build FAILS — `extra argument 'label' in call` (CalculatorLine).

- [ ] **Step 3: Write minimal implementation**

`Calculator.swift` — `CalculatorLine` becomes:

```swift
/// One row on the Calculator screen.
public struct CalculatorLine: Equatable, Sendable, Identifiable {
    public var id: String
    public var refType: RefType
    public var refId: Id
    public var displayName: String
    public var amount: Double
    public var unit: String
    /// Quick carbs rows only: the label as typed (quick-carbs spec §2). Their `displayName` is ignored.
    public var label: String?

    public init(id: String, refType: RefType, refId: Id, displayName: String, amount: Double, unit: String,
                label: String? = nil) {
        self.id = id; self.refType = refType; self.refId = refId
        self.displayName = displayName; self.amount = amount; self.unit = unit; self.label = label
    }
}
```

In `buildLogRecords` replace the `let items = zip(...)` block with:

```swift
    let items = zip(lines, result.lineCarbs).map { line, carbs -> LogItemData in
        let id = newId()
        // A quick row points at itself and is logged under its label (quick-carbs spec §2).
        return LogItemData(id: id, logEntryId: entry.id, refType: line.refType,
                           refId: itemRefId(line.refType, line.refId, rowId: id),
                           displayName: line.refType == .quick ? quickDisplayName(line.label) : line.displayName,
                           amount: line.amount, unit: line.unit, carbsG: carbs.carbsG)
    }
```

In `buildMealRecords` replace the `let items = lines.enumerated().map { ... }` block with:

```swift
    let items = lines.enumerated().map { index, line -> MealItemData in
        let id = newId()
        return MealItemData(id: id, mealId: meal.id, refType: line.refType,
                            refId: itemRefId(line.refType, line.refId, rowId: id),
                            amount: line.amount, unit: line.unit, position: index,
                            label: line.refType == .quick ? normalizeQuickLabel(line.label) : nil)
    }
```

(`newId` is still called once per line, in order.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `ios/scripts/swift-test.sh CarbBookCore`
Expected: `Executed <N> tests, with 0 failures`.

- [ ] **Step 5: Commit**

```bash
git add ios/CarbBookCore
git commit -m "ios core: log and meal records for quick carbs lines"
```

### Task 17: CarbBookKit — local schema v4 and codecs

**Files:**
- Modify: `ios/CarbBookKit/Sources/CarbBookKit/Schema.swift:8-21` (migrator) + new `v4QuickCarbs`
- Modify: `ios/CarbBookKit/Sources/CarbBookKit/TableCodec.swift:12, 19, 23-25`
- Modify: `ios/CarbBookKit/Sources/CarbBookKit/LocalSyncStore.swift:30`
- Test: `ios/CarbBookKit/Tests/CarbBookKitTests/QuickCarbsKitTests.swift` (create)

- [ ] **Step 1: Write the failing tests**

Create `ios/CarbBookKit/Tests/CarbBookKitTests/QuickCarbsKitTests.swift`:

```swift
import CarbBookCore
@testable import CarbBookKit
import Foundation
import GRDB
import XCTest

final class QuickCarbsKitTests: XCTestCase {
    let catalog = InMemoryCatalog(foods: [FoodData(id: "rice", name: "Rice", source: "custom", carbsPer100g: 28.2)])

    // MARK: - Store

    private func v3Store(at path: String) throws {
        let queue = try DatabaseQueue(path: path)
        var old = DatabaseMigrator()
        old.registerMigration("v1") { db in try db.execute(sql: Schema.v1) }
        old.registerMigration("v2-any-unit-foods") { db in try db.execute(sql: Schema.v2AnyUnitFoods) }
        old.registerMigration("v3-meal-plan") { db in try db.execute(sql: Schema.v3MealPlan) }
        try old.migrate(queue)
        try queue.write { db in
            try db.execute(sql: """
            INSERT INTO sync_state (key, value) VALUES ('device_id', 'ios-old'), ('pull_cursor', '42');
            INSERT INTO meal_item (id, meal_id, ref_type, ref_id, amount, unit, position, updated_at, updated_by, deleted, server_seq)
              VALUES ('mi1', 'm1', 'food', 'rice', 100, 'g', 0, 1000, 'ios-old', 0, 7);
            INSERT INTO plan_item (id, plan_entry_id, ref_type, ref_id, amount, unit, position, updated_at, updated_by, deleted, server_seq)
              VALUES ('pi1', 'p1', 'food', 'rice', 50, 'g', 0, 1000, 'ios-old', 0, NULL);
            INSERT INTO sync_pending (key, table_name, record_id, queued_at) VALUES ('plan_item/pi1', 'plan_item', 'pi1', 1000);
            """)
        }
        try queue.close()
    }

    func testMigratesAV3StoreAddingLabelsAndRepullingEverything() async throws {
        let path = try temporaryDirectory().appendingPathComponent("carbbook.sqlite").path
        try v3Store(at: path)
        let clock = TestClock(5_000)
        let store = try LocalStore(path: path, now: clock.now)

        XCTAssertEqual(store.deviceId, "ios-old")
        let items = try store.mealItems(mealId: "m1")
        XCTAssertEqual(items.map(\.id), ["mi1"])
        XCTAssertNil(items[0].label)
        let seq = try await store.dbQueue.read { db in try Int64.fetchOne(db, sql: "SELECT server_seq FROM meal_item WHERE id = 'mi1'") }
        XCTAssertEqual(seq, 7)
        let cursor = try await store.pullCursor()
        XCTAssertEqual(cursor, 0, "a full re-pull fills in labels an older app could not store")

        var pending = try await store.pendingChanges(limit: 500)
        XCTAssertEqual(pending.map(\.key), ["plan_item/pi1"])
        XCTAssertNil(pending[0].record["label"], "an edit made before the column existed must not clear the server's label")
        XCTAssertEqual(pending[0].record["amount"], .number(50))

        clock.ms = 6_000
        try store.save("plan_item", PlanItemData(id: "pi1", planEntryId: "p1", refType: .food, refId: "rice",
                                                 amount: 60, unit: "g", position: 0))
        pending = try await store.pendingChanges(limit: 500)
        XCTAssertEqual(pending[0].record["label"], .null, "a new edit carries every column")
    }

    func testQuickRowsSyncBetweenDevicesWithTheirLabel() async throws {
        let server = FakeServer()
        let deviceA = try LocalStore(path: nil, now: { 1_000 })
        let deviceB = try LocalStore(path: nil, now: { 1_000 })
        try deviceA.save("meal", MealData(id: "m1", name: "Plate", yieldServings: 1))
        try deviceA.save("meal_item", MealItemData(id: "q1", mealId: "m1", refType: .quick, refId: "q1", amount: 7,
                                                   unit: Units.quick, position: 0, label: "Salsa"))
        try deviceA.save("plan_item", PlanItemData(id: "q2", planEntryId: "p1", refType: .quick, refId: "q2", amount: 5,
                                                   unit: Units.quick, position: 0, label: "Ranch & salad"))
        try deviceA.save("log_item", LogItemData(id: "q3", logEntryId: "e1", refType: .quick, refId: "q3",
                                                 displayName: "Ranch & salad", amount: 7, unit: Units.quick, carbsG: 7))
        _ = try await SyncEngine(store: deviceA, transport: server).run { 1_000 }
        _ = try await SyncEngine(store: deviceB, transport: server).run { 1_000 }

        let catalog = try deviceB.catalog()
        XCTAssertEqual(catalog.mealItems("m1").first?.label, "Salsa")
        XCTAssertEqual(itemCarbs(catalog, .meal, "m1", 1, Units.serving), CarbResult(carbsG: 7, complete: true))
        let planItems: [PlanItemData] = try deviceB.records("plan_item")
        XCTAssertEqual(planItems.first?.label, "Ranch & salad")
        XCTAssertEqual(try deviceB.logItems(entryId: "e1").first?.displayName, "Ranch & salad")
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `ios/scripts/swift-test.sh CarbBookKit --filter QuickCarbsKitTests`
Expected: FAIL — the migration test's `pullCursor` is 42 and `label` is never stored (`TableCodec` drops it), so `mealItems("m1").first?.label` is nil.

- [ ] **Step 3: Write minimal implementation**

`Schema.swift` — register after `v3-meal-plan`:

```swift
        migrator.registerMigration("v4-quick-carbs") { db in
            try db.execute(sql: v4QuickCarbs)
        }
```

and add above `static let v3MealPlan`:

```swift
    /// Quick carbs rows (quick-carbs spec §2): `label` on meal_item and plan_item. The local tables have
    /// no ref_type CHECK, so `quick` rows need no rebuild. App 0.2.0 stored pulled rows without `label`
    /// (no column) and could not decode `quick` rows at all, so the pull cursor restarts at 0: a full
    /// re-pull fills them in (`shouldApplyPulled` re-applies an equal version; newer local edits win).
    /// Rows pending at migration time were edited without knowing `label`; `sync_legacy_pending` makes
    /// their push omit it (server keeps its stored value) until they are edited again.
    static let v4QuickCarbs = """
    ALTER TABLE meal_item ADD COLUMN label TEXT;
    ALTER TABLE plan_item ADD COLUMN label TEXT;
    INSERT OR IGNORE INTO sync_legacy_pending (key) SELECT key FROM sync_pending WHERE table_name IN ('meal_item', 'plan_item');
    UPDATE sync_state SET value = '0' WHERE key = 'pull_cursor';
    """
```

`TableCodec.swift`:
- `"meal_item": ["meal_id", "ref_type", "ref_id", "amount", "unit", "position"],` → `"meal_item": ["meal_id", "ref_type", "ref_id", "amount", "unit", "position", "label"],`
- `"plan_item": ["plan_entry_id", "ref_type", "ref_id", "amount", "unit", "position"],` → `"plan_item": ["plan_entry_id", "ref_type", "ref_id", "amount", "unit", "position", "label"],`
- replace

```swift
    /// Columns added by the any-unit foods migration. Omitted from the push of a row that was pending
    /// before the migration (see `Schema.v2AnyUnitFoods`), so the server keeps its stored values.
    static let anyUnitColumns: [String: [String]] = ["food": ["carbs_per_100ml"], "portion": ["carbs_g"]]
```

with

```swift
    /// Columns added by later migrations (`Schema.v2AnyUnitFoods`, `Schema.v4QuickCarbs`). Omitted from
    /// the push of a row that was pending before its table gained them, so the server keeps its values.
    static let legacyColumns: [String: [String]] = [
        "food": ["carbs_per_100ml"], "portion": ["carbs_g"], "meal_item": ["label"], "plan_item": ["label"],
    ]
```

(The two comment lines about `jsonColumns` above it stay where they are.)

`LocalSyncStore.swift:30` — `TableCodec.anyUnitColumns[change.table]` → `TableCodec.legacyColumns[change.table]`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `ios/scripts/swift-test.sh CarbBookKit`
Expected: `Executed <N> tests, with 0 failures` (the existing `AnyUnitStoreTests` still pass: their legacy food key only strips `carbs_per_100ml`).

- [ ] **Step 5: Commit**

```bash
git add ios/CarbBookKit
git commit -m "ios kit: local schema v4 stores quick row labels"
```

### Task 18: CarbBookKit — input rules, names, plan editing and suggestions

**Files:**
- Modify: `ios/CarbBookKit/Sources/CarbBookKit/CalculatorInputs.swift:37-49` (`hasInvalidAmount`) + new `QuickCarbsInput`
- Create: `ios/CarbBookKit/Sources/CarbBookKit/ItemDisplay.swift`
- Modify: `ios/CarbBookKit/Sources/CarbBookKit/FoodLabel.swift:138-142` (`displayUnitName`)
- Modify: `ios/CarbBookKit/Sources/CarbBookKit/PlanEditing.swift:14-24` (`DraftItem`), `:52-78` (`saveChanges`), `:224-232` (copy), new `dayTotalText`
- Modify: `ios/CarbBookKit/Sources/CarbBookKit/PlanSuggestion.swift:30-50`
- Test: `ios/CarbBookKit/Tests/CarbBookKitTests/QuickCarbsKitTests.swift` (append)

- [ ] **Step 1: Write the failing tests**

Append inside `final class QuickCarbsKitTests`:

```swift
    // MARK: - Inputs, names, plans

    func testQuickCarbsInputIsADecimalWithinTheLimit() {
        XCTAssertEqual(QuickCarbsInput.parse("7"), 7)
        XCTAssertEqual(QuickCarbsInput.parse(" 7,5 "), 7.5)
        XCTAssertEqual(QuickCarbsInput.parse("2000"), 2000)
        for bad in ["", " ", "2001", "1/2", "½", "-1", "1e3", "abc"] {
            XCTAssertNil(QuickCarbsInput.parse(bad), bad)
            XCTAssertTrue(QuickCarbsInput.isInvalid(bad), bad)
        }
        XCTAssertTrue(QuickCarbsInput.modelAmount("abc").isNaN)
        XCTAssertEqual(QuickCarbsInput.rowText(label: " Ranch & salad ", amount: 7), "Ranch & salad — 7 g carbs")
        XCTAssertEqual(QuickCarbsInput.rowText(label: nil, amount: 7.26), "Extra carbs — 7.3 g carbs")
        XCTAssertEqual(QuickCarbsInput.rowText(label: "", amount: .nan), "Extra carbs — enter grams of carbs")
        XCTAssertEqual(QuickCarbsInput.rowText(label: "Big", amount: 2001), "Big — enter grams of carbs")
    }

    func testInvalidQuickAmountsBlockSavingAndLogging() {
        let over = CalculatorLine(id: "l", refType: .quick, refId: "", displayName: "", amount: 2001, unit: Units.quick)
        let fine = CalculatorLine(id: "l", refType: .quick, refId: "", displayName: "", amount: 7, unit: Units.quick)
        XCTAssertTrue(AmountInput.hasInvalidAmount([over]))
        XCTAssertFalse(AmountInput.hasInvalidAmount([fine]))
        let bigFood = CalculatorLine(id: "f", refType: .food, refId: "rice", displayName: "Rice", amount: 5000, unit: "g")
        XCTAssertFalse(AmountInput.hasInvalidAmount([bigFood]), "the 2000 g cap applies to quick carbs only")
        let mealItem = MealItemData(id: "m", mealId: "x", refType: .quick, refId: "m", amount: 2001, unit: Units.quick, position: 0)
        XCTAssertTrue(AmountInput.hasInvalidAmount([mealItem]))
    }

    func testDisplayNamesUnitsAndDayTotals() {
        XCTAssertEqual(itemDisplayName(.quick, "q", label: "Salsa", catalog: catalog), "Salsa")
        XCTAssertEqual(itemDisplayName(.quick, "q", label: "  ", catalog: catalog), "Extra carbs")
        XCTAssertEqual(itemDisplayName(.food, "rice", label: nil, catalog: catalog), "Rice")
        XCTAssertEqual(itemDisplayName(.meal, "gone", label: nil, catalog: catalog), "Unknown item")
        XCTAssertEqual(itemUnits(.quick, "q", currentUnit: Units.quick, catalog: catalog), ["carbs"])
        XCTAssertEqual(itemUnits(.food, "gone", currentUnit: "cup", catalog: catalog), ["cup"])
        XCTAssertEqual(displayUnitName(Units.quick, portions: []), "g carbs")
        XCTAssertEqual(PlanEditing.dayTotalText(CarbResult(carbsG: 72, complete: true)), "72 g")
        XCTAssertEqual(PlanEditing.dayTotalText(CarbResult(carbsG: 80.4167, complete: true)), "80.4 g")
        XCTAssertEqual(PlanEditing.dayTotalText(CarbResult(carbsG: 12, complete: false)), "missing data")
    }

    func testSlotSaveStoresQuickRowsWithLabelAndOwnRefId() throws {
        var n = 0
        let draft = PlanEditing.Draft(date: "2026-09-16", windowName: "Dinner", note: nil, items: [
            PlanEditing.DraftItem(id: nil, refType: .food, refId: "rice", amount: 100, unit: "g"),
            PlanEditing.DraftItem(id: nil, refType: .quick, refId: "", amount: 7, unit: Units.quick, label: "  Ranch & salad "),
        ])
        let changes = try PlanEditing.saveChanges(draft: draft, existing: nil, existingItems: [],
                                                  newId: { n += 1; return "new\(n)" })
        XCTAssertEqual(changes.map(\.table), ["plan_entry", "plan_item", "plan_item"])
        XCTAssertEqual(changes[1].record["label"], .null)
        XCTAssertEqual(changes[1].record["ref_id"], .string("rice"))
        XCTAssertEqual(changes[2].record["ref_type"], .string("quick"))
        XCTAssertEqual(changes[2].record["ref_id"], changes[2].record["id"])
        XCTAssertEqual(changes[2].record["label"], .string("Ranch & salad"))
        XCTAssertEqual(changes[2].record["unit"], .string("carbs"))
    }

    func testSlotSaveRefusesAnOverLimitQuickRow() {
        let draft = PlanEditing.Draft(date: "2026-09-16", windowName: "Dinner", note: nil, items: [
            PlanEditing.DraftItem(id: nil, refType: .quick, refId: "", amount: 2001, unit: Units.quick),
        ])
        XCTAssertThrowsError(try PlanEditing.saveChanges(draft: draft, existing: nil, existingItems: [], newId: { "x" })) {
            XCTAssertEqual($0 as? PlanEditing.EditError, .invalidAmount)
        }
    }

    func testCopyKeepsTheLabelAndRepointsRefId() throws {
        var n = 0
        let source = PlanEntryData(id: "src", date: "2026-09-16", windowName: "Dinner", status: .logged, logEntryId: "l1")
        let quick = PlanItemData(id: "q1", planEntryId: "src", refType: .quick, refId: "q1", amount: 7, unit: Units.quick,
                                 position: 0, label: "Ranch & salad")
        let changes = try PlanEditing.copyChanges(
            sourceEntries: [source], targetEntries: [], itemsByEntry: ["src": [quick]],
            dayOffsets: ["2026-09-16": "2026-09-17"], mode: .skip, newId: { n += 1; return "new\(n)" })
        let item = try XCTUnwrap(changes.first { $0.table == "plan_item" })
        XCTAssertEqual(item.record["id"], .string("new2"))
        XCTAssertEqual(item.record["ref_id"], .string("new2"))
        XCTAssertEqual(item.record["label"], .string("Ranch & salad"))
        XCTAssertEqual(item.record["amount"], .number(7))
    }

    func testSuggestionNamesAndLoadsQuickRows() throws {
        let entry = PlanEntryData(id: "p1", date: "2026-09-16", windowName: "Dinner", status: .planned)
        let items = [
            PlanItemData(id: "i1", planEntryId: "p1", refType: .food, refId: "rice", amount: 100, unit: "g", position: 0),
            PlanItemData(id: "i2", planEntryId: "p1", refType: .quick, refId: "i2", amount: 7, unit: Units.quick, position: 1,
                         label: "Ranch & salad"),
        ]
        let suggestion = try XCTUnwrap(PlanSuggestion.make(entry: entry, items: items, catalog: catalog, dismissed: []))
        XCTAssertEqual(suggestion.itemNames, ["Rice", "Ranch & salad"])
        XCTAssertEqual(suggestion.carbs.carbsG, 35.2, accuracy: 0.001)
        let lines = PlanSuggestion.lines(for: items, catalog: catalog, newLineId: { "line" })
        XCTAssertEqual(lines[1].refType, .quick)
        XCTAssertEqual(lines[1].label, "Ranch & salad")
        XCTAssertEqual(lines[1].displayName, "Ranch & salad")
        XCTAssertEqual(lines[1].unit, Units.quick)
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `ios/scripts/swift-test.sh CarbBookKit --filter QuickCarbsKitTests`
Expected: build FAILS — `cannot find 'QuickCarbsInput' in scope`, `cannot find 'itemDisplayName' in scope`, `extra argument 'label' in call` (DraftItem), `type 'PlanEditing' has no member 'dayTotalText'`, and `switch must be exhaustive` in `PlanSuggestion.swift`.

- [ ] **Step 3: Write minimal implementation**

`CalculatorInputs.swift` — replace the tail of `AmountInput`, from the line `    /// True when any line's amount came from invalid text; saving or logging must be blocked.` down to and including the `}` that closes `public enum AmountInput` (just above `// MARK: - Taken dose`), with:

```swift
    /// True when any line's amount came from invalid text; saving or logging must be blocked.
    /// Quick carbs rows must also be inside the dose limit (quick-carbs spec §2: fail closed).
    public static func hasInvalidAmount(_ lines: [CalculatorLine]) -> Bool {
        lines.contains { isInvalid(amount: $0.amount, refType: $0.refType) }
    }

    /// An equality key for `onChange`: compares amounts by bit pattern so a NaN amount equals itself.
    public static func changeKey(_ lines: [CalculatorLine]) -> [String] {
        lines.map { "\($0.id)|\($0.refType.rawValue)|\($0.refId)|\($0.amount.bitPattern)|\($0.unit)" }
    }

    public static func hasInvalidAmount(_ items: [MealItemData]) -> Bool {
        items.contains { isInvalid(amount: $0.amount, refType: $0.refType) }
    }

    static func isInvalid(amount: Double, refType: RefType) -> Bool {
        !amount.isFinite || amount < 0 || (refType == .quick && !isValidQuickCarbs(amount))
    }
}

// MARK: - Quick carbs rows

/// "+ Carbs" rows (quick-carbs spec §2): grams of carbs typed as a plain decimal — never a fraction —
/// within `DoseLimits.maxCarbsG`. Invalid text maps to NaN so the row is incomplete and saving is blocked.
public enum QuickCarbsInput {
    public static let invalidMessage = "Enter grams of carbs (0–2000)"

    public static func parse(_ text: String) -> Double? {
        guard let value = NumberParsing.parseNonNegative(text), isValidQuickCarbs(value) else { return nil }
        return value
    }

    public static func modelAmount(_ text: String) -> Double { parse(text) ?? .nan }

    public static func isInvalid(_ text: String) -> Bool { parse(text) == nil }

    /// "Ranch & salad — 7 g carbs".
    public static func rowText(label: String?, amount: Double) -> String {
        let grams = isValidQuickCarbs(amount) ? "\(formatCarbs(amount)) g carbs" : "enter grams of carbs"
        return "\(quickDisplayName(label)) — \(grams)"
    }
}
```

(`changeKey` is unchanged; it is repeated only because it sits between the two overloads being replaced.)

Create `ios/CarbBookKit/Sources/CarbBookKit/ItemDisplay.swift`:

```swift
import CarbBookCore
import Foundation

/// Name for any item row — food, meal or quick carbs — shared by the Calculator, meal editor, plan
/// editor and plan grid so they cannot drift. A reference that has not synced yet reads "Unknown item".
public func itemDisplayName(_ refType: RefType, _ refId: Id, label: String?, catalog: Catalog) -> String {
    switch refType {
    case .food: catalog.food(refId)?.name ?? "Unknown item"
    case .meal: catalog.meal(refId)?.name ?? "Unknown item"
    case .quick: quickDisplayName(label)
    }
}

/// Units a row can use; an unresolved food or meal keeps its current unit so the picker still shows it.
public func itemUnits(_ refType: RefType, _ refId: Id, currentUnit: String, catalog: Catalog) -> [String] {
    switch refType {
    case .food: catalog.food(refId).map { foodUnits($0, catalog.portions(refId)) } ?? [currentUnit]
    case .meal: catalog.meal(refId).map { mealUnits($0) } ?? [currentUnit]
    case .quick: quickUnits()
    }
}
```

`FoodLabel.swift` — in `displayUnitName`'s `switch unit`, add `case Units.quick: return "g carbs"` after `case Units.serving: return "servings"`.

`PlanEditing.swift`:
- `DraftItem` becomes:

```swift
    public struct DraftItem: Equatable, Sendable, Identifiable {
        public var id: Id?
        public var refType: RefType
        public var refId: Id
        public var amount: Double
        public var unit: String
        /// Quick carbs rows only: the label as typed.
        public var label: String?

        public init(id: Id?, refType: RefType, refId: Id, amount: Double, unit: String, label: String? = nil) {
            self.id = id; self.refType = refType; self.refId = refId; self.amount = amount; self.unit = unit; self.label = label
        }
    }
```

- in `saveChanges`, the guard becomes `guard !draft.items.contains(where: { AmountInput.isInvalid(amount: $0.amount, refType: $0.refType) }) else { throw EditError.invalidAmount }` and the item record becomes:

```swift
            changes.append(try SyncChange.encode("plan_item", PlanItemData(
                id: id, planEntryId: entry.id, refType: item.refType,
                refId: itemRefId(item.refType, item.refId, rowId: id),
                amount: item.amount, unit: item.unit, position: position,
                label: item.refType == .quick ? normalizeQuickLabel(item.label) : nil)))
```

- in `copyChanges`, the copied item becomes:

```swift
            for (offset, item) in sourceItems.enumerated() {
                let id = newId()
                let copied = PlanItemData(id: id, planEntryId: entryId, refType: item.refType,
                                          refId: itemRefId(item.refType, item.refId, rowId: id),
                                          amount: item.amount, unit: item.unit, position: startPosition + offset,
                                          label: item.label)
                changes.append(try SyncChange.encode("plan_item", copied))
                written.append(copied)
            }
```

- add after `carbs(_:catalog:)`:

```swift
    /// The Plan screen's day total: plain grams, never goal-coloured (quick-carbs spec §3).
    public static func dayTotalText(_ carbs: CarbResult) -> String {
        carbs.complete && carbs.carbsG.isFinite ? "\(formatCarbs(carbs.carbsG)) g" : "missing data"
    }
```

`PlanSuggestion.swift` — `lines(for:catalog:newLineId:)` becomes:

```swift
    public static func lines(for items: [PlanItemData], catalog: Catalog, newLineId: () -> String) -> [CalculatorLine] {
        items.map { item in
            CalculatorLine(id: newLineId(), refType: item.refType, refId: item.refId,
                           displayName: displayName(item, catalog: catalog), amount: item.amount, unit: item.unit,
                           label: item.label)
        }
    }
```

and `displayName` becomes:

```swift
    private static func displayName(_ item: PlanItemData, catalog: Catalog) -> String {
        itemDisplayName(item.refType, item.refId, label: item.label, catalog: catalog)
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `ios/scripts/swift-test.sh CarbBookKit`
Expected: `Executed <N> tests, with 0 failures`.

- [ ] **Step 5: Commit**

```bash
git add ios/CarbBookKit
git commit -m "ios kit: quick carbs input, names, plan editing and suggestions"
```

### Task 19: iOS app — "+ Carbs" sheet, quick row, Calculator

**Files:**
- Create: `ios/CarbBook/Calculator/QuickCarbsSheet.swift`
- Modify: `ios/CarbBook/Calculator/CalculatorModel.swift:141-147` (`units(for:)`), after `addFood` (new `addQuick`)
- Modify: `ios/CarbBook/Calculator/CalculatorView.swift:8-12` (state), `:22-37` (sheets), `:87-97` (rows + buttons)

- [ ] **Step 1: Create the shared sheet and row**

Create `ios/CarbBook/Calculator/QuickCarbsSheet.swift`:

```swift
import CarbBookCore
import CarbBookKit
import SwiftUI

/// "+ Carbs" (quick-carbs spec §2): grams of carbs with an optional label, no food needed.
/// Used by the Calculator, the meal editor and the plan slot editor.
struct QuickCarbsSheet: View {
    @Environment(\.dismiss) private var dismiss
    /// Label (normalized, nil when blank) and grams of carbs (already validated).
    let onAdd: (String?, Double) -> Void
    @State private var label = ""
    @State private var gramsText = ""

    private var grams: Double? { QuickCarbsInput.parse(gramsText) }

    var body: some View {
        NavigationStack {
            Form {
                TextField("Label (optional, e.g. ranch & salad)", text: $label)
                NumberField(label: "Carbs", text: $gramsText, unit: "g")
                if !gramsText.isEmpty && grams == nil {
                    Text(QuickCarbsInput.invalidMessage).font(.caption).foregroundStyle(.red)
                }
            }
            .navigationTitle("Add carbs")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add") {
                        guard let grams else { return }
                        onAdd(normalizeQuickLabel(label), grams)
                        dismiss()
                    }
                    .disabled(grams == nil)
                }
            }
        }
    }
}

/// An editable quick carbs row: "label — N g carbs", a label field and a grams field. Invalid or empty
/// grams set the amount to NaN, so the row is incomplete, no dose is shown and saving is blocked.
struct QuickCarbsRow: View {
    @Binding var label: String
    @Binding var amount: Double
    let carbs: CarbResult
    @State private var gramsText: String

    init(label: Binding<String>, amount: Binding<Double>, carbs: CarbResult) {
        _label = label
        _amount = amount
        self.carbs = carbs
        _gramsText = State(initialValue: AmountInput.text(for: amount.wrappedValue))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(QuickCarbsInput.rowText(label: label, amount: amount)).lineLimit(2)
                Spacer()
                Text(carbs.complete ? "\(formatNumber(carbs.carbsG))g" : "missing data")
                    .foregroundStyle(carbs.complete ? Color.primary : Color.orange)
                    .monospacedDigit()
            }
            HStack {
                TextField("Label (optional)", text: $label)
                    .padding(6)
                    .background(Theme.fieldBackground)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                TextField("g", text: $gramsText)
                    .keyboardType(.decimalPad)
                    .multilineTextAlignment(.trailing)
                    .padding(6)
                    .background(Theme.fieldBackground)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .frame(maxWidth: 90)
                    .onChange(of: gramsText) { _, text in amount = QuickCarbsInput.modelAmount(text) }
                Text("g carbs").font(.caption).foregroundStyle(.secondary)
            }
            if QuickCarbsInput.isInvalid(gramsText) {
                Text(QuickCarbsInput.invalidMessage).font(.caption).foregroundStyle(.red)
            }
        }
    }
}
```

- [ ] **Step 2: Wire the Calculator**

`CalculatorModel.swift` — replace `units(for:)` with:

```swift
    func units(for line: CalculatorLine) -> [String] {
        itemUnits(line.refType, line.refId, currentUnit: line.unit, catalog: catalog)
    }
```

and add after `addFood(id:name:)`:

```swift
    /// "+ Carbs": a carbs-only row. Its ref_id is set to the stored row's id when it is logged or saved.
    func addQuick(label: String?, grams: Double) {
        lines.append(CalculatorLine(id: UUID().uuidString, refType: .quick, refId: "", displayName: quickDisplayName(label),
                                    amount: grams, unit: Units.quick, label: label))
    }
```

`CalculatorView.swift`:
1. Add `@State private var showQuick = false` after `@State private var showSaveMeal = false`.
2. After the `.sheet(isPresented: $showSaveMeal) { … }` modifier add:

```swift
            .sheet(isPresented: $showQuick) {
                QuickCarbsSheet { label, grams in
                    model.addQuick(label: label, grams: grams)
                    model.recompute(app)
                }
            }
```

3. Replace the `ForEach($model.lines) { … }` block and the `HStack` of buttons below it with:

```swift
            ForEach($model.lines) { $line in
                if line.refType == .quick {
                    QuickCarbsRow(label: Binding(get: { $line.wrappedValue.label ?? "" },
                                                 set: { $line.wrappedValue.label = $0 }),
                                  amount: $line.amount, carbs: model.carbs(for: line))
                } else {
                    LineRow(line: $line, units: model.units(for: line), portions: model.catalog.portions(line.refId),
                            carbs: model.carbs(for: line))
                }
            }
            .onDelete { model.lines.remove(atOffsets: $0) }
            HStack {
                Button { showAdd = true } label: { Label("Add food or meal", systemImage: "plus.circle") }
                Spacer()
                Button("+ Carbs") { showQuick = true }
                Spacer()
                Button { showScanner = true } label: { Label("Scan", systemImage: "barcode.viewfinder") }
            }
            .buttonStyle(.borderless)
```

(`logIt` needs no change: `AmountInput.hasInvalidAmount` now rejects invalid quick rows, and `buildLogRecords` snapshots the label. `saveMeal` uses `buildMealRecords`, which stores the label.)

- [ ] **Step 3: Check the packages still pass**

Run: `ios/scripts/swift-test.sh CarbBookKit`
Expected: `Executed <N> tests, with 0 failures` (the app target itself is compiled in Task 22).

- [ ] **Step 4: Commit**

```bash
git add ios/CarbBook/Calculator
git commit -m "ios: + Carbs rows in the Calculator"
```

### Task 20: iOS app — meal editor and plan slot editor

**Files:**
- Modify: `ios/CarbBook/Meals/MealEditorView.swift:23-26` (state), `:62-72` (section/sheet), `:80-114` (`componentRow`), new `addQuick`, `:170-180` (`save`)
- Modify: `ios/CarbBook/Plan/PlanSlotEditorView.swift:13-19` (state), `:24-33` (rows/buttons), `:38-40` (sheet), `:69-82` (`displayName`, `units`), `:84-90` (`load`), `:120-125` (`save`)

- [ ] **Step 1: Meal editor**

In `MealEditorView.swift`:

1. Add `@State private var showQuick = false` after `@State private var showAdd = false`.
2. In `Section("Components")`, after `Button("Add component") { showAdd = true }` add `Button("+ Carbs") { showQuick = true }`.
3. After `.sheet(isPresented: $showAdd) { AddItemSheet { hit in add(hit) } }` add:

```swift
        .sheet(isPresented: $showQuick) {
            QuickCarbsSheet { label, grams in addQuick(label: label, grams: grams) }
        }
```

4. Replace the whole `private func componentRow(_ item: Binding<MealItemData>, catalog: InMemoryCatalog) -> some View { … }` with:

```swift
    @ViewBuilder
    private func componentRow(_ item: Binding<MealItemData>, catalog: InMemoryCatalog) -> some View {
        let value = item.wrappedValue
        let carbs = itemCarbs(catalog, value.refType, value.refId, value.amount, value.unit)
        if value.refType == .quick {
            QuickCarbsRow(label: Binding(get: { item.wrappedValue.label ?? "" }, set: { item.wrappedValue.label = $0 }),
                          amount: item.amount, carbs: carbs)
        } else {
            foodOrMealRow(item, catalog: catalog, carbs: carbs)
        }
    }

    private func foodOrMealRow(_ item: Binding<MealItemData>, catalog: InMemoryCatalog, carbs: CarbResult) -> some View {
        let value = item.wrappedValue
        let units = itemUnits(value.refType, value.refId, currentUnit: value.unit, catalog: catalog)
        let amountText = amountTexts[value.id] ?? AmountInput.text(for: value.amount)
        let amountBinding = Binding<String>(
            get: { amountText },
            set: { text in
                amountTexts[value.id] = text
                item.wrappedValue.amount = AmountInput.modelAmount(text)
            })
        return VStack(alignment: .leading) {
            HStack {
                Text(itemDisplayName(value.refType, value.refId, label: nil, catalog: catalog))
                Spacer()
                Text(carbs.complete ? "\(formatNumber(carbs.carbsG))g" : "missing data")
                    .foregroundStyle(carbs.complete ? Color.primary : Color.orange)
            }
            HStack {
                TextField("e.g. 2/3", text: amountBinding)
                    .keyboardType(.numbersAndPunctuation)
                    .frame(maxWidth: 110)
                UnitPicker(unit: item.unit, units: units, portions: value.refType == .food ? catalog.portions(value.refId) : [])
            }
            if AmountInput.isInvalid(amountText) {
                Text(AmountInput.invalidMessage).font(.caption).foregroundStyle(.red)
            }
        }
    }

    /// "+ Carbs": a quick component that points at itself (quick-carbs spec §2).
    private func addQuick(label: String?, grams: Double) {
        let id = app.store.newId()
        items.append(MealItemData(id: id, mealId: mealId, refType: .quick, refId: id, amount: grams,
                                  unit: Units.quick, position: items.count, label: label))
        error = nil
    }
```

5. In `save()`, inside the `for (index, item) in items.enumerated()` loop, after `positioned.deleted = nil` add:

```swift
                positioned.label = positioned.refType == .quick ? normalizeQuickLabel(positioned.label) : nil
```

(`save()` already refuses invalid amounts through `AmountInput.hasInvalidAmount(items)`, which now includes the quick range.)

- [ ] **Step 2: Plan slot editor**

In `PlanSlotEditorView.swift`:

1. Add `@State private var showQuick = false` after `@State private var showAdd = false`.
2. Replace the `ForEach($items) { … }` + `.onDelete` + add `Button` inside the first `Section` with:

```swift
                    ForEach($items) { $item in
                        if item.refType == .quick {
                            QuickCarbsRow(label: Binding(get: { $item.wrappedValue.label ?? "" },
                                                         set: { $item.wrappedValue.label = $0 }),
                                          amount: $item.amount,
                                          carbs: itemCarbs(catalog, item.refType, item.refId, item.amount, item.unit))
                        } else {
                            PlanItemRow(item: $item, name: displayName(item), units: units(for: item),
                                        portions: catalog.portions(item.refId),
                                        carbs: itemCarbs(catalog, item.refType, item.refId, item.amount, item.unit))
                        }
                    }
                    .onDelete { items.remove(atOffsets: $0) }
                    HStack {
                        Button { showAdd = true } label: { Label("Add food or meal", systemImage: "plus.circle") }
                        Spacer()
                        Button("+ Carbs") { showQuick = true }
                    }
                    .buttonStyle(.borderless)
```

3. After `.sheet(isPresented: $showAdd) { AddItemSheet { hit in add(hit) } }` add:

```swift
            .sheet(isPresented: $showQuick) {
                QuickCarbsSheet { label, grams in
                    items.append(PlanEditing.DraftItem(id: nil, refType: .quick, refId: "", amount: grams,
                                                       unit: Units.quick, label: label))
                }
            }
```

4. Replace `displayName(_:)` and `units(for:)` with:

```swift
    /// Plans never snapshot a display name, so it is resolved live from the catalog.
    private func displayName(_ item: PlanEditing.DraftItem) -> String {
        itemDisplayName(item.refType, item.refId, label: item.label, catalog: catalog)
    }

    private func units(for item: PlanEditing.DraftItem) -> [String] {
        itemUnits(item.refType, item.refId, currentUnit: item.unit, catalog: catalog)
    }
```

5. In `load()`, the mapping becomes:

```swift
        items = slot.items.map {
            PlanEditing.DraftItem(id: $0.id, refType: $0.refType, refId: $0.refId, amount: $0.amount, unit: $0.unit,
                                  label: $0.label)
        }
```

6. In `save()`, the guard becomes:

```swift
        guard !items.contains(where: { !$0.amount.isFinite || $0.amount < 0 || ($0.refType == .quick && !isValidQuickCarbs($0.amount)) }) else {
            error = PlanEditing.EditError.invalidAmount.message
            return
        }
```

- [ ] **Step 3: Check the packages still pass**

Run: `ios/scripts/swift-test.sh CarbBookKit`
Expected: `Executed <N> tests, with 0 failures`.

- [ ] **Step 4: Commit**

```bash
git add ios/CarbBook/Meals ios/CarbBook/Plan/PlanSlotEditorView.swift
git commit -m "ios: + Carbs rows in the meal and plan slot editors"
```

### Task 21: iOS app — plain day totals and quick names on the Plan grid

**Files:**
- Modify: `ios/CarbBook/Plan/PlanWeekView.swift:64-76` (`dayHeader`), `:112-119` (`itemsText`)
- Modify: `ios/CarbBook/Plan/PlanModel.swift:65-70`

- [ ] **Step 1: Make the edits**

`PlanWeekView.swift` — replace `dayHeader(_:)` with:

```swift
    private func dayHeader(_ date: String) -> some View {
        HStack {
            Text(PlanDate.date(date).map { $0.formatted(.dateTime.weekday(.abbreviated).month().day()) } ?? date)
            Spacer()
            // Goals are per meal/snack only: the day total is plain grams with no colour (quick-carbs spec §3).
            Text(PlanEditing.dayTotalText(model.dayCarbs(date)))
                .font(.caption)
                .monospacedDigit()
                .foregroundStyle(.secondary)
            Button { copyScope = .day(date) } label: { Image(systemName: "doc.on.doc") }
                .buttonStyle(.borderless)
                .accessibilityLabel("Copy \(date) to another day")
        }
    }
```

and `itemsText(_:)` with:

```swift
    private func itemsText(_ slot: PlanSlot) -> String {
        slot.items
            .map { itemDisplayName($0.refType, $0.refId, label: $0.label, catalog: model.catalog) }
            .joined(separator: ", ")
    }
```

`PlanModel.swift` — replace

```swift
    /// Carbs planned for a whole day, against that day's summed window goals.
    func dayCarbs(_ date: String) -> CarbResult {
        sumCarbs(windows.map { slot(date: date, window: $0).carbs })
    }

    func dayGoalFor(_ date: String) -> CarbGoal? { dayGoal(windows) }
```

with

```swift
    /// Carbs planned for a whole day (no day goal: goals are per meal/snack only).
    func dayCarbs(_ date: String) -> CarbResult {
        sumCarbs(windows.map { slot(date: date, window: $0).carbs })
    }
```

- [ ] **Step 2: Verify no app code still uses a day goal or an exhaustive two-case RefType switch**

Run: `grep -rn "dayGoal\|case \.meal: catalog\.meal\|case \.meal: model\.catalog" ios/CarbBook`
Expected: no output. (`dayGoal` remains in `CarbBookCore` for its vectors only.)

Run: `grep -rn "switch .*refType" ios/CarbBook ios/CarbBookKit/Sources ios/CarbBookCore/Sources`
Expected: only `Carbs.swift`, `LogRecalc.swift` and `ItemDisplay.swift`, each with a `.quick` case.

- [ ] **Step 3: Commit**

```bash
git add ios/CarbBook/Plan
git commit -m "ios: plain-gram day totals and quick row names on the Plan grid"
```

### Task 22: Version 0.2.1 and macOS CI build

**Files:**
- Modify: `ios/project.yml:37`

- [ ] **Step 1: Bump the marketing version**

In `ios/project.yml` change `MARKETING_VERSION: "0.2.0"` to `MARKETING_VERSION: "0.2.1"`.

Run: `ios/scripts/version.sh`
Expected: `0.2.1`

- [ ] **Step 2: Full local verification**

Run: `ios/scripts/sync-testdata.sh --check && ios/scripts/swift-test.sh CarbBookCore && ios/scripts/swift-test.sh CarbBookKit && pnpm -r typecheck && pnpm -r test`
Expected: `testdata vectors in sync`; both Swift packages `with 0 failures`; all TS packages 0 failed.

- [ ] **Step 3: Commit, push and open the PR**

```bash
git add ios/project.yml
git commit -m "ios: bump marketing version to 0.2.1 for quick carbs"
git push -u origin feat/quick-carbs
gh pr create --base main --head feat/quick-carbs \
  --title "Quick carbs rows + per-meal-only goals" \
  --body "Implements docs/superpowers/specs/2026-09-16-quick-carbs-design.md (plan: docs/superpowers/plans/2026-09-16-quick-carbs.md). Server migration 005, web and iOS 0.2.1 + Carbs rows, plain-gram day totals. iOS 0.2.0 cannot decode quick rows: merge only together with the server/web deploy (Task 23).

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

- [ ] **Step 4: Watch CI**

Run: `gh pr checks --watch --fail-fast`
Expected: every check passes — `build` (build-ipa: macOS package tests + unsigned `.app` build), `testdata-copies`, `core-linux`, `kit-linux`, `core-macos`.
If `build` fails, read the Swift diagnostics printed by the workflow (`gh run view <run-id> --log-failed | grep -E "error:" | head -40`), fix the view code, commit, push, and watch again. Do not merge until all checks are green.

- [ ] **Step 5: Request review**

Use superpowers:requesting-code-review on the whole PR diff (focus: fail-closed quick amounts on every save path, migration 005, label push semantics for old clients, iOS view compile safety). Fix findings on the branch and re-run Step 4.

### Task 23: Ship together — deploy server/web and release iOS 0.2.1

- [ ] **Step 1: Back up the live database and record the pre-deploy counts**

```bash
ssh pi sudo systemctl start carbbook-backup.service
ssh pi 'ls -t /opt/carbbook/backups | head -1'
ssh pi 'docker exec carbs-server sqlite3 -readonly /data/carbbook.db "PRAGMA user_version; SELECT (SELECT count(*) FROM meal_item) || \"/\" || (SELECT count(*) FROM log_item) || \"/\" || (SELECT count(*) FROM plan_item);"'
```

Expected: a fresh `carbbook-YYYYmmdd-HHMMSS.db.gz` (write its name down — it is the rollback point), then `4` and `<meal_items>/<log_items>/<plan_items>`.

- [ ] **Step 2: Merge and update the main checkout**

```bash
gh pr merge feat/quick-carbs --merge
git -C ~/Projects/CarbBook switch main
git -C ~/Projects/CarbBook pull --ff-only
git -C ~/Projects/CarbBook log --oneline -1
```

Expected: the merge commit is at the top. (This push to `main` starts `release.yml` because it touches `ios/`.)

- [ ] **Step 3: Deploy the server + web**

Run: `cd ~/Projects/CarbBook && deploy/deploy.sh`
Expected: ends with `carbs-server healthy (tag <12-char sha>, previous <old tag>)` and `Pi disk free: …`. Migration 005 runs on container start.

- [ ] **Step 4: Verify the live server**

```bash
ssh pi 'docker exec carbs-server sqlite3 -readonly /data/carbbook.db "PRAGMA user_version; PRAGMA integrity_check; SELECT (SELECT count(*) FROM meal_item) || \"/\" || (SELECT count(*) FROM log_item) || \"/\" || (SELECT count(*) FROM plan_item); SELECT name FROM pragma_table_info(\"plan_item\") WHERE name = \"label\";"'
curl -s -o /dev/null -w '%{http_code}\n' https://recipes.dxshdw.dev/api/health
ssh pi 'docker logs --tail 20 carbs-server'
```

Expected: `5`, `ok`, the same counts as Step 1, `label`, then `200`, and no error lines in the log tail.
If anything is off: roll back per `deploy/README.md` (previous tag; restore the Step 1 backup only if data changed) and stop.

- [ ] **Step 5: Watch the iOS release**

```bash
gh run list --workflow release.yml --branch main --limit 1
gh run watch "$(gh run list --workflow release.yml --branch main --limit 1 --json databaseId -q '.[0].databaseId')" --exit-status
gh release list --limit 1
```

Expected: the run succeeds and the newest release is `CarbBook v0.2.1-build<N>` with assets `CarbBook-0.2.1-build<N>.ipa` and `icon.png`.

- [ ] **Step 6: Verify ipa-hub serves it**

`ipa-sync.timer` runs every 5 minutes on the desktop. After it fires:

```bash
curl -s https://ipa.dxshdw.dev/source.json | python3 -c "import sys, json; a = next(x for x in json.load(sys.stdin)['apps'] if x['bundleIdentifier'] == 'dev.dxshdw.carbbook'); v = a['versions'][0]; print(v['version'], v['downloadURL'])"
curl -sI "$(curl -s https://ipa.dxshdw.dev/source.json | python3 -c "import sys, json; print(next(x for x in json.load(sys.stdin)['apps'] if x['bundleIdentifier'] == 'dev.dxshdw.carbbook')['versions'][0]['downloadURL'])")" | head -1
```

Expected: `0.2.1 https://ipa.dxshdw.dev/carbbook/CarbBook-0.2.1-build<N>.ipa` and `HTTP/2 200`. If still `0.2.0` after 10 minutes: `systemctl --user start ipa-sync.service && journalctl --user -u ipa-sync.service -n 30`.

- [ ] **Step 7: Tell the user, then wait**

Tell the user: web is live with **+ Carbs** and plain day totals; update the iPhone app to 0.2.1 in LiveContainer **before** anyone adds quick carbs (0.2.0 cannot read those rows); Part E (tonight's dinner fix + plan backfill) runs once they confirm the phone shows 0.2.1.

- [ ] **Step 8: Clean up the worktree**

```bash
git -C ~/Projects/CarbBook worktree remove ~/Projects/CarbBook-quick-carbs
git -C ~/Projects/CarbBook branch -d feat/quick-carbs
git -C ~/Projects/CarbBook push origin --delete feat/quick-carbs
```

---

# Part E — Live data fixes (after Task 23, and only once the user confirms iPhone 0.2.1)

All writes go through `applyPush(db, 'owner', …)` — the same validation, last-write-wins and `server_seq` path a device push uses — from inside the `carbs-server` container, after a fresh backup. `sbruschke` is checked to be the owner account; `applyPush` itself only takes the role. The script is dry-run by default, aborts on anything that does not look exactly like the expected data, never edits a log to match a plan, and is idempotent.

### Task 24: Data-fix script + rehearsal on a live snapshot

**Files:**
- Create: `deploy/data-fixes/2026-09-16-quick-carbs.mts`

- [ ] **Step 1: Write the script**

Create `deploy/data-fixes/2026-09-16-quick-carbs.mts` with exactly:

```ts
// One-off data fix for the quick-carbs release (docs/superpowers/specs/2026-09-16-quick-carbs-design.md §4).
// Every write goes through the server's own push path (applyPush as the owner role), so sync
// validation, last-write-wins and server_seq all apply exactly as for a device push.
//
//   node --import tsx 2026-09-16-quick-carbs.mts            # dry run: prints the plan, writes nothing
//   node --import tsx 2026-09-16-quick-carbs.mts --apply    # writes, then verifies
//
// Env: CARBBOOK_APP (default /app, the image layout), DATABASE_PATH (set in the container).
// Run with the working directory at <app>/server so `--import tsx` resolves.
import { randomUUID } from 'node:crypto';

const APP = process.env.CARBBOOK_APP ?? '/app';
const DB_PATH = process.env.DATABASE_PATH ?? '/data/carbbook.db';
const APPLY = process.argv.includes('--apply');
const TZ = 'America/Chicago';
const OWNER = 'sbruschke';
const DEVICE = 'admin-quick-carbs-2026-09-16';
const TOLERANCE_G = 0.01;

const { openDb } = await import(`${APP}/server/src/db.ts`);
const { applyPush } = await import(`${APP}/server/src/sync/push.ts`);
const core = await import(`${APP}/packages/core/src/index.ts`);

type Row = Record<string, any>;
type Change = { table: string; record: Row };

const db = openDb(DB_PATH);
const version = db.pragma('user_version', { simple: true }) as number;
if (version < 5) throw new Error(`user_version is ${version}; deploy migration 005 first`);
const owner = db.prepare('SELECT role FROM user WHERE username = ?').get(OWNER) as { role: string } | undefined;
if (owner?.role !== 'owner') throw new Error(`${OWNER} is not an owner account (found ${owner?.role ?? 'nothing'})`);

const day = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const localDate = (ms: number): string => day.format(new Date(ms)); // "YYYY-MM-DD"
const localTime = (ms: number): string =>
  new Date(ms).toLocaleString('en-US', { timeZone: TZ, hour12: false, dateStyle: 'short', timeStyle: 'medium' });

let clock = Date.now();
/** Strictly increasing updated_at, always newer than the stored row (last-write-wins). */
const stamp = (stored?: Row): number => {
  clock = Math.max(clock + 1, (stored?.updated_at ?? 0) + 1);
  return clock;
};
const meta = (stored?: Row) => ({ updated_at: stamp(stored), updated_by: DEVICE, deleted: 0 });
const withoutSeq = (row: Row): Row => {
  const { server_seq: _seq, ...rest } = row;
  return rest;
};

function catalog() {
  const live = (table: string) => db.prepare(`SELECT * FROM ${table} WHERE deleted = 0`).all() as Row[];
  return core.createCatalog({ foods: live('food'), portions: live('portion'), meals: live('meal'), meal_items: live('meal_item') });
}

function push(label: string, changes: Change[]): void {
  console.log(`\n${label}: ${changes.length} change(s)`);
  for (const c of changes) console.log(`  ${c.table} ${c.record.id} ${JSON.stringify(withoutSeq(c.record))}`);
  if (!APPLY || changes.length === 0) return;
  // One outer transaction: any non-accepted record rolls back the whole step.
  db.transaction(() => {
    const results = applyPush(db, 'owner', changes) as { status: string; id: string | null; message?: string }[];
    const bad = results.filter((r) => r.status !== 'accepted');
    if (bad.length > 0) throw new Error(`${label}: push not accepted: ${JSON.stringify(bad)}`);
  })();
  console.log(`  applied`);
}

// ---- 1. Tonight's dinner: 4.3 taquitos (73.1 g) → 4 taquitos (68 g) + "Ranch & salad" 7 g = 75 g ----
function dinnerFix(): Change[] {
  const from = Date.parse('2026-09-16T23:02:00Z'); // 18:02 CDT
  const to = Date.parse('2026-09-16T23:03:00Z');
  const entries = db
    .prepare(`SELECT * FROM log_entry WHERE deleted = 0 AND window_name = 'Dinner' AND eaten_at >= ? AND eaten_at < ?`)
    .all(from, to) as Row[];
  if (entries.length !== 1) throw new Error(`expected 1 dinner entry at 18:02 CDT, found ${entries.length}`);
  const entry = entries[0]!;
  console.log(`dinner entry ${entry.id} at ${localTime(entry.eaten_at)}: total ${entry.total_carbs_g}, suggested ${entry.suggested_units}, taken ${entry.taken_units}`);
  const items = db.prepare('SELECT * FROM log_item WHERE deleted = 0 AND log_entry_id = ? ORDER BY rowid').all(entry.id) as Row[];

  const already = items.length === 2 && items.some((i) => i.ref_type === 'quick') && entry.total_carbs_g === 75;
  if (already) {
    console.log('dinner already fixed; skipping');
    return [];
  }
  if (entry.suggested_units !== 9 || entry.taken_units !== 9) throw new Error('dinner units are not 9/9; stop and ask');
  if (items.length !== 1) throw new Error(`expected 1 dinner item, found ${items.length}`);
  const taquito = items[0]!;
  const looksRight =
    taquito.ref_type === 'food' &&
    /taquito/i.test(taquito.display_name) &&
    Math.abs(taquito.amount - 4.3) < 1e-9 &&
    String(taquito.unit).startsWith('p:') &&
    Math.abs(taquito.carbs_g - 73.1) < TOLERANCE_G &&
    Math.abs(entry.total_carbs_g - 73.1) < TOLERANCE_G;
  if (!looksRight) throw new Error(`dinner item is not "4.3 taquitos = 73.1 g": ${JSON.stringify(taquito)}`);

  const four = core.itemCarbs(catalog(), 'food', taquito.ref_id, 4, taquito.unit);
  if (!four.complete || Math.abs(four.carbs_g - 68) > TOLERANCE_G) {
    throw new Error(`4 taquitos should be 68 g now, core says ${JSON.stringify(four)}`);
  }
  const quickId = randomUUID();
  const quick = {
    id: quickId,
    log_entry_id: entry.id,
    ref_type: 'quick',
    ref_id: quickId,
    display_name: 'Ranch & salad',
    amount: 7,
    unit: core.QUICK_UNIT,
    carbs_g: 7,
  };
  return [
    { table: 'log_item', record: { ...withoutSeq(taquito), amount: 4, carbs_g: four.carbs_g, ...meta(taquito) } },
    { table: 'log_item', record: { ...quick, ...meta() } },
    // Only the total changes: suggested_units and taken_units stay 9 (what was shown and taken).
    { table: 'log_entry', record: { ...withoutSeq(entry), total_carbs_g: four.carbs_g + 7, ...meta(entry) } },
  ];
}

// ---- 2. Backfill plan slots from every live log entry ----
function backfill(): { changes: Change[]; skipped: string[] } {
  const entries = db.prepare('SELECT * FROM log_entry WHERE deleted = 0 ORDER BY eaten_at, id').all() as Row[];
  const liveSlot = db.prepare(
    'SELECT id FROM plan_entry WHERE deleted = 0 AND date = ? AND window_name = ? COLLATE NOCASE',
  );
  const linked = db.prepare('SELECT id FROM plan_entry WHERE deleted = 0 AND log_entry_id = ?');
  const itemsOf = db.prepare('SELECT * FROM log_item WHERE deleted = 0 AND log_entry_id = ? ORDER BY rowid');
  const claimed = new Set<string>();
  const changes: Change[] = [];
  const skipped: string[] = [];
  for (const entry of entries) {
    const when = `${localTime(entry.eaten_at)} ${entry.window_name ?? '(no window)'}`;
    if (!entry.window_name) {
      skipped.push(`${entry.id} ${when}: no window`);
      continue;
    }
    const date = localDate(entry.eaten_at);
    const key = `${date}|${String(entry.window_name).trim().toLowerCase()}`;
    if (liveSlot.get(date, String(entry.window_name).trim()) || claimed.has(key)) {
      skipped.push(`${entry.id} ${when}: slot ${date} ${entry.window_name} already has a live plan entry`);
      continue;
    }
    if (linked.get(entry.id)) {
      skipped.push(`${entry.id} ${when}: already linked to a plan entry`);
      continue;
    }
    claimed.add(key);
    const planId = randomUUID();
    changes.push({
      table: 'plan_entry',
      record: {
        id: planId,
        date,
        window_name: entry.window_name,
        status: 'logged',
        note: null,
        log_entry_id: entry.id,
        ...meta(),
      },
    });
    (itemsOf.all(entry.id) as Row[]).forEach((item, position) => {
      const id = randomUUID();
      const quick = item.ref_type === 'quick';
      changes.push({
        table: 'plan_item',
        record: {
          id,
          plan_entry_id: planId,
          ref_type: item.ref_type,
          ref_id: core.itemRefId(item.ref_type, item.ref_id, id),
          amount: item.amount,
          unit: item.unit,
          position,
          label: quick ? core.normalizeQuickLabel(item.display_name === core.QUICK_DEFAULT_LABEL ? null : item.display_name) : null,
          ...meta(),
        },
      });
    });
  }
  return { changes, skipped };
}

// ---- 3. Verify ----
function verify(): number {
  const cat = catalog();
  const logged = db.prepare('SELECT * FROM log_entry WHERE deleted = 0 AND window_name IS NOT NULL').all() as Row[];
  const slots = db.prepare("SELECT * FROM plan_entry WHERE deleted = 0 AND status = 'logged' AND log_entry_id IS NOT NULL").all() as Row[];
  const itemsOf = db.prepare('SELECT * FROM plan_item WHERE deleted = 0 AND plan_entry_id = ? ORDER BY position');
  const nameOf = (i: Row): string =>
    i.ref_type === 'quick'
      ? core.quickDisplayName(i.label)
      : ((i.ref_type === 'food' ? cat.food(i.ref_id)?.name : cat.meal(i.ref_id)?.name) ?? `missing ${i.ref_id}`);
  console.log(`\nverify: ${logged.length} live log entries with a window, ${slots.length} logged plan slots`);
  let differences = 0;
  for (const entry of logged) {
    const slot = slots.find((s) => s.log_entry_id === entry.id);
    if (!slot) {
      console.log(`  NO SLOT  ${localTime(entry.eaten_at)} ${entry.window_name} (${entry.id})`);
      differences++;
      continue;
    }
    const items = itemsOf.all(slot.id) as Row[];
    const carbs = core.sumCarbs(items.map((i) => core.itemCarbs(cat, i.ref_type, i.ref_id, i.amount, i.unit)));
    const diff = carbs.carbs_g - entry.total_carbs_g;
    const ok = carbs.complete && Math.abs(diff) <= TOLERANCE_G;
    if (!ok) differences++;
    console.log(
      `  ${ok ? 'ok      ' : 'DIFFERS '} ${slot.date} ${slot.window_name}: plan ${carbs.carbs_g.toFixed(2)} g` +
        `${carbs.complete ? '' : ' (incomplete)'} vs log ${Number(entry.total_carbs_g).toFixed(2)} g` +
        `${ok ? '' : ` (diff ${diff.toFixed(2)} g; a food changed since logging — log left as is)`}` +
        ` · ${items.map((i) => `${i.amount} ${i.unit} ${nameOf(i)}`).join(', ')}`,
    );
  }
  return differences;
}

console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} on ${DB_PATH} (user_version ${version})`);
push('dinner fix', dinnerFix());
const plan = backfill();
for (const s of plan.skipped) console.log(`skip ${s}`);
push('plan backfill', plan.changes);
if (APPLY) {
  const differences = verify();
  console.log(differences === 0 ? '\nall slots match their log totals' : `\n${differences} slot(s) differ — report them, do not edit logs`);
}
db.close();
```

(An identical copy of this script was rehearsed while writing this plan against a read-only snapshot of the live DB taken 2026-09-16 ~18:35 CDT, migrated to v5 with the Task 4 SQL and the Task 1–5 code: dinner fix 3 changes; backfill 12 slots / 18 items including "Ranch & salad"; every slot matched its log total; a second `--apply` changed nothing.)

- [ ] **Step 2: Take a fresh read-only snapshot of the (now v5) live DB**

```bash
mkdir -p /tmp/carbbook-fix-rehearsal
ssh pi 'docker exec carbs-server sqlite3 -readonly /data/carbbook.db ".backup /tmp/rehearsal.db" && docker exec carbs-server cat /tmp/rehearsal.db && docker exec carbs-server rm /tmp/rehearsal.db' > /tmp/carbbook-fix-rehearsal/live.db
sqlite3 /tmp/carbbook-fix-rehearsal/live.db 'PRAGMA user_version; SELECT count(*) FROM log_entry WHERE deleted = 0; SELECT count(*) FROM plan_entry WHERE deleted = 0;'
```

Expected: `5`, the number of live log entries (12 when this plan was written, more if meals were logged since), and the number of live plan entries (0 unless someone planned since the deploy).

- [ ] **Step 3: Dry run on the snapshot**

```bash
cd ~/Projects/CarbBook/server
CARBBOOK_APP=$HOME/Projects/CarbBook DATABASE_PATH=/tmp/carbbook-fix-rehearsal/live.db \
  node --import tsx ../deploy/data-fixes/2026-09-16-quick-carbs.mts | grep -v '^  \(log_item\|log_entry\|plan_entry\|plan_item\) '
```

Expected (numbers grow with new log entries):

```
DRY RUN on /tmp/carbbook-fix-rehearsal/live.db (user_version 5)
dinner entry 01a0ac75-2c6b-7128-ab9f-4d8930778697 at 9/16/26, 18:02:35: total 73.1, suggested 9, taken 9

dinner fix: 3 change(s)

plan backfill: 29 change(s)
```

(29 in the dry run = 12 entries + 17 items: the dry run plans the backfill before the dinner fix is applied, so the dinner slot still shows only the taquito row.) Any `Error:` means the live data is not what the spec describes — stop and report it to the user instead of editing the script's checks.

- [ ] **Step 4: Apply on the snapshot, twice**

```bash
CARBBOOK_APP=$HOME/Projects/CarbBook DATABASE_PATH=/tmp/carbbook-fix-rehearsal/live.db \
  node --import tsx ../deploy/data-fixes/2026-09-16-quick-carbs.mts --apply | grep -v '^  \(log_item\|log_entry\|plan_entry\|plan_item\) '
CARBBOOK_APP=$HOME/Projects/CarbBook DATABASE_PATH=/tmp/carbbook-fix-rehearsal/live.db \
  node --import tsx ../deploy/data-fixes/2026-09-16-quick-carbs.mts --apply | tail -3
sqlite3 /tmp/carbbook-fix-rehearsal/live.db "SELECT display_name, amount, unit, carbs_g FROM log_item WHERE deleted = 0 AND log_entry_id = '01a0ac75-2c6b-7128-ab9f-4d8930778697' ORDER BY rowid; SELECT total_carbs_g, suggested_units, taken_units FROM log_entry WHERE id = '01a0ac75-2c6b-7128-ab9f-4d8930778697';"
```

Expected from the first run: `dinner fix: 3 change(s)` / `applied`, `plan backfill: 30 change(s)` / `applied`, then a `verify:` block with one `ok` line per live log entry, e.g.

```
verify: 12 live log entries with a window, 12 logged plan slots
  ok       2026-09-14 HS Snack: plan 50.00 g vs log 50.00 g · 1 p:… Rice Krispie Brownie
  …
  ok       2026-09-16 Dinner: plan 75.00 g vs log 75.00 g · 4 p:01a0ac6c-2f11-7e22-8c4b-97f9cf5c0683 Taquitos, 7 carbs Ranch & salad

all slots match their log totals
```

(The 2026-09-14 HS Snack was eaten 2026-09-14 21:07 CDT = 02:07 UTC on the 15th: its slot date must be the 14th.) `DIFFERS` lines are allowed — they mean a food changed after it was logged; note them for the user.
Expected from the second run: `dinner already fixed; skipping` earlier in the output, `plan backfill: 0 change(s)`, and the same `verify` block. The sqlite query prints `Taquitos|4.0|p:…|68.0`, `Ranch & salad|7.0|carbs|7.0`, then `75.0|9.0|9.0`.

- [ ] **Step 5: Clean up and commit**

```bash
rm -rf /tmp/carbbook-fix-rehearsal
cd ~/Projects/CarbBook
git add deploy/data-fixes/2026-09-16-quick-carbs.mts
git commit -m "deploy: data fix for quick carbs dinner + plan backfill"
git push origin main
```

(`deploy/` is excluded from the deploy rsync and `release.yml` ignores it, so this push neither rebuilds the server nor publishes an iOS release.)

### Task 25: Run the fix on the live Pi

- [ ] **Step 1: Gate**

Confirm both are true, otherwise stop and wait: (a) the user said the iPhone app shows 0.2.1; (b) `curl -s -o /dev/null -w '%{http_code}\n' https://recipes.dxshdw.dev/api/health` prints `200` and `ssh pi 'docker exec carbs-server sqlite3 -readonly /data/carbbook.db "PRAGMA user_version;"'` prints `5`.

- [ ] **Step 2: Back up**

```bash
ssh pi sudo systemctl start carbbook-backup.service
ssh pi 'ls -t /opt/carbbook/backups | head -1'
```

Expected: a new `carbbook-YYYYmmdd-HHMMSS.db.gz` with the current time. Write the name down: rollback is `ssh pi /opt/carbbook/bin/carbbook-restore.sh /opt/carbbook/backups/<that file>` (it also discards anything logged after the backup — ask the user before using it).

- [ ] **Step 3: Copy the script into the container and dry-run it**

```bash
cd ~/Projects/CarbBook
ssh pi 'docker exec -i carbs-server sh -c "cat > /tmp/quick-carbs-fix.mts"' < deploy/data-fixes/2026-09-16-quick-carbs.mts
ssh pi 'docker exec -w /app/server carbs-server node --import tsx /tmp/quick-carbs-fix.mts' | grep -v '^  \(log_item\|log_entry\|plan_entry\|plan_item\) '
```

Expected: `DRY RUN on /data/carbbook.db (user_version 5)`, the dinner line (`total 73.1, suggested 9, taken 9`), `dinner fix: 3 change(s)`, and the same backfill count as the Task 24 dry run (plus any entries logged since). Different skips or an `Error:` → stop and report.

- [ ] **Step 4: Apply**

```bash
ssh pi 'docker exec -w /app/server carbs-server node --import tsx /tmp/quick-carbs-fix.mts --apply' | grep -v '^  \(log_item\|log_entry\|plan_entry\|plan_item\) '
```

Expected: both steps `applied`, a `verify:` block with one line per live log entry, and `all slots match their log totals` (or `N slot(s) differ — report them, do not edit logs`). Save the whole output for the report.

- [ ] **Step 5: Re-run to prove idempotency, then read-only checks**

```bash
ssh pi 'docker exec -w /app/server carbs-server node --import tsx /tmp/quick-carbs-fix.mts --apply' | grep -E 'already fixed|plan backfill|all slots|differ'
ssh pi 'docker exec carbs-server sqlite3 -readonly /data/carbbook.db "
  SELECT display_name, amount, unit, carbs_g, ref_type FROM log_item WHERE deleted = 0 AND log_entry_id = (SELECT id FROM log_entry WHERE deleted = 0 AND window_name = \"Dinner\" AND eaten_at BETWEEN 1789599720000 AND 1789599779999) ORDER BY rowid;
  SELECT total_carbs_g, suggested_units, taken_units FROM log_entry WHERE deleted = 0 AND window_name = \"Dinner\" AND eaten_at BETWEEN 1789599720000 AND 1789599779999;
  SELECT (SELECT count(*) FROM log_entry WHERE deleted = 0 AND window_name IS NOT NULL) || \" log entries / \" || (SELECT count(*) FROM plan_entry WHERE deleted = 0 AND status = \"logged\" AND log_entry_id IS NOT NULL) || \" logged slots / \" || (SELECT count(*) FROM plan_item WHERE deleted = 0) || \" plan items\";
  SELECT count(*) FROM (SELECT date, window_name FROM plan_entry WHERE deleted = 0 GROUP BY date, window_name COLLATE NOCASE HAVING count(*) > 1);
  PRAGMA integrity_check;"'
ssh pi 'docker exec carbs-server rm /tmp/quick-carbs-fix.mts'
```

Expected: `dinner already fixed; skipping`, `plan backfill: 0 change(s)`, `all slots match…` (or the same differences as Step 4); then `Taquitos|4.0|p:…|68.0|food`, `Ranch & salad|7.0|carbs|7.0|quick`; `75.0|9.0|9.0`; `<N> log entries / <N> logged slots / <M> plan items` with the two N equal; `0` duplicate slots; `ok`. (`1789599720000`–`1789599779999` is 2026-09-16 18:02:00–18:02:59 CDT.)

### Task 26: Confirm in the apps and report

- [ ] **Step 1: Check what the clients show**

Ask the user to open (or open with the browser tools if they prefer) https://recipes.dxshdw.dev and the iPhone app, sync, and confirm: Log → today → Dinner shows "Taquitos, Ranch & salad", 75 g carbs, 9 u suggested / 9 u taken; Plan → this week shows every logged meal as a `logged` slot with its items, tonight's Dinner listing both rows at 75 g; day totals show plain grams with no colour or "goal" text; slot cells still show their goal colours.

- [ ] **Step 2: Report**

Tell the user, briefly: migration + release versions (server tag, iOS `v0.2.1-build<N>`), the backup file names from Tasks 23 and 25, dinner changed to 4 taquitos (68 g) + Ranch & salad 7 g = 75 g with 9/9 units kept, how many plan slots/items were backfilled, any skipped entries, and every `DIFFERS` line verbatim (logs were not changed).

- [ ] **Step 3: Record it**

Update the memory note `~/.claude/projects/-home-shadow-linux/memory/project_carbbook.md` with a 2026-09-16 line (quick carbs rows shipped: migration 005 / `user_version` 5, iOS 0.2.1, day totals plain, data fix script path, backup names), then run `kb-ingest -c claude_memory ~/.claude/projects/-home-shadow-linux/memory/project_carbbook.md`. Do not edit `HANDOFF.md` from an implementer agent.

---

## Self-review (done while writing)

- **Spec coverage.** §2 ref_type/amount/unit/ref_id/label → Tasks 1, 4, 5, 15, 17; `itemCarbs` fail-closed + unit list → Tasks 2, 15; vectors (0, 7, 2000, 2001, negative, wrong unit; JSON only) → Task 3 (+ NaN/∞ in unit tests); decimal parser → Tasks 8, 18; "+ Carbs" in Calculator / meal editor / plan slot editor with "label — N g carbs", edit, remove → Tasks 9–12, 19, 20; totals, estimate, goal colours include quick rows → Tasks 2, 10, 12, 16 (all go through `itemCarbs`/`sumCarbs`); log snapshot via `display_name`/`carbs_g` → Tasks 10, 13, 16; migration 005 atomic, rows/indexes/`server_seq` kept, aborts on unexpected data → Tasks 4, 7; validation ignores `ref_id` for quick, label ≤ 80 → Tasks 5, 6; compatibility + release order → Ground rules, Tasks 22, 23, 25. §3 day-total colour removed on web and iOS, per-slot/Calculator/Log colours untouched, core `dayGoal` + vectors kept → Tasks 13, 21. §4 dinner fix + backfill through the push path as owner, backup first, verify → Tasks 24–26. §5 testing incl. live-copy migration rehearsal and the e2e flow → Tasks 7, 14.
- **Placeholders.** None: every code step has full code; `<N>`/`<file>` only stand for values printed by an earlier command.
- **Type consistency.** TS: `QUICK_UNIT`, `QUICK_LABEL_MAX`, `QUICK_DEFAULT_LABEL`, `isValidQuickCarbs`, `quickUnits`, `normalizeQuickLabel`, `quickDisplayName`, `itemRefId(refType, refId, rowId)`, `checkItemKind(r, { labels, snapshotCarbs })`, web `draftAmount`, `draftLabel`, `itemLabel`, `newQuickItem`, `quickRowText`, `dayCarbs`, `dayTotalText`, `SearchPanel.onAddCarbs`. Swift: `Units.quick`, `Units.quickLabelMax`, `Units.quickDefaultLabel`, `isValidQuickCarbs`, `quickUnits()`, `normalizeQuickLabel`, `quickDisplayName`, `itemRefId(_:_:rowId:)`, `CalculatorLine.label`, `MealItemData.label`, `PlanItemData.label`, `PlanEditing.DraftItem.label`, `QuickCarbsInput.{parse,modelAmount,isInvalid,rowText,invalidMessage}`, `AmountInput.isInvalid(amount:refType:)`, `itemDisplayName(_:_:label:catalog:)`, `itemUnits(_:_:currentUnit:catalog:)`, `PlanEditing.dayTotalText`, `TableCodec.legacyColumns`, `Schema.v4QuickCarbs`, `QuickCarbsSheet(onAdd:)`, `QuickCarbsRow(label:amount:carbs:)` — each defined once and used with the same signature.
