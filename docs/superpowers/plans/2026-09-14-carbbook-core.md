# CarbBook Core Logic Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@carbbook/core`, the shared TypeScript package for unit conversion, carb math, dose estimates and sync conflict resolution, plus the JSON test vectors that the iOS app will also run.

**Architecture:** A pnpm workspace at `~/Projects/CarbBook`. `packages/core` is pure functions with no I/O. It consumes plain data records shaped like the spec §3 tables, and it is imported as TypeScript source by the server and web packages in later plans. `testdata/*.json` holds language-neutral expected results; Vitest runs them here, and XCTest runs the same files in the iOS plan.

**Tech Stack:** Node 25, pnpm 10, TypeScript (strict), Vitest.

**Spec:** `docs/superpowers/specs/2026-09-13-carbbook-design.md` (§3 data model, §4 core logic, §5 sync, §10 testing).

**Later plans (written after this one ships):** server, web PWA, Pi deploy, iOS.

---

## File structure

```
package.json                    workspace root scripts (test, typecheck)
pnpm-workspace.yaml             packages/*
tsconfig.base.json              shared strict compiler options
.gitignore
packages/core/package.json      @carbbook/core, exports src/index.ts
packages/core/tsconfig.json
packages/core/src/types.ts      record shapes (data + sync metadata)
packages/core/src/units.ts      unit tables, density, unit lists, amount → grams
packages/core/src/carbs.ts      Catalog, food/meal carbs, nesting, cycle check
packages/core/src/dose.ts       windows, correction, rounding, estimate, breakdown text
packages/core/src/sync.ts       last-write-wins comparison
packages/core/src/index.ts      public exports
packages/core/test/*.test.ts    unit tests + vector runners
testdata/units-vectors.json     shared unit/carb/cycle expectations
testdata/dose-vectors.json      shared dose expectations
```

Unit ids are fixed strings shared with Swift: mass `g kg oz lb`, volume `ml l tsp tbsp floz cup` (US customary), `serving` for meals, and `p:<portionId>` for count/serving portions.

---

### Task 1: Workspace scaffold

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitignore`
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/src/index.ts`
- Test: `packages/core/test/smoke.test.ts`

- [ ] **Step 1: Create root files**

`package.json`:
```json
{
  "name": "carbbook",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "pnpm -r test",
    "typecheck": "pnpm -r typecheck"
  }
}
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - packages/*
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "resolveJsonModule": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true
  }
}
```

`.gitignore`:
```
node_modules/
dist/
coverage/
*.log
.DS_Store
```

- [ ] **Step 2: Create the core package**

`packages/core/package.json`:
```json
{
  "name": "@carbbook/core",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json"
  }
}
```

`packages/core/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "test"]
}
```

`packages/core/src/index.ts`:
```ts
export const CORE_VERSION = '0.1.0';
```

- [ ] **Step 3: Install dev dependencies**

Run:
```bash
cd ~/Projects/CarbBook && pnpm add -D -w typescript vitest && pnpm --filter @carbbook/core add -D typescript vitest
```
Expected: installs complete and `pnpm-lock.yaml` is created.

- [ ] **Step 4: Write a smoke test**

`packages/core/test/smoke.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { CORE_VERSION } from '../src/index';

describe('core package', () => {
  it('loads', () => {
    expect(CORE_VERSION).toBe('0.1.0');
  });
});
```

- [ ] **Step 5: Run tests and typecheck**

Run: `cd ~/Projects/CarbBook && pnpm test && pnpm typecheck`
Expected: `1 passed`, and tsc exits 0 with no output.

- [ ] **Step 6: Commit**

```bash
cd ~/Projects/CarbBook
git add package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json .gitignore packages/core
git commit -m "chore: scaffold pnpm workspace and @carbbook/core"
```

---

### Task 2: Record types

**Files:**
- Create: `packages/core/src/types.ts`
- Modify: `packages/core/src/index.ts`

Types only, so there is no behavior to test; the typecheck is the check.

- [ ] **Step 1: Write `types.ts`**

```ts
export type Id = string;

/** Fields every synced row carries (spec §3). */
export interface SyncMeta {
  updated_at: number; // ms since epoch, client clock
  updated_by: string; // device id
  deleted: 0 | 1;
  server_seq?: number; // assigned by the server on accept
}

export type Synced<T> = T & SyncMeta;

export type FoodSource = 'usda' | 'off' | 'custom';

export interface FoodData {
  id: Id;
  name: string;
  brand?: string | null;
  source?: FoodSource;
  source_ref?: string | null;
  derived_from?: Id | null;
  carbs_per_100g: number | null;
  fiber_per_100g?: number | null;
  density_g_per_ml?: number | null;
  notes?: string | null;
}

export type PortionKind = 'volume' | 'count' | 'serving';

export interface PortionData {
  id: Id;
  food_id: Id;
  /** For kind "volume" this must be a volume unit id (e.g. "cup"); otherwise free text ("slice"). */
  label: string;
  kind: PortionKind;
  quantity: number;
  grams: number;
}

export interface BarcodeData {
  id: Id;
  code: string;
  food_id: Id;
}

export interface MealData {
  id: Id;
  name: string;
  yield_servings: number;
  total_weight_g?: number | null;
  notes?: string | null;
}

export type RefType = 'food' | 'meal';

export interface MealItemData {
  id: Id;
  meal_id: Id;
  ref_type: RefType;
  ref_id: Id;
  amount: number;
  unit: string;
  position: number;
}

export type BgSource = 'dexcom' | 'manual' | 'none';

export interface LogEntryData {
  id: Id;
  eaten_at: number;
  window_name: string | null;
  bg_mgdl: number | null;
  bg_source: BgSource;
  bg_trend?: string | null;
  total_carbs_g: number;
  suggested_units: number | null;
  taken_units: number | null;
  settings_version_id: Id | null;
  notes?: string | null;
}

export interface LogItemData {
  id: Id;
  log_entry_id: Id;
  ref_type: RefType;
  ref_id: Id;
  display_name: string;
  amount: number;
  unit: string;
  carbs_g: number;
}

export interface DoseWindow {
  name: string;
  start: string; // "HH:MM", 24-hour local time
  ratio_g_per_unit: number;
}

export type CorrectionMode = 'started' | 'full' | 'proportional';

export interface CorrectionRule {
  threshold: number;
  step: number;
  units_per_step: number;
  mode: CorrectionMode;
}

export interface RoundingRule {
  increment: number;
  round_down_below_bg: number | null;
}

export interface DoseSettingsData {
  id: Id;
  effective_from: number; // ms since epoch
  windows: DoseWindow[];
  correction: CorrectionRule;
  rounding: RoundingRule;
}
```

- [ ] **Step 2: Export from index**

Replace `packages/core/src/index.ts` with:
```ts
export const CORE_VERSION = '0.1.0';
export type * from './types';
```

- [ ] **Step 3: Typecheck**

Run: `cd ~/Projects/CarbBook && pnpm typecheck`
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src
git commit -m "feat(core): add record types"
```

---

### Task 3: Units

**Files:**
- Create: `packages/core/src/units.ts`
- Test: `packages/core/test/units.test.ts`

- [ ] **Step 1: Write the failing tests**

`packages/core/test/units.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import type { FoodData, MealData, PortionData } from '../src/types';
import { densityOf, foodAmountToGrams, foodUnits, mealUnits } from '../src/units';

const rice: FoodData = { id: 'rice', name: 'Rice', carbs_per_100g: 28.2 };
const riceCup: PortionData = { id: 'rice-cup', food_id: 'rice', label: 'cup', kind: 'volume', quantity: 1, grams: 158 };
const bread: FoodData = { id: 'bread', name: 'Bread', carbs_per_100g: 49 };
const slice: PortionData = { id: 'bread-slice', food_id: 'bread', label: 'slice', kind: 'count', quantity: 1, grams: 25 };
const milk: FoodData = { id: 'milk', name: 'Milk', carbs_per_100g: 4.8, density_g_per_ml: 1.03 };

describe('densityOf', () => {
  it('prefers the explicit density', () => {
    expect(densityOf(milk, [])).toBe(1.03);
  });
  it('derives density from a volume portion', () => {
    expect(densityOf(rice, [riceCup])).toBeCloseTo(158 / 236.5882365, 9);
  });
  it('is null with no volume information', () => {
    expect(densityOf(bread, [slice])).toBeNull();
  });
});

describe('foodAmountToGrams', () => {
  it('converts mass units', () => {
    expect(foodAmountToGrams(4, 'oz', rice, [])).toBeCloseTo(113.398093, 5);
    expect(foodAmountToGrams(1, 'kg', rice, [])).toBe(1000);
  });
  it('converts volume via density', () => {
    expect(foodAmountToGrams(2, 'tbsp', rice, [riceCup])).toBeCloseTo(19.75, 6);
  });
  it('converts count portions', () => {
    expect(foodAmountToGrams(2, 'p:bread-slice', bread, [slice])).toBe(50);
  });
  it('returns null for volume without density, unknown units and bad amounts', () => {
    expect(foodAmountToGrams(1, 'cup', bread, [slice])).toBeNull();
    expect(foodAmountToGrams(1, 'handful', rice, [])).toBeNull();
    expect(foodAmountToGrams(1, 'p:missing', bread, [slice])).toBeNull();
    expect(foodAmountToGrams(-1, 'g', rice, [])).toBeNull();
    expect(foodAmountToGrams(Number.NaN, 'g', rice, [])).toBeNull();
  });
});

describe('unit lists', () => {
  it('lists mass + volume when density is known', () => {
    expect(foodUnits(rice, [riceCup])).toEqual(['g', 'kg', 'oz', 'lb', 'ml', 'l', 'tsp', 'tbsp', 'floz', 'cup']);
  });
  it('lists mass + count portions otherwise', () => {
    expect(foodUnits(bread, [slice])).toEqual(['g', 'kg', 'oz', 'lb', 'p:bread-slice']);
  });
  it('lists serving, plus mass when a meal has a total weight', () => {
    const withWeight: MealData = { id: 'm', name: 'M', yield_servings: 2, total_weight_g: 414 };
    const noWeight: MealData = { id: 'n', name: 'N', yield_servings: 1, total_weight_g: null };
    expect(mealUnits(withWeight)).toEqual(['serving', 'g', 'kg', 'oz', 'lb']);
    expect(mealUnits(noWeight)).toEqual(['serving']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/Projects/CarbBook && pnpm --filter @carbbook/core test`
Expected: FAIL, `Failed to resolve import "../src/units"`.

- [ ] **Step 3: Implement `units.ts`**

```ts
import type { FoodData, MealData, PortionData } from './types';

/** Grams per unit. */
export const MASS_UNITS = { g: 1, kg: 1000, oz: 28.349523125, lb: 453.59237 } as const;
/** Millilitres per unit (US customary). */
export const VOLUME_UNITS = {
  ml: 1,
  l: 1000,
  tsp: 4.92892159375,
  tbsp: 14.78676478125,
  floz: 29.5735295625,
  cup: 236.5882365,
} as const;

export type MassUnit = keyof typeof MASS_UNITS;
export type VolumeUnit = keyof typeof VOLUME_UNITS;

export const SERVING_UNIT = 'serving';
export const PORTION_PREFIX = 'p:';

export function isMassUnit(unit: string): unit is MassUnit {
  return Object.hasOwn(MASS_UNITS, unit);
}

export function isVolumeUnit(unit: string): unit is VolumeUnit {
  return Object.hasOwn(VOLUME_UNITS, unit);
}

function isValidAmount(amount: number): boolean {
  return Number.isFinite(amount) && amount >= 0;
}

export function densityOf(food: FoodData, portions: PortionData[]): number | null {
  if (food.density_g_per_ml != null && food.density_g_per_ml > 0) return food.density_g_per_ml;
  for (const p of portions) {
    if (p.kind === 'volume' && isVolumeUnit(p.label) && p.quantity > 0 && p.grams > 0) {
      return p.grams / (p.quantity * VOLUME_UNITS[p.label]);
    }
  }
  return null;
}

export function foodUnits(food: FoodData, portions: PortionData[]): string[] {
  const units: string[] = Object.keys(MASS_UNITS);
  if (densityOf(food, portions) !== null) units.push(...Object.keys(VOLUME_UNITS));
  for (const p of portions) {
    if (p.kind !== 'volume') units.push(PORTION_PREFIX + p.id);
  }
  return units;
}

export function mealUnits(meal: MealData): string[] {
  const hasWeight = meal.total_weight_g != null && meal.total_weight_g > 0;
  return hasWeight ? [SERVING_UNIT, ...Object.keys(MASS_UNITS)] : [SERVING_UNIT];
}

export function foodAmountToGrams(
  amount: number,
  unit: string,
  food: FoodData,
  portions: PortionData[],
): number | null {
  if (!isValidAmount(amount)) return null;
  if (isMassUnit(unit)) return amount * MASS_UNITS[unit];
  if (isVolumeUnit(unit)) {
    const density = densityOf(food, portions);
    return density === null ? null : amount * VOLUME_UNITS[unit] * density;
  }
  if (unit.startsWith(PORTION_PREFIX)) {
    const portionId = unit.slice(PORTION_PREFIX.length);
    const portion = portions.find((p) => p.id === portionId);
    return portion && portion.quantity > 0 ? (amount * portion.grams) / portion.quantity : null;
  }
  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @carbbook/core test`
Expected: all tests in `units.test.ts` and `smoke.test.ts` pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/units.ts packages/core/test/units.test.ts
git commit -m "feat(core): unit conversion with density and portions"
```

---

### Task 4: Carb math, nested meals, cycle detection

**Files:**
- Create: `packages/core/src/carbs.ts`
- Test: `packages/core/test/carbs.test.ts`

- [ ] **Step 1: Write the failing tests**

`packages/core/test/carbs.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { createCatalog, itemCarbs, sumCarbs, wouldCreateCycle } from '../src/carbs';

const catalog = createCatalog({
  foods: [
    { id: 'rice', name: 'Rice', carbs_per_100g: 28.2 },
    { id: 'corn', name: 'Cream corn', carbs_per_100g: 18.13 },
    { id: 'bread', name: 'Bread', carbs_per_100g: 49 },
    { id: 'mystery', name: 'Mystery', carbs_per_100g: null },
  ],
  portions: [
    { id: 'rice-cup', food_id: 'rice', label: 'cup', kind: 'volume', quantity: 1, grams: 158 },
    { id: 'corn-cup', food_id: 'corn', label: 'cup', kind: 'volume', quantity: 1, grams: 256 },
    { id: 'bread-slice', food_id: 'bread', label: 'slice', kind: 'count', quantity: 1, grams: 25 },
  ],
  meals: [
    { id: 'rice-corn', name: 'Rice and corn', yield_servings: 2, total_weight_g: 414 },
    { id: 'plate', name: 'Plate', yield_servings: 1, total_weight_g: null },
    { id: 'bad', name: 'Bad', yield_servings: 1 },
  ],
  meal_items: [
    { id: 'i2', meal_id: 'rice-corn', ref_type: 'food', ref_id: 'corn', amount: 1, unit: 'cup', position: 1 },
    { id: 'i1', meal_id: 'rice-corn', ref_type: 'food', ref_id: 'rice', amount: 1, unit: 'cup', position: 0 },
    { id: 'i3', meal_id: 'plate', ref_type: 'meal', ref_id: 'rice-corn', amount: 1.5, unit: 'serving', position: 0 },
    { id: 'i4', meal_id: 'plate', ref_type: 'food', ref_id: 'bread', amount: 1, unit: 'p:bread-slice', position: 1 },
    { id: 'i5', meal_id: 'bad', ref_type: 'food', ref_id: 'rice', amount: 100, unit: 'g', position: 0 },
    { id: 'i6', meal_id: 'bad', ref_type: 'food', ref_id: 'mystery', amount: 50, unit: 'g', position: 1 },
  ],
});

describe('itemCarbs', () => {
  it('computes food carbs', () => {
    const r = itemCarbs(catalog, 'food', 'rice', 1, 'cup');
    expect(r.complete).toBe(true);
    expect(r.carbs_g).toBeCloseTo(44.556, 6);
  });
  it('flags foods with no carb data or unusable units', () => {
    expect(itemCarbs(catalog, 'food', 'mystery', 50, 'g')).toEqual({ carbs_g: 0, complete: false });
    expect(itemCarbs(catalog, 'food', 'bread', 1, 'cup')).toEqual({ carbs_g: 0, complete: false });
    expect(itemCarbs(catalog, 'food', 'nope', 1, 'g')).toEqual({ carbs_g: 0, complete: false });
  });
  it('computes meal servings and grams', () => {
    expect(itemCarbs(catalog, 'meal', 'rice-corn', 1, 'serving').carbs_g).toBeCloseTo(45.4844, 6);
    expect(itemCarbs(catalog, 'meal', 'rice-corn', 100, 'g').carbs_g).toBeCloseTo(21.97314, 5);
  });
  it('resolves nested meals', () => {
    const r = itemCarbs(catalog, 'meal', 'plate', 1, 'serving');
    expect(r.complete).toBe(true);
    expect(r.carbs_g).toBeCloseTo(80.4766, 6);
  });
  it('rejects grams for a meal without total weight', () => {
    expect(itemCarbs(catalog, 'meal', 'plate', 1, 'g')).toEqual({ carbs_g: 0, complete: false });
  });
  it('keeps the partial total but marks meals with an incomplete item', () => {
    const r = itemCarbs(catalog, 'meal', 'bad', 1, 'serving');
    expect(r.complete).toBe(false);
    expect(r.carbs_g).toBeCloseTo(28.2, 6);
  });
});

describe('cycles', () => {
  it('detects direct and transitive cycles', () => {
    expect(wouldCreateCycle(catalog, 'plate', 'plate')).toBe(true);
    expect(wouldCreateCycle(catalog, 'rice-corn', 'plate')).toBe(true);
    expect(wouldCreateCycle(catalog, 'plate', 'bad')).toBe(false);
  });
  it('does not loop forever on corrupt cyclic data', () => {
    const cyclic = createCatalog({
      meals: [
        { id: 'a', name: 'A', yield_servings: 1 },
        { id: 'b', name: 'B', yield_servings: 1 },
      ],
      meal_items: [
        { id: 'x', meal_id: 'a', ref_type: 'meal', ref_id: 'b', amount: 1, unit: 'serving', position: 0 },
        { id: 'y', meal_id: 'b', ref_type: 'meal', ref_id: 'a', amount: 1, unit: 'serving', position: 0 },
      ],
    });
    expect(itemCarbs(cyclic, 'meal', 'a', 1, 'serving').complete).toBe(false);
  });
});

describe('sumCarbs', () => {
  it('adds carbs and ANDs completeness', () => {
    expect(sumCarbs([{ carbs_g: 10, complete: true }, { carbs_g: 5, complete: false }])).toEqual({ carbs_g: 15, complete: false });
    expect(sumCarbs([])).toEqual({ carbs_g: 0, complete: true });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @carbbook/core test`
Expected: FAIL, `Failed to resolve import "../src/carbs"`.

- [ ] **Step 3: Implement `carbs.ts`**

```ts
import type { FoodData, Id, MealData, MealItemData, PortionData, RefType } from './types';
import { MASS_UNITS, SERVING_UNIT, foodAmountToGrams, isMassUnit } from './units';

export interface Catalog {
  food(id: Id): FoodData | undefined;
  portions(foodId: Id): PortionData[];
  meal(id: Id): MealData | undefined;
  mealItems(mealId: Id): MealItemData[];
}

export interface CarbResult {
  carbs_g: number;
  complete: boolean;
}

const INCOMPLETE: CarbResult = { carbs_g: 0, complete: false };

function groupBy<T>(rows: T[], key: (row: T) => Id): Map<Id, T[]> {
  const map = new Map<Id, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = map.get(k);
    if (list) list.push(row);
    else map.set(k, [row]);
  }
  return map;
}

export function createCatalog(data: {
  foods?: FoodData[];
  portions?: PortionData[];
  meals?: MealData[];
  meal_items?: MealItemData[];
}): Catalog {
  const foods = new Map((data.foods ?? []).map((f) => [f.id, f]));
  const meals = new Map((data.meals ?? []).map((m) => [m.id, m]));
  const portions = groupBy(data.portions ?? [], (p) => p.food_id);
  const items = groupBy(data.meal_items ?? [], (i) => i.meal_id);
  for (const list of items.values()) list.sort((a, b) => a.position - b.position);
  return {
    food: (id) => foods.get(id),
    portions: (foodId) => portions.get(foodId) ?? [],
    meal: (id) => meals.get(id),
    mealItems: (mealId) => items.get(mealId) ?? [],
  };
}

function foodItemCarbs(catalog: Catalog, foodId: Id, amount: number, unit: string): CarbResult {
  const food = catalog.food(foodId);
  if (!food || food.carbs_per_100g == null) return INCOMPLETE;
  const grams = foodAmountToGrams(amount, unit, food, catalog.portions(foodId));
  if (grams === null) return INCOMPLETE;
  return { carbs_g: (grams * food.carbs_per_100g) / 100, complete: true };
}

function mealTotalCarbs(catalog: Catalog, mealId: Id, visiting: Set<Id>): CarbResult {
  if (visiting.has(mealId) || !catalog.meal(mealId)) return INCOMPLETE;
  visiting.add(mealId);
  const total = sumCarbs(
    catalog
      .mealItems(mealId)
      .map((item) => resolveItem(catalog, item.ref_type, item.ref_id, item.amount, item.unit, visiting)),
  );
  visiting.delete(mealId);
  return total;
}

function mealItemCarbs(catalog: Catalog, mealId: Id, amount: number, unit: string, visiting: Set<Id>): CarbResult {
  const meal = catalog.meal(mealId);
  if (!meal || !Number.isFinite(amount) || amount < 0) return INCOMPLETE;
  let factor: number | null = null;
  if (unit === SERVING_UNIT && meal.yield_servings > 0) {
    factor = amount / meal.yield_servings;
  } else if (isMassUnit(unit) && meal.total_weight_g != null && meal.total_weight_g > 0) {
    factor = (amount * MASS_UNITS[unit]) / meal.total_weight_g;
  }
  if (factor === null) return INCOMPLETE;
  const total = mealTotalCarbs(catalog, mealId, visiting);
  return { carbs_g: total.carbs_g * factor, complete: total.complete };
}

function resolveItem(
  catalog: Catalog,
  refType: RefType,
  refId: Id,
  amount: number,
  unit: string,
  visiting: Set<Id>,
): CarbResult {
  return refType === 'food'
    ? foodItemCarbs(catalog, refId, amount, unit)
    : mealItemCarbs(catalog, refId, amount, unit, visiting);
}

/** Carbs for one line item (a food or a meal) at the given amount and unit. */
export function itemCarbs(catalog: Catalog, refType: RefType, refId: Id, amount: number, unit: string): CarbResult {
  return resolveItem(catalog, refType, refId, amount, unit, new Set());
}

export function sumCarbs(results: CarbResult[]): CarbResult {
  return results.reduce<CarbResult>(
    (acc, r) => ({ carbs_g: acc.carbs_g + r.carbs_g, complete: acc.complete && r.complete }),
    { carbs_g: 0, complete: true },
  );
}

/** True if adding `candidateMealId` as a component of `mealId` would make a meal contain itself. */
export function wouldCreateCycle(catalog: Catalog, mealId: Id, candidateMealId: Id): boolean {
  if (candidateMealId === mealId) return true;
  const stack: Id[] = [candidateMealId];
  const seen = new Set<Id>();
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const item of catalog.mealItems(current)) {
      if (item.ref_type !== 'meal') continue;
      if (item.ref_id === mealId) return true;
      stack.push(item.ref_id);
    }
  }
  return false;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @carbbook/core test`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/carbs.ts packages/core/test/carbs.test.ts
git commit -m "feat(core): carb math with nested meals and cycle detection"
```

---

### Task 5: Dose estimate

**Files:**
- Create: `packages/core/src/dose.ts`
- Test: `packages/core/test/dose.test.ts`

Rules from spec §4.3, confirmed with the user:
- A window applies from its start time (inclusive) until the next window's start; the last window wraps past midnight.
- Correction `started`: 1 unit for each started step over the threshold, so with threshold 200 and step 50, 201–250 gives 1u and 251–300 gives 2u.
- Rounding: half-up to `increment`, except round **down** when BG < `round_down_below_bg`.
- No insulin-on-board subtraction; `recentDoseWarning` only flags a dose logged within 4 hours.

- [ ] **Step 1: Write the failing tests**

`packages/core/test/dose.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import type { DoseSettingsData } from '../src/types';
import {
  activeSettings,
  correctionUnits,
  estimateDose,
  formatBreakdown,
  parseHHMM,
  pickWindow,
  recentDoseWarning,
  roundDose,
} from '../src/dose';

const settings: DoseSettingsData = {
  id: 's1',
  effective_from: Date.UTC(2026, 7, 12),
  windows: [
    { name: 'Breakfast', start: '05:00', ratio_g_per_unit: 8 },
    { name: 'AM Snack', start: '09:00', ratio_g_per_unit: 10 },
    { name: 'Lunch', start: '11:00', ratio_g_per_unit: 8 },
    { name: 'PM Snack', start: '14:00', ratio_g_per_unit: 10 },
    { name: 'Dinner', start: '16:30', ratio_g_per_unit: 8 },
    { name: 'HS Snack', start: '19:30', ratio_g_per_unit: 12 },
  ],
  correction: { threshold: 200, step: 50, units_per_step: 1, mode: 'started' },
  rounding: { increment: 1, round_down_below_bg: 130 },
};

describe('parseHHMM', () => {
  it('parses valid times and rejects invalid ones', () => {
    expect(parseHHMM('16:30')).toBe(990);
    expect(() => parseHHMM('24:00')).toThrow();
    expect(() => parseHHMM('9:00')).toThrow();
  });
});

describe('pickWindow', () => {
  it('uses start-inclusive windows and wraps overnight', () => {
    expect(pickWindow(settings.windows, parseHHMM('09:00'))?.name).toBe('AM Snack');
    expect(pickWindow(settings.windows, parseHHMM('08:59'))?.name).toBe('Breakfast');
    expect(pickWindow(settings.windows, parseHHMM('23:30'))?.name).toBe('HS Snack');
    expect(pickWindow(settings.windows, parseHHMM('04:59'))?.name).toBe('HS Snack');
    expect(pickWindow([], 600)).toBeNull();
  });
  it('does not depend on input order', () => {
    const shuffled = [...settings.windows].reverse();
    expect(pickWindow(shuffled, parseHHMM('12:00'))?.name).toBe('Lunch');
  });
});

describe('correctionUnits', () => {
  const rule = settings.correction;
  it('started mode', () => {
    expect(correctionUnits(rule, 200)).toBe(0);
    expect(correctionUnits(rule, 201)).toBe(1);
    expect(correctionUnits(rule, 250)).toBe(1);
    expect(correctionUnits(rule, 251)).toBe(2);
    expect(correctionUnits(rule, null)).toBe(0);
  });
  it('full and proportional modes', () => {
    expect(correctionUnits({ ...rule, mode: 'full' }, 249)).toBe(0);
    expect(correctionUnits({ ...rule, mode: 'full' }, 263)).toBe(1);
    expect(correctionUnits({ ...rule, mode: 'proportional' }, 275)).toBeCloseTo(1.5, 9);
  });
});

describe('roundDose', () => {
  it('rounds half-up normally and down below the BG cutoff', () => {
    expect(roundDose(9.5, settings.rounding, 140)).toEqual({ units: 10, rounded_down: false });
    expect(roundDose(9.9, settings.rounding, 125)).toEqual({ units: 9, rounded_down: true });
    expect(roundDose(2.5, settings.rounding, null)).toEqual({ units: 3, rounded_down: false });
    expect(roundDose(3.26, { increment: 0.5, round_down_below_bg: null }, 90)).toEqual({ units: 3.5, rounded_down: false });
  });
});

describe('estimateDose', () => {
  it('combines meal and correction units', () => {
    const r = estimateDose({ settings, minutes: parseHHMM('18:00'), carbs: { carbs_g: 72, complete: true }, bg: 263 });
    expect(r).toMatchObject({ ok: true, meal_units: 9, correction_units: 2, units: 11, rounded_down: false });
    if (r.ok) expect(formatBreakdown(r)).toBe('72g ÷ 8 = 9.0 + BG 263 → 2u = 11.0 → 11u');
  });
  it('refuses to estimate with incomplete carbs', () => {
    const r = estimateDose({ settings, minutes: 600, carbs: { carbs_g: 40, complete: false }, bg: 150 });
    expect(r).toEqual({ ok: false, reason: 'incomplete_carbs', window: settings.windows[1] });
  });
  it('reports missing windows and invalid ratios', () => {
    expect(estimateDose({ settings: { ...settings, windows: [] }, minutes: 600, carbs: { carbs_g: 10, complete: true }, bg: null }))
      .toEqual({ ok: false, reason: 'no_window', window: null });
    const zero = { ...settings, windows: [{ name: 'All', start: '00:00', ratio_g_per_unit: 0 }] };
    expect(estimateDose({ settings: zero, minutes: 600, carbs: { carbs_g: 10, complete: true }, bg: null }))
      .toMatchObject({ ok: false, reason: 'invalid_ratio' });
  });
});

describe('activeSettings', () => {
  it('picks the newest version already in effect', () => {
    const old = { ...settings, id: 'old', effective_from: Date.UTC(2025, 6, 19) };
    const future = { ...settings, id: 'future', effective_from: Date.UTC(2030, 0, 1) };
    expect(activeSettings([old, settings, future], Date.UTC(2026, 8, 14))?.id).toBe('s1');
    expect(activeSettings([future], Date.UTC(2026, 8, 14))).toBeNull();
  });
});

describe('recentDoseWarning', () => {
  it('warns within 4 hours of a logged dose', () => {
    const now = Date.UTC(2026, 8, 14, 12);
    expect(recentDoseWarning(now - 3 * 3600_000, now)).toBe(true);
    expect(recentDoseWarning(now - 5 * 3600_000, now)).toBe(false);
    expect(recentDoseWarning(null, now)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @carbbook/core test`
Expected: FAIL, `Failed to resolve import "../src/dose"`.

- [ ] **Step 3: Implement `dose.ts`**

```ts
import type { CarbResult } from './carbs';
import type { CorrectionRule, DoseSettingsData, DoseWindow, RoundingRule } from './types';

const EPS = 1e-9;
const HOUR_MS = 3_600_000;

export function parseHHMM(value: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error(`Invalid time "${value}", expected HH:MM`);
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) throw new Error(`Invalid time "${value}"`);
  return hours * 60 + minutes;
}

export function minutesOfDay(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

export function pickWindow(windows: DoseWindow[], minutes: number): DoseWindow | null {
  if (windows.length === 0) return null;
  const sorted = [...windows].sort((a, b) => parseHHMM(a.start) - parseHHMM(b.start));
  let chosen = sorted[sorted.length - 1]!; // before the first start → previous day's last window
  for (const window of sorted) {
    if (parseHHMM(window.start) <= minutes) chosen = window;
  }
  return chosen;
}

export function correctionUnits(rule: CorrectionRule, bg: number | null): number {
  if (bg == null || bg <= rule.threshold || rule.step <= 0) return 0;
  const steps = (bg - rule.threshold) / rule.step;
  switch (rule.mode) {
    case 'started':
      return Math.ceil(steps - EPS) * rule.units_per_step;
    case 'full':
      return Math.floor(steps + EPS) * rule.units_per_step;
    case 'proportional':
      return steps * rule.units_per_step;
  }
}

export function roundDose(raw: number, rule: RoundingRule, bg: number | null): { units: number; rounded_down: boolean } {
  const increment = rule.increment > 0 ? rule.increment : 1;
  const roundedDown = bg != null && rule.round_down_below_bg != null && bg < rule.round_down_below_bg;
  const steps = roundedDown ? Math.floor(raw / increment + EPS) : Math.floor(raw / increment + 0.5 + EPS);
  return { units: Number((steps * increment).toFixed(4)), rounded_down: roundedDown };
}

export interface DoseInput {
  settings: DoseSettingsData;
  /** Minutes since local midnight when the food is eaten. */
  minutes: number;
  carbs: CarbResult;
  bg: number | null;
}

export type DoseEstimate =
  | {
      ok: true;
      window: DoseWindow;
      carbs_g: number;
      bg: number | null;
      meal_units: number;
      correction_units: number;
      raw_units: number;
      units: number;
      rounded_down: boolean;
      round_down_below_bg: number | null;
    }
  | { ok: false; reason: 'no_window' | 'invalid_ratio' | 'incomplete_carbs'; window: DoseWindow | null };

export function estimateDose(input: DoseInput): DoseEstimate {
  const window = pickWindow(input.settings.windows, input.minutes);
  if (!window) return { ok: false, reason: 'no_window', window: null };
  if (!(window.ratio_g_per_unit > 0)) return { ok: false, reason: 'invalid_ratio', window };
  if (!input.carbs.complete) return { ok: false, reason: 'incomplete_carbs', window };
  const mealUnits = input.carbs.carbs_g / window.ratio_g_per_unit;
  const correction = correctionUnits(input.settings.correction, input.bg);
  const raw = mealUnits + correction;
  const { units, rounded_down } = roundDose(raw, input.settings.rounding, input.bg);
  return {
    ok: true,
    window,
    carbs_g: input.carbs.carbs_g,
    bg: input.bg,
    meal_units: mealUnits,
    correction_units: correction,
    raw_units: raw,
    units,
    rounded_down,
    round_down_below_bg: input.settings.rounding.round_down_below_bg,
  };
}

const trim = (n: number, digits: number) => String(Number(n.toFixed(digits)));

/** e.g. "72g ÷ 8 = 9.0 + BG 263 → 2u = 11.0 → 11u". Shared format with the iOS app. */
export function formatBreakdown(estimate: Extract<DoseEstimate, { ok: true }>): string {
  const e = estimate;
  let text = `${trim(e.carbs_g, 1)}g ÷ ${trim(e.window.ratio_g_per_unit, 2)} = ${e.meal_units.toFixed(1)}`;
  if (e.bg != null) {
    text += ` + BG ${trim(e.bg, 0)} → ${trim(e.correction_units, 2)}u = ${e.raw_units.toFixed(1)}`;
  }
  text += ` → ${trim(e.units, 2)}u`;
  if (e.rounded_down) text += ` (rounded down: BG under ${e.round_down_below_bg})`;
  return text;
}

export function activeSettings<T extends Pick<DoseSettingsData, 'effective_from'>>(versions: T[], atMs: number): T | null {
  let best: T | null = null;
  for (const v of versions) {
    if (v.effective_from <= atMs && (best === null || v.effective_from > best.effective_from)) best = v;
  }
  return best;
}

export function recentDoseWarning(lastDoseAtMs: number | null, nowMs: number, hours = 4): boolean {
  return lastDoseAtMs != null && nowMs - lastDoseAtMs >= 0 && nowMs - lastDoseAtMs < hours * HOUR_MS;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @carbbook/core test`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/dose.ts packages/core/test/dose.test.ts
git commit -m "feat(core): dose estimate with windows, correction scale and rounding"
```

---

### Task 6: Sync last-write-wins

**Files:**
- Create: `packages/core/src/sync.ts`
- Test: `packages/core/test/sync.test.ts`

- [ ] **Step 1: Write the failing tests**

`packages/core/test/sync.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { isNewer } from '../src/sync';

describe('isNewer', () => {
  it('accepts anything when nothing is stored', () => {
    expect(isNewer({ updated_at: 1, updated_by: 'a' }, undefined)).toBe(true);
  });
  it('compares timestamps first', () => {
    expect(isNewer({ updated_at: 2, updated_by: 'a' }, { updated_at: 1, updated_by: 'z' })).toBe(true);
    expect(isNewer({ updated_at: 1, updated_by: 'z' }, { updated_at: 2, updated_by: 'a' })).toBe(false);
  });
  it('breaks ties by device id and ignores exact replays', () => {
    expect(isNewer({ updated_at: 5, updated_by: 'phone' }, { updated_at: 5, updated_by: 'laptop' })).toBe(true);
    expect(isNewer({ updated_at: 5, updated_by: 'laptop' }, { updated_at: 5, updated_by: 'phone' })).toBe(false);
    expect(isNewer({ updated_at: 5, updated_by: 'phone' }, { updated_at: 5, updated_by: 'phone' })).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @carbbook/core test`
Expected: FAIL, `Failed to resolve import "../src/sync"`.

- [ ] **Step 3: Implement `sync.ts`**

```ts
export interface Versioned {
  updated_at: number;
  updated_by: string;
}

/** Last-write-wins: newer timestamp wins; equal timestamps go to the higher device id (spec §5). */
export function isNewer(incoming: Versioned, stored: Versioned | undefined): boolean {
  if (!stored) return true;
  if (incoming.updated_at !== stored.updated_at) return incoming.updated_at > stored.updated_at;
  return incoming.updated_by > stored.updated_by;
}
```

String `>` compares UTF-16 code units, which Swift's `String <` does not; the iOS plan must compare `Array(updated_by.utf16)` so both sides agree. Device ids are UUIDs (ASCII), so both orderings match in practice.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @carbbook/core test`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/sync.ts packages/core/test/sync.test.ts
git commit -m "feat(core): last-write-wins sync comparison"
```

---

### Task 7: Shared test vectors

**Files:**
- Create: `testdata/units-vectors.json`, `testdata/dose-vectors.json`
- Test: `packages/core/test/vectors.test.ts`

- [ ] **Step 1: Write `testdata/units-vectors.json`**

```json
{
  "tolerance": 0.001,
  "foods": [
    { "id": "rice", "name": "Rice, white, cooked", "carbs_per_100g": 28.2 },
    { "id": "corn", "name": "Corn, cream style", "carbs_per_100g": 18.13 },
    { "id": "bread", "name": "Bread, white", "carbs_per_100g": 49 },
    { "id": "milk", "name": "Milk", "carbs_per_100g": 4.8, "density_g_per_ml": 1.03 },
    { "id": "mystery", "name": "No label", "carbs_per_100g": null }
  ],
  "portions": [
    { "id": "rice-cup", "food_id": "rice", "label": "cup", "kind": "volume", "quantity": 1, "grams": 158 },
    { "id": "corn-cup", "food_id": "corn", "label": "cup", "kind": "volume", "quantity": 1, "grams": 256 },
    { "id": "bread-slice", "food_id": "bread", "label": "slice", "kind": "count", "quantity": 1, "grams": 25 }
  ],
  "meals": [
    { "id": "rice-corn", "name": "Rice and cream style corn", "yield_servings": 2, "total_weight_g": 414 },
    { "id": "plate", "name": "Plate", "yield_servings": 1, "total_weight_g": null },
    { "id": "bad", "name": "Has an unlabeled food", "yield_servings": 1, "total_weight_g": null }
  ],
  "meal_items": [
    { "id": "i1", "meal_id": "rice-corn", "ref_type": "food", "ref_id": "rice", "amount": 1, "unit": "cup", "position": 0 },
    { "id": "i2", "meal_id": "rice-corn", "ref_type": "food", "ref_id": "corn", "amount": 1, "unit": "cup", "position": 1 },
    { "id": "i3", "meal_id": "plate", "ref_type": "meal", "ref_id": "rice-corn", "amount": 1.5, "unit": "serving", "position": 0 },
    { "id": "i4", "meal_id": "plate", "ref_type": "food", "ref_id": "bread", "amount": 1, "unit": "p:bread-slice", "position": 1 },
    { "id": "i5", "meal_id": "bad", "ref_type": "food", "ref_id": "rice", "amount": 100, "unit": "g", "position": 0 },
    { "id": "i6", "meal_id": "bad", "ref_type": "food", "ref_id": "mystery", "amount": 50, "unit": "g", "position": 1 }
  ],
  "grams_cases": [
    { "name": "grams", "food_id": "rice", "amount": 100, "unit": "g", "expect": 100 },
    { "name": "kilograms", "food_id": "rice", "amount": 1, "unit": "kg", "expect": 1000 },
    { "name": "ounces", "food_id": "rice", "amount": 4, "unit": "oz", "expect": 113.398093 },
    { "name": "volume portion", "food_id": "rice", "amount": 1, "unit": "cup", "expect": 158 },
    { "name": "volume via derived density", "food_id": "rice", "amount": 2, "unit": "tbsp", "expect": 19.75 },
    { "name": "volume via explicit density", "food_id": "milk", "amount": 1, "unit": "cup", "expect": 243.685884 },
    { "name": "count portion", "food_id": "bread", "amount": 2, "unit": "p:bread-slice", "expect": 50 },
    { "name": "volume without density", "food_id": "bread", "amount": 1, "unit": "cup", "expect": null }
  ],
  "carb_cases": [
    { "name": "food by cup", "ref_type": "food", "ref_id": "rice", "amount": 1, "unit": "cup", "expect": { "carbs_g": 44.556, "complete": true } },
    { "name": "food by tbsp", "ref_type": "food", "ref_id": "rice", "amount": 2, "unit": "tbsp", "expect": { "carbs_g": 5.5695, "complete": true } },
    { "name": "food by oz", "ref_type": "food", "ref_id": "rice", "amount": 4, "unit": "oz", "expect": { "carbs_g": 31.978262, "complete": true } },
    { "name": "milk by cup", "ref_type": "food", "ref_id": "milk", "amount": 1, "unit": "cup", "expect": { "carbs_g": 11.696922, "complete": true } },
    { "name": "bread slices", "ref_type": "food", "ref_id": "bread", "amount": 2, "unit": "p:bread-slice", "expect": { "carbs_g": 24.5, "complete": true } },
    { "name": "no carb data", "ref_type": "food", "ref_id": "mystery", "amount": 50, "unit": "g", "expect": { "carbs_g": 0, "complete": false } },
    { "name": "unusable unit", "ref_type": "food", "ref_id": "bread", "amount": 1, "unit": "cup", "expect": { "carbs_g": 0, "complete": false } },
    { "name": "meal serving", "ref_type": "meal", "ref_id": "rice-corn", "amount": 1, "unit": "serving", "expect": { "carbs_g": 45.4844, "complete": true } },
    { "name": "meal grams", "ref_type": "meal", "ref_id": "rice-corn", "amount": 100, "unit": "g", "expect": { "carbs_g": 21.97314, "complete": true } },
    { "name": "nested meal", "ref_type": "meal", "ref_id": "plate", "amount": 1, "unit": "serving", "expect": { "carbs_g": 80.4766, "complete": true } },
    { "name": "meal grams without weight", "ref_type": "meal", "ref_id": "plate", "amount": 1, "unit": "g", "expect": { "carbs_g": 0, "complete": false } },
    { "name": "meal with incomplete item", "ref_type": "meal", "ref_id": "bad", "amount": 1, "unit": "serving", "expect": { "carbs_g": 28.2, "complete": false } }
  ],
  "unit_list_cases": [
    { "ref_type": "food", "ref_id": "rice", "expect": ["g", "kg", "oz", "lb", "ml", "l", "tsp", "tbsp", "floz", "cup"] },
    { "ref_type": "food", "ref_id": "bread", "expect": ["g", "kg", "oz", "lb", "p:bread-slice"] },
    { "ref_type": "food", "ref_id": "milk", "expect": ["g", "kg", "oz", "lb", "ml", "l", "tsp", "tbsp", "floz", "cup"] },
    { "ref_type": "meal", "ref_id": "rice-corn", "expect": ["serving", "g", "kg", "oz", "lb"] },
    { "ref_type": "meal", "ref_id": "plate", "expect": ["serving"] }
  ],
  "cycle_cases": [
    { "meal_id": "plate", "candidate": "plate", "expect": true },
    { "meal_id": "rice-corn", "candidate": "plate", "expect": true },
    { "meal_id": "plate", "candidate": "bad", "expect": false }
  ]
}
```

- [ ] **Step 2: Write `testdata/dose-vectors.json`**

Values come from the owner's `Meal Carb Rates.md` and `Sliding Scale.md` (row effective 8/12/26).

```json
{
  "tolerance": 0.000001,
  "settings": {
    "id": "seed-2026-08-12",
    "effective_from": 1786492800000,
    "windows": [
      { "name": "Breakfast", "start": "05:00", "ratio_g_per_unit": 8 },
      { "name": "AM Snack", "start": "09:00", "ratio_g_per_unit": 10 },
      { "name": "Lunch", "start": "11:00", "ratio_g_per_unit": 8 },
      { "name": "PM Snack", "start": "14:00", "ratio_g_per_unit": 10 },
      { "name": "Dinner", "start": "16:30", "ratio_g_per_unit": 8 },
      { "name": "HS Snack", "start": "19:30", "ratio_g_per_unit": 12 }
    ],
    "correction": { "threshold": 200, "step": 50, "units_per_step": 1, "mode": "started" },
    "rounding": { "increment": 1, "round_down_below_bg": 130 }
  },
  "cases": [
    { "name": "BG at threshold", "time": "18:00", "carbs": 72, "bg": 200,
      "expect": { "ok": true, "window": "Dinner", "meal_units": 9, "correction_units": 0, "raw_units": 9, "units": 9, "rounded_down": false } },
    { "name": "BG 201 starts first step", "time": "18:00", "carbs": 72, "bg": 201,
      "expect": { "ok": true, "window": "Dinner", "meal_units": 9, "correction_units": 1, "raw_units": 10, "units": 10, "rounded_down": false } },
    { "name": "BG 250 still first step", "time": "18:00", "carbs": 72, "bg": 250,
      "expect": { "ok": true, "window": "Dinner", "meal_units": 9, "correction_units": 1, "raw_units": 10, "units": 10, "rounded_down": false } },
    { "name": "BG 251 starts second step", "time": "18:00", "carbs": 72, "bg": 251,
      "expect": { "ok": true, "window": "Dinner", "meal_units": 9, "correction_units": 2, "raw_units": 11, "units": 11, "rounded_down": false } },
    { "name": "breakdown text", "time": "18:00", "carbs": 72, "bg": 263,
      "expect": { "ok": true, "window": "Dinner", "meal_units": 9, "correction_units": 2, "raw_units": 11, "units": 11, "rounded_down": false,
                  "breakdown": "72g ÷ 8 = 9.0 + BG 263 → 2u = 11.0 → 11u" } },
    { "name": "round down below 130", "time": "12:00", "carbs": 79.2, "bg": 125,
      "expect": { "ok": true, "window": "Lunch", "meal_units": 9.9, "correction_units": 0, "raw_units": 9.9, "units": 9, "rounded_down": true,
                  "breakdown": "79.2g ÷ 8 = 9.9 + BG 125 → 0u = 9.9 → 9u (rounded down: BG under 130)" } },
    { "name": "round half up at 130+", "time": "12:00", "carbs": 76, "bg": 140,
      "expect": { "ok": true, "window": "Lunch", "meal_units": 9.5, "correction_units": 0, "raw_units": 9.5, "units": 10, "rounded_down": false } },
    { "name": "round down small snack", "time": "14:30", "carbs": 16, "bg": 120,
      "expect": { "ok": true, "window": "PM Snack", "meal_units": 1.6, "correction_units": 0, "raw_units": 1.6, "units": 1, "rounded_down": true } },
    { "name": "late night uses HS Snack", "time": "23:30", "carbs": 24, "bg": null,
      "expect": { "ok": true, "window": "HS Snack", "meal_units": 2, "correction_units": 0, "raw_units": 2, "units": 2, "rounded_down": false,
                  "breakdown": "24g ÷ 12 = 2.0 → 2u" } },
    { "name": "04:59 still HS Snack", "time": "04:59", "carbs": 30, "bg": null,
      "expect": { "ok": true, "window": "HS Snack", "meal_units": 2.5, "correction_units": 0, "raw_units": 2.5, "units": 3, "rounded_down": false,
                  "breakdown": "30g ÷ 12 = 2.5 → 3u" } },
    { "name": "05:00 is Breakfast", "time": "05:00", "carbs": 30, "bg": null,
      "expect": { "ok": true, "window": "Breakfast", "meal_units": 3.75, "correction_units": 0, "raw_units": 3.75, "units": 4, "rounded_down": false } },
    { "name": "08:59 is Breakfast", "time": "08:59", "carbs": 30, "bg": null,
      "expect": { "ok": true, "window": "Breakfast", "meal_units": 3.75, "correction_units": 0, "raw_units": 3.75, "units": 4, "rounded_down": false } },
    { "name": "09:00 is AM Snack", "time": "09:00", "carbs": 30, "bg": null,
      "expect": { "ok": true, "window": "AM Snack", "meal_units": 3, "correction_units": 0, "raw_units": 3, "units": 3, "rounded_down": false } },
    { "name": "full mode", "time": "18:00", "carbs": 72, "bg": 263,
      "correction": { "threshold": 200, "step": 50, "units_per_step": 1, "mode": "full" },
      "expect": { "ok": true, "window": "Dinner", "meal_units": 9, "correction_units": 1, "raw_units": 10, "units": 10, "rounded_down": false } },
    { "name": "full mode below one step", "time": "18:00", "carbs": 72, "bg": 249,
      "correction": { "threshold": 200, "step": 50, "units_per_step": 1, "mode": "full" },
      "expect": { "ok": true, "window": "Dinner", "meal_units": 9, "correction_units": 0, "raw_units": 9, "units": 9, "rounded_down": false } },
    { "name": "proportional mode", "time": "18:00", "carbs": 72, "bg": 275,
      "correction": { "threshold": 200, "step": 50, "units_per_step": 1, "mode": "proportional" },
      "expect": { "ok": true, "window": "Dinner", "meal_units": 9, "correction_units": 1.5, "raw_units": 10.5, "units": 11, "rounded_down": false } },
    { "name": "incomplete carbs", "time": "18:00", "carbs": 40, "complete": false, "bg": 150,
      "expect": { "ok": false, "reason": "incomplete_carbs", "window": "Dinner" } }
  ]
}
```

- [ ] **Step 3: Verify the seed `effective_from` timestamp**

Run: `node -e 'console.log(Date.UTC(2026,7,12))'`
Expected: `1786492800000`. If it differs, put the printed value in `dose-vectors.json`.

- [ ] **Step 4: Write the vector runner**

`packages/core/test/vectors.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import unitsVectors from '../../../testdata/units-vectors.json';
import doseVectors from '../../../testdata/dose-vectors.json';
import type { CorrectionRule, DoseSettingsData, FoodData, MealData, MealItemData, PortionData, RefType } from '../src/types';
import { createCatalog, itemCarbs, wouldCreateCycle } from '../src/carbs';
import { estimateDose, formatBreakdown, parseHHMM } from '../src/dose';
import { foodAmountToGrams, foodUnits, mealUnits } from '../src/units';

const u = unitsVectors as unknown as {
  tolerance: number;
  foods: FoodData[];
  portions: PortionData[];
  meals: MealData[];
  meal_items: MealItemData[];
  grams_cases: { name: string; food_id: string; amount: number; unit: string; expect: number | null }[];
  carb_cases: { name: string; ref_type: RefType; ref_id: string; amount: number; unit: string; expect: { carbs_g: number; complete: boolean } }[];
  unit_list_cases: { ref_type: RefType; ref_id: string; expect: string[] }[];
  cycle_cases: { meal_id: string; candidate: string; expect: boolean }[];
};

const d = doseVectors as unknown as {
  tolerance: number;
  settings: DoseSettingsData;
  cases: {
    name: string;
    time: string;
    carbs: number;
    complete?: boolean;
    bg: number | null;
    correction?: CorrectionRule;
    expect: Record<string, unknown>;
  }[];
};

const catalog = createCatalog(u);

describe('units vectors', () => {
  for (const c of u.grams_cases) {
    it(`grams: ${c.name}`, () => {
      const food = catalog.food(c.food_id)!;
      const grams = foodAmountToGrams(c.amount, c.unit, food, catalog.portions(c.food_id));
      if (c.expect === null) expect(grams).toBeNull();
      else expect(Math.abs(grams! - c.expect)).toBeLessThan(u.tolerance);
    });
  }
  for (const c of u.carb_cases) {
    it(`carbs: ${c.name}`, () => {
      const r = itemCarbs(catalog, c.ref_type, c.ref_id, c.amount, c.unit);
      expect(r.complete).toBe(c.expect.complete);
      expect(Math.abs(r.carbs_g - c.expect.carbs_g)).toBeLessThan(u.tolerance);
    });
  }
  for (const c of u.unit_list_cases) {
    it(`unit list: ${c.ref_id}`, () => {
      const units =
        c.ref_type === 'food'
          ? foodUnits(catalog.food(c.ref_id)!, catalog.portions(c.ref_id))
          : mealUnits(catalog.meal(c.ref_id)!);
      expect(units).toEqual(c.expect);
    });
  }
  for (const c of u.cycle_cases) {
    it(`cycle: ${c.candidate} into ${c.meal_id}`, () => {
      expect(wouldCreateCycle(catalog, c.meal_id, c.candidate)).toBe(c.expect);
    });
  }
});

describe('dose vectors', () => {
  for (const c of d.cases) {
    it(c.name, () => {
      const settings = c.correction ? { ...d.settings, correction: c.correction } : d.settings;
      const r = estimateDose({
        settings,
        minutes: parseHHMM(c.time),
        carbs: { carbs_g: c.carbs, complete: c.complete ?? true },
        bg: c.bg,
      });
      const e = c.expect;
      expect(r.ok).toBe(e.ok);
      expect(r.window?.name ?? null).toBe(e.window ?? null);
      if (!r.ok) {
        expect(r.reason).toBe(e.reason);
        return;
      }
      for (const key of ['meal_units', 'correction_units', 'raw_units', 'units'] as const) {
        expect(Math.abs(r[key] - (e[key] as number)), key).toBeLessThan(d.tolerance);
      }
      expect(r.rounded_down).toBe(e.rounded_down);
      if (typeof e.breakdown === 'string') expect(formatBreakdown(r)).toBe(e.breakdown);
    });
  }
});
```

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @carbbook/core test`
Expected: every vector case passes (8 grams, 12 carbs, 5 unit lists, 3 cycles, 17 dose cases). A failure here means the implementation and the confirmed rules disagree; fix the implementation, never the vector, unless Step 3 showed a different timestamp.

- [ ] **Step 6: Commit**

```bash
git add testdata packages/core/test/vectors.test.ts
git commit -m "test: shared unit, carb and dose vectors"
```

---

### Task 8: Public exports and final verification

**Files:**
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/test/smoke.test.ts`
- Modify: `docs/superpowers/specs/2026-09-13-carbbook-design.md` (§4.1 meal units)

- [ ] **Step 1: Update the smoke test to import through the package entry**

`packages/core/test/smoke.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import * as core from '../src/index';

describe('core package', () => {
  it('exports the public API', () => {
    expect(core.CORE_VERSION).toBe('0.1.0');
    for (const name of [
      'createCatalog', 'itemCarbs', 'sumCarbs', 'wouldCreateCycle',
      'foodAmountToGrams', 'foodUnits', 'mealUnits', 'densityOf',
      'estimateDose', 'formatBreakdown', 'pickWindow', 'correctionUnits', 'roundDose',
      'activeSettings', 'recentDoseWarning', 'parseHHMM', 'minutesOfDay', 'isNewer',
    ]) {
      expect(typeof (core as Record<string, unknown>)[name], name).toBe('function');
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @carbbook/core test smoke`
Expected: FAIL on `createCatalog` (`expected 'undefined' to be 'function'`).

- [ ] **Step 3: Write `index.ts`**

```ts
export const CORE_VERSION = '0.1.0';
export type * from './types';
export * from './units';
export * from './carbs';
export * from './dose';
export * from './sync';
```

- [ ] **Step 4: Run the full suite and typecheck**

Run: `cd ~/Projects/CarbBook && pnpm test && pnpm typecheck`
Expected: all test files pass; tsc exits 0.

- [ ] **Step 5: Align the spec with the unit list decision**

In `docs/superpowers/specs/2026-09-13-carbbook-design.md` §4.1, replace
`- Meals: \`serving\` always; \`g\` when \`total_weight_g\` is set.`
with
`- Meals: \`serving\` always; mass units (g, kg, oz, lb) when \`total_weight_g\` is set.`

- [ ] **Step 6: Commit**

```bash
git add packages/core docs/superpowers/specs/2026-09-13-carbbook-design.md
git commit -m "feat(core): export public API"
```
