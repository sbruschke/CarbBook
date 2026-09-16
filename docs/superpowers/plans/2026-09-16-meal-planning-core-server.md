# Meal Planning — Core + Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add carb-goal colour logic and the synced `plan_entry`/`plan_item` data model to `@carbbook/core` and `@carbbook/server`, so the web and iOS plan screens (separate plans) have a working, tested foundation.

**Architecture:** Core gets one new pure module (`packages/core/src/goal.ts`) holding `goalStatus`, `dayGoal` and `isValidCarbGoal`, plus new row types in `types.ts` and a `carb_goal` field on `DoseWindow` that dose math never reads. Server gets migration `004_meal_plan.sql` (two new tables, no change to existing ones), two new entries in `TABLE_SPECS`, three new push rules (`duplicate_slot`, `log_entry_id` must exist, revert plan entries when a log entry is soft-deleted), and a second seeded `dose_settings` version carrying the user's per-window goals. Cross-language behaviour is pinned by `testdata/goal-vectors.json`, shaped so the Swift `VectorTests` can decode it the same way it decodes `units-vectors.json`.

**Tech Stack:** pnpm workspace, Node 25, TypeScript 7, Vitest 5, better-sqlite3 13, Fastify 5.

---

## Background the engineer needs

Read these before starting:

- Spec (source of truth): `docs/superpowers/specs/2026-09-16-meal-planning-design.md`
- Base design §3 (data model) and §5 (sync): `docs/superpowers/specs/2026-09-13-carbbook-design.md`

Facts that shape the code below:

- **Every synced table** carries `id, updated_at, updated_by, deleted, server_seq`. `server_seq` is handed out by `nextServerSeq(db)` (`server/src/db.ts:38`) inside the writing transaction.
- **Migrations** are plain `NNN_name.sql` files in `server/migrations/`. `migrate()` (`server/src/db.ts:19`) runs each file newer than `PRAGMA user_version` inside its own transaction and bumps `user_version` in the same transaction — so any failure in a migration file rolls the whole file back and leaves `user_version` where it was. The live Pi DB is at `user_version` 3 with real rows.
- **No foreign keys on synced tables.** `openDb` sets `PRAGMA foreign_keys = ON`, but synced tables deliberately use plain TEXT reference columns (see the comment at `server/src/sync/tables.ts:104-110`): offline-first clients may push a child before its parent syncs.
- **Push validation** is two-layered: `validateRecord` (`server/src/sync/validate.ts:45`) checks fields from the table spec, then `applyPush`/`applyOne` (`server/src/sync/push.ts:102`) applies rules that need the database. Per-record results are `accepted` / `ignored` / `rejected` with a `reason`.
- **`dose_settings` is append-only** (`server/src/sync/push.ts:85`): an existing version cannot be edited or deleted. Content equality is compared on the serialized JSON, which is why `canonicalizeWindows` fixes key order. Any new key added to a window MUST be added to the canonicalizer too, or a byte-identical republish would look like an edit.
- **Shared vectors** live in `testdata/` at the repo root, are run by `packages/core/test/vectors.test.ts` in TS, and are copied into the Swift test bundle by `ios/scripts/sync-testdata.sh`.

Commands used throughout:

```bash
pnpm --filter @carbbook/core test          # all core tests
pnpm --filter @carbbook/server test        # all server tests
pnpm -r typecheck                          # typecheck every package
```

To run a single test file: `pnpm --filter @carbbook/core exec vitest run test/goal.test.ts`.

---

## File Structure

**Create:**

| File | Responsibility |
| --- | --- |
| `packages/core/src/goal.ts` | `CarbGoal` validity, `goalStatus`, `dayGoal`, screen-reader labels. Pure; no I/O. |
| `packages/core/test/goal.test.ts` | Unit tests for the three functions, including inputs JSON cannot express (NaN, wrong shapes). |
| `testdata/goal-vectors.json` | Cross-language vectors: status boundaries, day totals, goal validity. |
| `server/migrations/004_meal_plan.sql` | `plan_entry` + `plan_item` tables, indexes, CHECKs, partial unique slot index. |
| `server/test/migration-004.test.ts` | Migration behaviour on a v3 DB with real rows, constraint coverage, clean abort. |
| `server/test/sync-plan.test.ts` | Plan-specific push rules: duplicate slot, `log_entry_id`, revert-on-log-delete, round trip. |

**Modify:**

| File | Change |
| --- | --- |
| `packages/core/src/types.ts` | Add `CarbGoal`; add `carb_goal?: CarbGoal \| null` to `DoseWindow`; add `PlanStatus`, `PlanEntryData`, `PlanItemData`. |
| `packages/core/src/index.ts` | `export * from './goal';` |
| `packages/core/test/vectors.test.ts` | Third `describe` block running `goal-vectors.json`. |
| `packages/core/test/dose.test.ts` | One test proving `carb_goal` does not change a dose estimate. |
| `ios/scripts/sync-testdata.sh` | Copy `goal-vectors.json` into the core test bundle. |
| `server/src/sync/tables.ts` | `plan_entry` / `plan_item` specs + `SYNC_TABLES`; `carb_goal` in `checkWindows` and `canonicalizeWindows`; `isValidPlanDate`. |
| `server/src/sync/push.ts` | `duplicate_slot` reason; plan-entry rules; revert plan entries when a log entry is soft-deleted. |
| `server/src/seed.ts` | `SEED_GOAL_WINDOWS` + a second `SEED_DOSE_SETTINGS` version. |
| `server/test/seed.test.ts`, `server/test/sync-pull.test.ts`, `server/test/sync-push.test.ts`, `server/test/sync-routes.test.ts` | Update the `server_seq` baseline now that seeding writes two rows. |

**Design decision — where the "log entry deleted → slot back to planned" rule lives:** on the **server**, in `applyPush`, as a side effect of accepting a `log_entry` row with `deleted = 1`. The client is the wrong place: the device that deletes a log entry may never have held that plan row (viewer devices sync a subset lazily), and two devices deleting concurrently would each need the same repair. Doing it server-side means the revert happens exactly once, gets a fresh `server_seq`, and reaches every device through the ordinary pull. Task 13 implements it.

---

## Task 1: `CarbGoal` type and `isValidCarbGoal`

**Files:**
- Modify: `packages/core/src/types.ts`
- Create: `packages/core/src/goal.ts`
- Modify: `packages/core/src/index.ts`
- Create: `packages/core/test/goal.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/goal.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { isValidCarbGoal } from '../src/goal';

describe('isValidCarbGoal', () => {
  it.each([
    [{ min: 30, max: 50 }],
    [{ min: 0, max: 0 }],
    [{ min: 0, max: 2000 }],
    [{ min: 50, max: 50 }],
  ])('accepts %j', (goal) => {
    expect(isValidCarbGoal(goal)).toBe(true);
  });

  it.each([
    [null],
    [undefined],
    [{ min: 50, max: 40 }],
    [{ min: -1, max: 50 }],
    [{ min: 0, max: 2001 }],
    [{ min: Number.NaN, max: 50 }],
    [{ min: 30, max: Number.POSITIVE_INFINITY }],
    [{ min: 30 }],
    [{ max: 50 }],
    [{ min: '30', max: '50' }],
    [[30, 50]],
    ['30-50'],
  ])('rejects %j', (goal) => {
    expect(isValidCarbGoal(goal)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @carbbook/core exec vitest run test/goal.test.ts`
Expected: FAIL — `Failed to resolve import "../src/goal"`.

- [ ] **Step 3: Add the `CarbGoal` type**

In `packages/core/src/types.ts`, add immediately above `export interface DoseWindow` (currently line 98):

```ts
/** Per-window carb target (meal-planning spec §2). Both bounds finite, 0 <= min <= max <= 2000. */
export interface CarbGoal {
  min: number;
  max: number;
}
```

- [ ] **Step 4: Write the minimal implementation**

Create `packages/core/src/goal.ts`:

```ts
import { DOSE_LIMITS } from './dose';
import type { CarbGoal } from './types';

/**
 * A carb goal is usable when both bounds are finite and 0 <= min <= max <= DOSE_LIMITS.maxCarbsG.
 * `null`/`undefined` (no goal for that window) is not an error — it is simply not a goal.
 */
export function isValidCarbGoal(value: unknown): value is CarbGoal {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const { min, max } = value as { min?: unknown; max?: unknown };
  if (typeof min !== 'number' || !Number.isFinite(min)) return false;
  if (typeof max !== 'number' || !Number.isFinite(max)) return false;
  return min >= 0 && min <= max && max <= DOSE_LIMITS.maxCarbsG;
}
```

- [ ] **Step 5: Export it from the package entry point**

In `packages/core/src/index.ts`, add after `export * from './dose';`:

```ts
export * from './goal';
```

- [ ] **Step 6: Run the test and the typecheck**

Run: `pnpm --filter @carbbook/core exec vitest run test/goal.test.ts`
Expected: PASS (16 tests).

Run: `pnpm -r typecheck`
Expected: exits 0, no output beyond pnpm's per-package banners.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/goal.ts packages/core/src/index.ts packages/core/test/goal.test.ts
git commit -m "feat(core): add CarbGoal type and isValidCarbGoal"
```

---

## Task 2: `goalStatus`

**Files:**
- Modify: `packages/core/src/goal.ts`
- Modify: `packages/core/test/goal.test.ts`

The rule from spec §3:

```
d = 0 if goal.min <= carbs <= goal.max
    else min(|carbs - goal.min|, |carbs - goal.max|)
d == 0 → in;  d <= 5 → near;  d <= 10 → off;  else out
```

- [ ] **Step 1: Write the failing test**

Append to `packages/core/test/goal.test.ts`:

```ts
import { GOAL_STATUS_LABELS, goalStatus } from '../src/goal';

const complete = (carbs_g: number) => ({ carbs_g, complete: true });
const GOAL = { min: 50, max: 80 };

describe('goalStatus', () => {
  it.each([
    [50, 'in'],
    [65, 'in'],
    [80, 'in'],
    [49.9, 'near'],
    [45, 'near'],
    [80.1, 'near'],
    [85, 'near'],
    [44.9, 'off'],
    [40, 'off'],
    [85.1, 'off'],
    [90, 'off'],
    [39.9, 'out'],
    [0, 'out'],
    [90.1, 'out'],
    [200, 'out'],
  ])('carbs %s against 50-80 is %s', (carbs, expected) => {
    expect(goalStatus(complete(carbs), GOAL)).toBe(expected);
  });

  it('is "none" when there is no goal', () => {
    expect(goalStatus(complete(65), null)).toBe('none');
    expect(goalStatus(complete(65), undefined)).toBe('none');
  });

  it('is "none" when the goal is not usable', () => {
    expect(goalStatus(complete(65), { min: 80, max: 50 })).toBe('none');
  });

  it('is "none" when the carbs are incomplete, even inside the goal', () => {
    expect(goalStatus({ carbs_g: 65, complete: false }, GOAL)).toBe('none');
  });

  it('is "none" when the carb total is not finite', () => {
    expect(goalStatus({ carbs_g: Number.NaN, complete: true }, GOAL)).toBe('none');
  });

  it('treats a zero-width goal as reachable', () => {
    expect(goalStatus(complete(0), { min: 0, max: 0 })).toBe('in');
    expect(goalStatus(complete(5), { min: 0, max: 0 })).toBe('near');
  });

  it('has a screen-reader label for every status', () => {
    expect(Object.keys(GOAL_STATUS_LABELS).sort()).toEqual(['in', 'near', 'none', 'off', 'out']);
    expect(GOAL_STATUS_LABELS.in).toBe('in goal');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @carbbook/core exec vitest run test/goal.test.ts`
Expected: FAIL — `"goalStatus" is not exported by "src/goal.ts"`.

- [ ] **Step 3: Write the implementation**

Append to `packages/core/src/goal.ts` (and extend its import line to `import type { CarbGoal, DoseWindow } from './types';` is NOT needed yet — only `CarbResult`):

```ts
import type { CarbResult } from './carbs';

export type GoalStatus = 'none' | 'in' | 'near' | 'off' | 'out';

/** Distance bands from spec §3: within 5 g is yellow, within 10 g is orange, beyond is red. */
export const GOAL_NEAR_G = 5;
export const GOAL_OFF_G = 10;

/**
 * Float slack so a boundary written as 5.0 or 10.0 lands in the band the spec names, rather than
 * one band out because of binary rounding. Same constant and intent as EPS in dose.ts.
 */
const EPS = 1e-9;

/** Short labels for screen readers; the UI shows numbers too — colour is never the only signal. */
export const GOAL_STATUS_LABELS: Readonly<Record<GoalStatus, string>> = Object.freeze({
  none: 'no goal',
  in: 'in goal',
  near: 'near goal',
  off: 'off goal',
  out: 'outside goal',
});

/** Colour band for a carb total against one window's goal (spec §3). */
export function goalStatus(carbs: CarbResult, goal: CarbGoal | null | undefined): GoalStatus {
  if (!isValidCarbGoal(goal)) return 'none';
  if (!carbs.complete || !Number.isFinite(carbs.carbs_g)) return 'none';
  const value = carbs.carbs_g;
  if (value >= goal.min && value <= goal.max) return 'in';
  const distance = Math.min(Math.abs(value - goal.min), Math.abs(value - goal.max));
  if (distance <= GOAL_NEAR_G + EPS) return 'near';
  if (distance <= GOAL_OFF_G + EPS) return 'off';
  return 'out';
}
```

Put the `import type { CarbResult } from './carbs';` line at the top of the file with the other imports, not in the middle.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @carbbook/core exec vitest run test/goal.test.ts`
Expected: PASS (all `goalStatus` cases green).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/goal.ts packages/core/test/goal.test.ts
git commit -m "feat(core): add goalStatus with the spec's distance bands"
```

---

## Task 3: `dayGoal`

**Files:**
- Modify: `packages/core/src/goal.ts`
- Modify: `packages/core/test/goal.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/core/test/goal.test.ts`:

```ts
import { dayGoal } from '../src/goal';
import type { DoseWindow } from '../src/types';

const window = (name: string, start: string, carb_goal: { min: number; max: number } | null): DoseWindow => ({
  name,
  start,
  ratio_g_per_unit: 8,
  carb_goal,
});

describe('dayGoal', () => {
  it('sums the goals of the windows that have one', () => {
    expect(
      dayGoal([
        window('Breakfast', '05:00', { min: 30, max: 50 }),
        window('Lunch', '11:00', { min: 50, max: 80 }),
      ]),
    ).toEqual({ min: 80, max: 130 });
  });

  it('ignores windows without a goal', () => {
    expect(
      dayGoal([
        window('Breakfast', '05:00', { min: 30, max: 50 }),
        window('AM Snack', '09:00', null),
        { name: 'Lunch', start: '11:00', ratio_g_per_unit: 8 },
      ]),
    ).toEqual({ min: 30, max: 50 });
  });

  it('ignores windows whose goal is unusable', () => {
    expect(
      dayGoal([window('Breakfast', '05:00', { min: 30, max: 50 }), window('Lunch', '11:00', { min: 90, max: 10 })]),
    ).toEqual({ min: 30, max: 50 });
  });

  it('is null when no window in the day has a goal', () => {
    expect(dayGoal([window('Breakfast', '05:00', null), window('Lunch', '11:00', null)])).toBeNull();
    expect(dayGoal([])).toBeNull();
  });

  it('produces a goal that goalStatus can use for a day total', () => {
    const goal = dayGoal([window('Breakfast', '05:00', { min: 30, max: 50 }), window('Lunch', '11:00', { min: 50, max: 80 })]);
    expect(goalStatus({ carbs_g: 100, complete: true }, goal)).toBe('in');
    expect(goalStatus({ carbs_g: 134, complete: true }, goal)).toBe('near');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @carbbook/core exec vitest run test/goal.test.ts`
Expected: FAIL — `"dayGoal" is not exported by "src/goal.ts"`.

- [ ] **Step 3: Write the implementation**

Append to `packages/core/src/goal.ts` (and add `DoseWindow` to the existing `import type { CarbGoal } from './types';` line, making it `import type { CarbGoal, DoseWindow } from './types';`):

```ts
/**
 * A day's combined goal: the sum of the goals of the day's windows. Windows without a usable goal
 * contribute nothing to either bound; a day where no window has a goal has no goal at all (null),
 * which `goalStatus` renders as `none` (spec §3).
 */
export function dayGoal(windows: DoseWindow[]): CarbGoal | null {
  let min = 0;
  let max = 0;
  let found = false;
  for (const w of windows) {
    const goal = w.carb_goal;
    if (!isValidCarbGoal(goal)) continue;
    min += goal.min;
    max += goal.max;
    found = true;
  }
  return found ? { min, max } : null;
}
```

This needs `carb_goal` on `DoseWindow`, which Task 4 adds. If you are executing tasks strictly in order, do Task 4 Step 3 now (it is a one-line type change) and the typecheck will pass.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @carbbook/core exec vitest run test/goal.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/goal.ts packages/core/test/goal.test.ts
git commit -m "feat(core): add dayGoal summing a day's window goals"
```

---

## Task 4: `carb_goal` on `DoseWindow`, provably inert for dosing

**Files:**
- Modify: `packages/core/src/types.ts:98-102`
- Modify: `packages/core/test/dose.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/core/test/dose.test.ts`:

```ts
describe('carb_goal does not affect dose math', () => {
  it('produces an identical estimate with and without carb_goal on the window', () => {
    const base: DoseSettingsData = {
      id: 'settings-goal-check',
      effective_from: 0,
      windows: [
        { name: 'Breakfast', start: '05:00', ratio_g_per_unit: 8 },
        { name: 'Lunch', start: '11:00', ratio_g_per_unit: 8 },
      ],
      correction: { threshold: 200, step: 50, units_per_step: 1, mode: 'started' },
      rounding: { increment: 1, round_down_below_bg: 130 },
    };
    const withGoals: DoseSettingsData = {
      ...base,
      windows: [
        { name: 'Breakfast', start: '05:00', ratio_g_per_unit: 8, carb_goal: { min: 30, max: 50 } },
        { name: 'Lunch', start: '11:00', ratio_g_per_unit: 8, carb_goal: null },
      ],
    };
    const input = { minutes: 12 * 60, carbs: { carbs_g: 72, complete: true }, bg: 263 };
    const plain = estimateDose({ settings: base, ...input });
    const goals = estimateDose({ settings: withGoals, ...input });
    expect(plain.ok).toBe(true);
    if (!plain.ok || !goals.ok) throw new Error('expected both estimates to succeed');
    expect(goals.units).toBe(plain.units);
    expect(goals.meal_units).toBe(plain.meal_units);
    expect(goals.correction_units).toBe(plain.correction_units);
    expect(goals.raw_units).toBe(plain.raw_units);
    expect(formatBreakdown(goals)).toBe(formatBreakdown(plain));
  });

  it('still rejects a nonsense carb_goal without changing the dose', () => {
    const settings: DoseSettingsData = {
      id: 'settings-bad-goal',
      effective_from: 0,
      windows: [{ name: 'All day', start: '00:00', ratio_g_per_unit: 10, carb_goal: { min: 90, max: 10 } }],
      correction: { threshold: 200, step: 50, units_per_step: 1, mode: 'started' },
      rounding: { increment: 1, round_down_below_bg: null },
    };
    const estimate = estimateDose({ settings, minutes: 600, carbs: { carbs_g: 50, complete: true }, bg: null });
    expect(estimate).toMatchObject({ ok: true, units: 5 });
  });
});
```

Make sure the file's existing imports cover `estimateDose`, `formatBreakdown` and `type DoseSettingsData`; add whichever is missing to the import at the top of `packages/core/test/dose.test.ts`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @carbbook/core exec vitest run test/dose.test.ts`
Expected: FAIL — TypeScript error `Object literal may only specify known properties, and 'carb_goal' does not exist in type 'DoseWindow'`.

- [ ] **Step 3: Add the field**

In `packages/core/src/types.ts`, replace the `DoseWindow` interface:

```ts
export interface DoseWindow {
  name: string;
  start: string; // "HH:MM", 24-hour local time
  ratio_g_per_unit: number;
  /**
   * Per-window carb target for the Plan screen's colour feedback (meal-planning spec §2).
   * Dose math never reads this: estimateDose only uses name/start/ratio_g_per_unit.
   */
  carb_goal?: CarbGoal | null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @carbbook/core test`
Expected: PASS — all core suites green, including the untouched `vectors` suites.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/types.ts packages/core/test/dose.test.ts
git commit -m "feat(core): allow carb_goal on dose windows, inert for dosing"
```

---

## Task 5: `plan_entry` / `plan_item` types

**Files:**
- Modify: `packages/core/src/types.ts` (append at the end of the file)
- Create: nothing; covered by the typecheck and by later server tests.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/test/goal.test.ts`:

```ts
import type { PlanEntryData, PlanItemData, PlanStatus } from '../src/types';

describe('plan row types', () => {
  it('describes a planned slot and its items', () => {
    const statuses: PlanStatus[] = ['planned', 'logged', 'skipped'];
    const entry: PlanEntryData = {
      id: 'pe1',
      date: '2026-09-17',
      window_name: 'Lunch',
      status: 'planned',
      note: null,
      log_entry_id: null,
    };
    const item: PlanItemData = {
      id: 'pi1',
      plan_entry_id: entry.id,
      ref_type: 'food',
      ref_id: 'f1',
      amount: 1,
      unit: 'g',
      position: 0,
    };
    expect(statuses).toContain(entry.status);
    expect(item.plan_entry_id).toBe('pe1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @carbbook/core exec vitest run test/goal.test.ts`
Expected: FAIL — `Module '"../src/types"' has no exported member 'PlanEntryData'`.

- [ ] **Step 3: Add the types**

Append to `packages/core/src/types.ts`:

```ts
export type PlanStatus = 'planned' | 'logged' | 'skipped';

/** One planned meal slot (meal-planning spec §2). At most one non-deleted row per date+window. */
export interface PlanEntryData {
  id: Id;
  /** Local calendar day, "YYYY-MM-DD". */
  date: string;
  /** Matches a dose-settings window name. */
  window_name: string;
  status: PlanStatus;
  note?: string | null;
  /** Set when this slot was logged from the Calculator; cleared if that log entry is deleted. */
  log_entry_id?: Id | null;
}

/** A row inside a planned slot: same shape as log_item minus the snapshot fields. */
export interface PlanItemData {
  id: Id;
  plan_entry_id: Id;
  ref_type: RefType;
  ref_id: Id;
  amount: number;
  unit: string;
  position: number;
}
```

- [ ] **Step 4: Run test and typecheck**

Run: `pnpm --filter @carbbook/core exec vitest run test/goal.test.ts`
Expected: PASS.

Run: `pnpm -r typecheck`
Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/types.ts packages/core/test/goal.test.ts
git commit -m "feat(core): add plan_entry and plan_item row types"
```

---

## Task 6: Shared goal vectors

**Files:**
- Create: `testdata/goal-vectors.json`
- Modify: `packages/core/test/vectors.test.ts`
- Modify: `ios/scripts/sync-testdata.sh`

The JSON shape is constrained by the Swift decoder in `ios/CarbBookCore/Tests/CarbBookCoreTests/VectorTests.swift`: every field must map to a concrete `Decodable` type. That is why `goal` is always either `null` or an object of two numbers (never a malformed shape) and why there is no NaN case here — those live in `packages/core/test/goal.test.ts` instead.

- [ ] **Step 1: Write the vectors file**

Create `testdata/goal-vectors.json`:

```json
{
  "tolerance": 0.001,
  "status_cases": [
    { "name": "exactly min", "carbs": 50, "goal": { "min": 50, "max": 80 }, "expect": "in" },
    { "name": "mid range", "carbs": 65, "goal": { "min": 50, "max": 80 }, "expect": "in" },
    { "name": "exactly max", "carbs": 80, "goal": { "min": 50, "max": 80 }, "expect": "in" },
    { "name": "just under min", "carbs": 49.9, "goal": { "min": 50, "max": 80 }, "expect": "near" },
    { "name": "exactly 5 under min", "carbs": 45, "goal": { "min": 50, "max": 80 }, "expect": "near" },
    { "name": "just over max", "carbs": 80.1, "goal": { "min": 50, "max": 80 }, "expect": "near" },
    { "name": "exactly 5 over max", "carbs": 85, "goal": { "min": 50, "max": 80 }, "expect": "near" },
    { "name": "just past 5 under min", "carbs": 44.9, "goal": { "min": 50, "max": 80 }, "expect": "off" },
    { "name": "exactly 10 under min", "carbs": 40, "goal": { "min": 50, "max": 80 }, "expect": "off" },
    { "name": "just past 5 over max", "carbs": 85.1, "goal": { "min": 50, "max": 80 }, "expect": "off" },
    { "name": "exactly 10 over max", "carbs": 90, "goal": { "min": 50, "max": 80 }, "expect": "off" },
    { "name": "just past 10 under min", "carbs": 39.9, "goal": { "min": 50, "max": 80 }, "expect": "out" },
    { "name": "just past 10 over max", "carbs": 90.1, "goal": { "min": 50, "max": 80 }, "expect": "out" },
    { "name": "nothing eaten against a goal", "carbs": 0, "goal": { "min": 50, "max": 80 }, "expect": "out" },
    { "name": "far over", "carbs": 200, "goal": { "min": 50, "max": 80 }, "expect": "out" },
    { "name": "snack goal in range", "carbs": 20, "goal": { "min": 10, "max": 30 }, "expect": "in" },
    { "name": "snack goal 10 over", "carbs": 40, "goal": { "min": 10, "max": 30 }, "expect": "off" },
    { "name": "zero width goal hit", "carbs": 0, "goal": { "min": 0, "max": 0 }, "expect": "in" },
    { "name": "zero width goal 5 over", "carbs": 5, "goal": { "min": 0, "max": 0 }, "expect": "near" },
    { "name": "no goal", "carbs": 65, "goal": null, "expect": "none" },
    { "name": "no goal and nothing eaten", "carbs": 0, "goal": null, "expect": "none" },
    { "name": "incomplete carbs inside the goal", "carbs": 65, "complete": false, "goal": { "min": 50, "max": 80 }, "expect": "none" },
    { "name": "incomplete carbs outside the goal", "carbs": 5, "complete": false, "goal": { "min": 50, "max": 80 }, "expect": "none" },
    { "name": "invalid goal min above max", "carbs": 65, "goal": { "min": 80, "max": 50 }, "expect": "none" },
    { "name": "invalid goal negative min", "carbs": 65, "goal": { "min": -1, "max": 80 }, "expect": "none" },
    { "name": "invalid goal max above limit", "carbs": 65, "goal": { "min": 0, "max": 2001 }, "expect": "none" }
  ],
  "day_cases": [
    {
      "name": "breakfast plus lunch",
      "windows": [
        { "name": "Breakfast", "start": "05:00", "ratio_g_per_unit": 8, "carb_goal": { "min": 30, "max": 50 } },
        { "name": "Lunch", "start": "11:00", "ratio_g_per_unit": 8, "carb_goal": { "min": 50, "max": 80 } }
      ],
      "expect": { "min": 80, "max": 130 }
    },
    {
      "name": "full seeded day",
      "windows": [
        { "name": "Breakfast", "start": "05:00", "ratio_g_per_unit": 8, "carb_goal": { "min": 30, "max": 50 } },
        { "name": "AM Snack", "start": "09:00", "ratio_g_per_unit": 10, "carb_goal": { "min": 10, "max": 30 } },
        { "name": "Lunch", "start": "11:00", "ratio_g_per_unit": 8, "carb_goal": { "min": 50, "max": 80 } },
        { "name": "PM Snack", "start": "14:00", "ratio_g_per_unit": 10, "carb_goal": { "min": 10, "max": 30 } },
        { "name": "Dinner", "start": "16:30", "ratio_g_per_unit": 8, "carb_goal": { "min": 50, "max": 80 } },
        { "name": "HS Snack", "start": "19:30", "ratio_g_per_unit": 12, "carb_goal": { "min": 10, "max": 30 } }
      ],
      "expect": { "min": 160, "max": 300 }
    },
    {
      "name": "windows without a goal contribute nothing",
      "windows": [
        { "name": "Breakfast", "start": "05:00", "ratio_g_per_unit": 8, "carb_goal": { "min": 30, "max": 50 } },
        { "name": "AM Snack", "start": "09:00", "ratio_g_per_unit": 10, "carb_goal": null },
        { "name": "Lunch", "start": "11:00", "ratio_g_per_unit": 8 }
      ],
      "expect": { "min": 30, "max": 50 }
    },
    {
      "name": "unusable goals are skipped",
      "windows": [
        { "name": "Breakfast", "start": "05:00", "ratio_g_per_unit": 8, "carb_goal": { "min": 30, "max": 50 } },
        { "name": "Lunch", "start": "11:00", "ratio_g_per_unit": 8, "carb_goal": { "min": 90, "max": 10 } }
      ],
      "expect": { "min": 30, "max": 50 }
    },
    {
      "name": "no window in the day has a goal",
      "windows": [
        { "name": "Breakfast", "start": "05:00", "ratio_g_per_unit": 8, "carb_goal": null },
        { "name": "Lunch", "start": "11:00", "ratio_g_per_unit": 8 }
      ],
      "expect": null
    },
    { "name": "no windows at all", "windows": [], "expect": null }
  ],
  "day_status_cases": [
    { "name": "day total in the summed goal", "carbs": 200, "day_goal": { "min": 160, "max": 300 }, "expect": "in" },
    { "name": "day total 5 under the summed goal", "carbs": 155, "day_goal": { "min": 160, "max": 300 }, "expect": "near" },
    { "name": "day total 10 over the summed goal", "carbs": 310, "day_goal": { "min": 160, "max": 300 }, "expect": "off" },
    { "name": "day total far under", "carbs": 100, "day_goal": { "min": 160, "max": 300 }, "expect": "out" },
    { "name": "day with no goal", "carbs": 200, "day_goal": null, "expect": "none" }
  ],
  "valid_cases": [
    { "name": "ordinary goal", "goal": { "min": 30, "max": 50 }, "expect": true },
    { "name": "zero width", "goal": { "min": 50, "max": 50 }, "expect": true },
    { "name": "zero to zero", "goal": { "min": 0, "max": 0 }, "expect": true },
    { "name": "at the upper limit", "goal": { "min": 0, "max": 2000 }, "expect": true },
    { "name": "min above max", "goal": { "min": 80, "max": 50 }, "expect": false },
    { "name": "negative min", "goal": { "min": -1, "max": 50 }, "expect": false },
    { "name": "max above the limit", "goal": { "min": 0, "max": 2001 }, "expect": false }
  ]
}
```

- [ ] **Step 2: Write the Vitest runner**

Append to `packages/core/test/vectors.test.ts`, and extend its imports so the file starts with these (keep the existing lines, add the new ones):

```ts
import goalVectors from '../../../testdata/goal-vectors.json';
import type { CarbGoal, DoseWindow } from '../src/types';
import { dayGoal, goalStatus, isValidCarbGoal, type GoalStatus } from '../src/goal';
```

Then append the new describe block:

```ts
const g = goalVectors as unknown as {
  tolerance: number;
  status_cases: { name: string; carbs: number; complete?: boolean; goal: CarbGoal | null; expect: GoalStatus }[];
  day_cases: { name: string; windows: DoseWindow[]; expect: CarbGoal | null }[];
  day_status_cases: { name: string; carbs: number; day_goal: CarbGoal | null; expect: GoalStatus }[];
  valid_cases: { name: string; goal: CarbGoal; expect: boolean }[];
};

describe('goal vectors', () => {
  it('has cases to run', () => {
    expect(g.status_cases.length).toBeGreaterThan(0);
    expect(g.day_cases.length).toBeGreaterThan(0);
    expect(g.day_status_cases.length).toBeGreaterThan(0);
    expect(g.valid_cases.length).toBeGreaterThan(0);
  });
  for (const c of g.status_cases) {
    it(`status: ${c.name}`, () => {
      expect(goalStatus({ carbs_g: c.carbs, complete: c.complete ?? true }, c.goal)).toBe(c.expect);
    });
  }
  for (const c of g.day_cases) {
    it(`day goal: ${c.name}`, () => {
      const result = dayGoal(c.windows);
      if (c.expect === null) {
        expect(result).toBeNull();
        return;
      }
      expect(Math.abs(result!.min - c.expect.min)).toBeLessThan(g.tolerance);
      expect(Math.abs(result!.max - c.expect.max)).toBeLessThan(g.tolerance);
    });
  }
  for (const c of g.day_status_cases) {
    it(`day status: ${c.name}`, () => {
      expect(goalStatus({ carbs_g: c.carbs, complete: true }, c.day_goal)).toBe(c.expect);
    });
  }
  for (const c of g.valid_cases) {
    it(`validity: ${c.name}`, () => {
      expect(isValidCarbGoal(c.goal)).toBe(c.expect);
    });
  }
});
```

- [ ] **Step 3: Run the vectors suite**

Run: `pnpm --filter @carbbook/core exec vitest run test/vectors.test.ts`
Expected: PASS — the existing `units vectors` and `dose vectors` describes are unchanged and still green, plus a new `goal vectors` describe with 43 passing cases.

- [ ] **Step 4: Teach the iOS sync script about the new file**

In `ios/scripts/sync-testdata.sh`, change the core loop:

```bash
for name in units-vectors.json dose-vectors.json goal-vectors.json; do
  sync_one "$name" "$core_dest" "${1:-}"
done
```

- [ ] **Step 5: Copy the vectors into the Swift bundle**

Run: `ios/scripts/sync-testdata.sh`
Expected output: `testdata vectors in sync`, and `ios/CarbBookCore/Tests/CarbBookCoreTests/Resources/goal-vectors.json` now exists.

Run: `ios/scripts/sync-testdata.sh --check`
Expected output: `testdata vectors in sync` (exit 0).

The Swift `VectorTests` case that consumes this file is written in the iOS plan, not here.

- [ ] **Step 6: Commit**

```bash
git add testdata/goal-vectors.json packages/core/test/vectors.test.ts ios/scripts/sync-testdata.sh ios/CarbBookCore/Tests/CarbBookCoreTests/Resources/goal-vectors.json
git commit -m "test(core): add shared goal vectors for TS and Swift"
```

---

## Task 7: Accept `carb_goal` inside pushed `dose_settings`

**Files:**
- Modify: `server/src/sync/tables.ts:38-60` (`checkWindows`) and `:95-96` (`canonicalizeWindows`)
- Modify: `server/test/sync-validate.test.ts`

Remember the append-only rule: `canonicalizeWindows` must include `carb_goal` (and canonicalize its inner key order), or re-pushing an identical settings version with the keys in a different order would be misread as an edit and rejected with `append_only`.

- [ ] **Step 1: Write the failing test**

Append to `server/test/sync-validate.test.ts`:

```ts
describe('dose_settings carb_goal', () => {
  const withGoal = (carb_goal: unknown) =>
    doseSettings({
      windows: [{ name: 'Breakfast', start: '05:00', ratio_g_per_unit: 8, carb_goal }] as never,
    });

  it('accepts a window with a valid carb_goal and round-trips it', () => {
    const result = validateRecord(TABLE_SPECS.dose_settings, withGoal({ min: 30, max: 50 }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(decodeRow(TABLE_SPECS.dose_settings, result.row)).toMatchObject({
      windows: [{ name: 'Breakfast', start: '05:00', ratio_g_per_unit: 8, carb_goal: { min: 30, max: 50 } }],
    });
  });

  it('accepts a window with carb_goal null or absent', () => {
    expect(validateRecord(TABLE_SPECS.dose_settings, withGoal(null)).ok).toBe(true);
    expect(validateRecord(TABLE_SPECS.dose_settings, doseSettings()).ok).toBe(true);
  });

  it.each([
    [{ min: 80, max: 50 }],
    [{ min: -1, max: 50 }],
    [{ min: 0, max: 2001 }],
    [{ min: 30 }],
    ['30-50'],
  ])('rejects carb_goal %j', (goal) => {
    expect(validateRecord(TABLE_SPECS.dose_settings, withGoal(goal))).toEqual({
      ok: false,
      message: 'window "Breakfast" has an invalid carb_goal (need 0 <= min <= max <= 2000)',
    });
  });

  it('serializes carb_goal in a fixed key order so an identical republish is byte-identical', () => {
    const a = validateRecord(TABLE_SPECS.dose_settings, withGoal({ min: 30, max: 50 }));
    const b = validateRecord(TABLE_SPECS.dose_settings, withGoal({ max: 50, min: 30 }));
    expect(a.ok && b.ok && a.row.windows).toBe(b.ok ? b.row.windows : undefined);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @carbbook/server exec vitest run test/sync-validate.test.ts`
Expected: FAIL — the `rejects carb_goal` cases fail because `validateRecord` currently returns `{ ok: true, ... }`, and the key-order test fails because `carb_goal` is dropped by the canonicalizer.

- [ ] **Step 3: Validate the field**

In `server/src/sync/tables.ts`, change the import on line 1 to:

```ts
import {
  DOSE_LIMITS,
  isValidCarbGoal,
  isVolumeUnit,
  MAX_CARBS_PER_100ML,
  MAX_PORTION_CARBS_G,
  parseHHMM,
  VOLUME_UNITS,
} from '@carbbook/core';
```

Then inside `checkWindows`, after the `ratio_g_per_unit` check and before the closing `}` of the loop, add:

```ts
    // carb_goal is optional (meal-planning spec §2): absent or null means "no goal".
    if (window.carb_goal != null && !isValidCarbGoal(window.carb_goal)) {
      return `window "${window.name}" has an invalid carb_goal (need 0 <= min <= max <= ${DOSE_LIMITS.maxCarbsG})`;
    }
```

- [ ] **Step 4: Canonicalize the field**

In `server/src/sync/tables.ts`, replace `canonicalizeWindows` (line 95-96) with:

```ts
const canonicalizeCarbGoal = (value: unknown): unknown => (value == null ? value : reorderKeys(value, ['min', 'max']));

export const canonicalizeWindows = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map((w) => {
        const out = reorderKeys(w, ['name', 'start', 'ratio_g_per_unit', 'carb_goal']) as Record<string, unknown>;
        if ('carb_goal' in out) out.carb_goal = canonicalizeCarbGoal(out.carb_goal);
        return out;
      })
    : value;
```

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @carbbook/server exec vitest run test/sync-validate.test.ts test/sync-push-rules.test.ts`
Expected: PASS — including the existing append-only and key-reorder tests, which must stay green.

- [ ] **Step 6: Commit**

```bash
git add server/src/sync/tables.ts server/test/sync-validate.test.ts
git commit -m "feat(server): validate and canonicalize carb_goal on dose windows"
```

---

## Task 8: Seed the user's carb goals as a new dose-settings version

**Files:**
- Modify: `server/src/seed.ts`
- Modify: `server/test/seed.test.ts`
- Modify: `server/test/sync-pull.test.ts`, `server/test/sync-push.test.ts`, `server/test/sync-routes.test.ts`

`seedDoseSettings` already skips any id that is already present, so appending a second version is idempotent across restarts and leaves the 2026-08-12 version untouched. Adding a second seeded row shifts the `server_seq` baseline from 1 to 2, which several existing tests hardcode — Step 5 fixes each of them.

- [ ] **Step 1: Write the failing test**

Replace the first two tests in `server/test/seed.test.ts` (`inserts the current version, idempotently` and `stores the owner history exactly as specified`) with:

```ts
  it('inserts both versions, idempotently', () => {
    const db = openDb(':memory:');
    migrate(db);
    expect(seedDoseSettings(db)).toBe(2);
    expect(seedDoseSettings(db)).toBe(0);
    const seqs = db.prepare('SELECT server_seq FROM dose_settings ORDER BY effective_from').pluck().all();
    expect(seqs).toEqual([1, 2]);
  });

  it('adds only the missing version to a database that already has the older one', () => {
    const db = openDb(':memory:');
    migrate(db);
    db.prepare(
      `INSERT INTO dose_settings (id, effective_from, windows, correction, rounding, updated_at, updated_by, deleted, server_seq)
       VALUES (?, ?, ?, ?, ?, ?, 'pi', 0, 1)`,
    ).run(
      SEED_DOSE_SETTINGS[0]!.id,
      SEED_DOSE_SETTINGS[0]!.effective_from,
      JSON.stringify(SEED_DOSE_SETTINGS[0]!.windows),
      JSON.stringify(SEED_DOSE_SETTINGS[0]!.correction),
      JSON.stringify(SEED_DOSE_SETTINGS[0]!.rounding),
      SEED_DOSE_SETTINGS[0]!.effective_from,
    );
    expect(seedDoseSettings(db)).toBe(1);
    expect(db.prepare('SELECT updated_by FROM dose_settings WHERE id = ?').pluck().get(SEED_DOSE_SETTINGS[0]!.id)).toBe('pi');
  });

  it('stores the owner history exactly as specified', () => {
    const db = initDatabase(':memory:');
    const byDate = Object.fromEntries(
      loadSettings(db).map((s) => [new Date(s.effective_from).toISOString(), s.correction]),
    );
    expect(byDate).toEqual({
      '2026-08-12T05:00:00.000Z': { threshold: 200, step: 50, units_per_step: 1, mode: 'started' },
      '2026-09-16T05:00:00.000Z': { threshold: 200, step: 50, units_per_step: 1, mode: 'started' },
    });
  });

  it('gives the 2026-09-16 version the owner carb goals and leaves the older one without any', () => {
    const db = initDatabase(':memory:');
    const [older, newer] = loadSettings(db).sort((a, b) => a.effective_from - b.effective_from);
    expect(older!.windows.map((w) => w.carb_goal)).toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
    expect(newer!.windows.map((w) => [w.name, w.carb_goal])).toEqual([
      ['Breakfast', { min: 30, max: 50 }],
      ['AM Snack', { min: 10, max: 30 }],
      ['Lunch', { min: 50, max: 80 }],
      ['PM Snack', { min: 10, max: 30 }],
      ['Dinner', { min: 50, max: 80 }],
      ['HS Snack', { min: 10, max: 30 }],
    ]);
  });

  it('keeps the goal version driving dosing identically to the older one', () => {
    const db = initDatabase(':memory:');
    const settings = loadSettings(db);
    const older = activeSettings(settings, Date.parse('2026-09-01T12:00:00Z'))!;
    const newer = activeSettings(settings, Date.parse('2026-09-20T12:00:00Z'))!;
    expect(newer.id).not.toBe(older.id);
    const dose = (s: DoseSettingsData) =>
      estimateDose({ settings: s, minutes: 12 * 60, carbs: { carbs_g: 72, complete: true }, bg: 263 });
    expect(dose(newer)).toMatchObject({ ok: true, units: (dose(older) as { units: number }).units });
  });
```

Also update the imports at the top of `server/test/seed.test.ts` so `openDb` and `migrate` are both imported from `../src/db` (they already are) and `SEED_DOSE_SETTINGS` from `../src/seed` (it already is).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @carbbook/server exec vitest run test/seed.test.ts`
Expected: FAIL — `expected 1 to be 2` on the idempotency test.

- [ ] **Step 3: Add the seeded goals**

In `server/src/seed.ts`, after the `SEED_WINDOWS` declaration, add:

```ts
/**
 * Same windows and ratios as SEED_WINDOWS, plus the owner's per-window carb goals
 * (meal-planning spec §1). A separate array on purpose: SEED_WINDOWS is referenced by the older
 * version below and must not gain goals retroactively.
 */
export const SEED_GOAL_WINDOWS: DoseWindow[] = [
  { name: 'Breakfast', start: '05:00', ratio_g_per_unit: 8, carb_goal: { min: 30, max: 50 } },
  { name: 'AM Snack', start: '09:00', ratio_g_per_unit: 10, carb_goal: { min: 10, max: 30 } },
  { name: 'Lunch', start: '11:00', ratio_g_per_unit: 8, carb_goal: { min: 50, max: 80 } },
  { name: 'PM Snack', start: '14:00', ratio_g_per_unit: 10, carb_goal: { min: 10, max: 30 } },
  { name: 'Dinner', start: '16:30', ratio_g_per_unit: 8, carb_goal: { min: 50, max: 80 } },
  { name: 'HS Snack', start: '19:30', ratio_g_per_unit: 12, carb_goal: { min: 10, max: 30 } },
];
```

Then add a second entry to `SEED_DOSE_SETTINGS`, after the existing one (order matters: the array order decides which row gets which `server_seq`):

```ts
  {
    // Carb goals arrive as a new append-only version (meal-planning spec §2); dosing is unchanged.
    id: '019ff457-7480-7000-8000-000000000004',
    effective_from: at('2026-09-16'),
    windows: SEED_GOAL_WINDOWS,
    correction: { threshold: 200, step: 50, units_per_step: 1, mode: 'started' },
    rounding: SEED_ROUNDING,
  },
```

- [ ] **Step 4: Run the seed test**

Run: `pnpm --filter @carbbook/server exec vitest run test/seed.test.ts`
Expected: PASS.

- [ ] **Step 5: Fix the `server_seq` baseline in the existing sync tests**

Run: `pnpm --filter @carbbook/server test`
Expected: FAIL in `sync-push.test.ts`, `sync-pull.test.ts` and `sync-routes.test.ts` — those tests assume one seeded row. Apply exactly these edits.

`server/test/sync-push.test.ts`:
- Line 6: `const SEEDED_SEQ = 1; // one seed dose_settings row` → `const SEEDED_SEQ = 2; // two seed dose_settings rows`
- Line 17: `server_seq: 2` → `server_seq: 3`
- Line 25: `status: 'ignored', server_seq: 2` → `status: 'ignored', server_seq: 3`
- Line 31: `status: 'accepted', server_seq: 3` → `status: 'accepted', server_seq: 4`
- Line 55: `{ table: 'food', id: 'good', status: 'accepted', server_seq: 2 }` → `server_seq: 3`
- Line 135: `status: 'ignored', server_seq: 2` → `status: 'ignored', server_seq: 3`
- Line 138: `status: 'ignored', server_seq: 3` → `status: 'ignored', server_seq: 4`
- Line 139: `server_seq: 3` → `server_seq: 4`

`server/test/sync-pull.test.ts`:
- In `returns seeded dose settings from since=0 with JSON decoded`: `expect(page.next_since).toBe(1)` → `toBe(2)`, and `expect(page.changes.map((c) => c.table)).toEqual(['dose_settings'])` → `toEqual(['dose_settings', 'dose_settings'])`.
- In `pages across tables in server_seq order`: `pullChanges(db, 1, 2)` → `pullChanges(db, 2, 2)`; the expected triples become `[['meal', 'm1', 3], ['food', 'f1', 4]]`; `next_since: 3` → `next_since: 4`; `second` now yields `next_since: 5`; the final line becomes `expect(pullChanges(db, 5, 2)).toEqual({ changes: [], next_since: 5, has_more: false })`.
- In `includes soft-deleted records so clients learn about deletes`: `pullChanges(db, 1, 10)` → `pullChanges(db, 2, 10)`; `server_seq: 3` → `server_seq: 4`.

`server/test/sync-routes.test.ts`:
- Line 19: `{ results: [{ table: 'food', id: 'f1', status: 'accepted', server_seq: 2 }], server_seq: 2 }` → both `2`s become `3`.
- Line 21: `?since=1&limit=10` → `?since=2&limit=10`
- Line 23: `next_since: 2` → `next_since: 3`, and `record: { id: 'f1', server_seq: 2 }` → `server_seq: 3`.

- [ ] **Step 6: Run the whole server suite**

Run: `pnpm --filter @carbbook/server test`
Expected: PASS — every suite green.

- [ ] **Step 7: Commit**

```bash
git add server/src/seed.ts server/test/seed.test.ts server/test/sync-pull.test.ts server/test/sync-push.test.ts server/test/sync-routes.test.ts
git commit -m "feat(server): seed per-window carb goals as a new dose_settings version"
```

---

## Task 9: Migration `004_meal_plan.sql`

**Files:**
- Create: `server/migrations/004_meal_plan.sql`
- Create: `server/test/migration-004.test.ts`

Safety on the live Pi DB (`user_version` 3, real rows): this migration only creates two brand-new tables and touches nothing existing. `carb_goal` needs no schema change because it lives inside the existing `dose_settings.windows` JSON column. The guard at the top refuses to run — aborting the whole file inside `migrate()`'s transaction — if a `plan_entry`/`plan_item` table somehow already exists, so a partial restore produces a readable message instead of a bare `table already exists`.

- [ ] **Step 1: Write the failing test**

Create `server/test/migration-004.test.ts`:

```ts
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, migrate, openDb } from '../src/db';

/** A DB migrated to exactly version 3, as the live Pi database is today. */
function dbAtVersion3() {
  const dir = mkdtempSync(join(tmpdir(), 'carbbook-mig4-'));
  for (const file of ['001_init.sql', '002_usda_search.sql', '003_any_unit_foods.sql']) {
    copyFileSync(join(MIGRATIONS_DIR, file), join(dir, file));
  }
  const db = openDb(':memory:');
  migrate(db, dir);
  return { db, dir };
}

function insertPlanEntry(db: ReturnType<typeof openDb>, fields: Record<string, unknown>): void {
  db.prepare(
    `INSERT INTO plan_entry (id, date, window_name, status, note, log_entry_id, updated_at, updated_by, deleted, server_seq)
     VALUES (@id, @date, @window_name, @status, @note, @log_entry_id, @updated_at, @updated_by, @deleted, @server_seq)`,
  ).run({
    note: null,
    log_entry_id: null,
    updated_at: 1,
    updated_by: 'd',
    deleted: 0,
    server_seq: 1,
    ...fields,
  });
}

describe('migration 004 (meal plan)', () => {
  it('upgrades a version-3 database with real rows without touching them', () => {
    const { db } = dbAtVersion3();
    db.prepare(
      "INSERT INTO food (id, name, source, carbs_per_100g, updated_at, updated_by, deleted, server_seq) VALUES ('f1', 'Rice', 'custom', 28.2, 1, 'd', 0, 1)",
    ).run();
    db.prepare(
      `INSERT INTO dose_settings (id, effective_from, windows, correction, rounding, updated_at, updated_by, deleted, server_seq)
       VALUES ('ds1', 1, '[]', '{}', '{}', 1, 'd', 0, 2)`,
    ).run();

    expect(migrate(db)).toBe(4);
    expect(db.pragma('user_version', { simple: true })).toBe(4);
    expect(db.prepare('SELECT name, carbs_per_100g FROM food WHERE id = ?').get('f1')).toEqual({
      name: 'Rice',
      carbs_per_100g: 28.2,
    });
    expect(db.prepare('SELECT windows FROM dose_settings WHERE id = ?').pluck().get('ds1')).toBe('[]');
  });

  it('migrates a fresh database straight to version 4', () => {
    const db = openDb(':memory:');
    expect(migrate(db)).toBe(4);
  });

  it('creates both tables with the usual sync metadata columns and indexes', () => {
    const db = openDb(':memory:');
    migrate(db);
    for (const table of ['plan_entry', 'plan_item']) {
      const columns = db.prepare(`SELECT name FROM pragma_table_info('${table}')`).pluck().all();
      expect(columns, table).toEqual(expect.arrayContaining(['id', 'updated_at', 'updated_by', 'deleted', 'server_seq']));
    }
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('plan_entry', 'plan_item')")
      .pluck()
      .all();
    expect(indexes).toEqual(
      expect.arrayContaining([
        'plan_entry_server_seq',
        'plan_entry_date',
        'plan_entry_log_entry',
        'plan_entry_slot',
        'plan_item_server_seq',
        'plan_item_entry',
      ]),
    );
  });

  it('allows one live slot per date and window, and a replacement after a soft delete', () => {
    const db = openDb(':memory:');
    migrate(db);
    insertPlanEntry(db, { id: 'p1', date: '2026-09-17', window_name: 'Lunch', status: 'planned' });
    expect(() =>
      insertPlanEntry(db, { id: 'p2', date: '2026-09-17', window_name: 'Lunch', status: 'planned' }),
    ).toThrow(/UNIQUE constraint failed/);

    // A different window and a different date are fine.
    insertPlanEntry(db, { id: 'p3', date: '2026-09-17', window_name: 'Dinner', status: 'planned' });
    insertPlanEntry(db, { id: 'p4', date: '2026-09-18', window_name: 'Lunch', status: 'planned' });

    // Soft-deleting the first frees the slot.
    db.prepare("UPDATE plan_entry SET deleted = 1 WHERE id = 'p1'").run();
    expect(() =>
      insertPlanEntry(db, { id: 'p5', date: '2026-09-17', window_name: 'Lunch', status: 'planned' }),
    ).not.toThrow();
  });

  it.each([
    [{ id: 'bad1', date: '17-09-2026', window_name: 'Lunch', status: 'planned' }],
    [{ id: 'bad2', date: '2026-09-17', window_name: '', status: 'planned' }],
    [{ id: 'bad3', date: '2026-09-17', window_name: 'Lunch', status: 'eaten' }],
  ])('rejects plan_entry %j', (fields) => {
    const db = openDb(':memory:');
    migrate(db);
    expect(() => insertPlanEntry(db, fields)).toThrow(/CHECK constraint failed/);
  });

  it('rejects a negative plan_item amount and a bad ref_type', () => {
    const db = openDb(':memory:');
    migrate(db);
    const insert = (fields: Record<string, unknown>) =>
      db
        .prepare(
          `INSERT INTO plan_item (id, plan_entry_id, ref_type, ref_id, amount, unit, position, updated_at, updated_by, deleted, server_seq)
           VALUES (@id, @plan_entry_id, @ref_type, @ref_id, @amount, @unit, @position, 1, 'd', 0, 1)`,
        )
        .run({ plan_entry_id: 'p1', ref_type: 'food', ref_id: 'f1', amount: 1, unit: 'g', position: 0, ...fields });
    expect(() => insert({ id: 'i1' })).not.toThrow();
    expect(() => insert({ id: 'i2', amount: -1 })).toThrow(/CHECK constraint failed/);
    expect(() => insert({ id: 'i3', ref_type: 'snack' })).toThrow(/CHECK constraint failed/);
    expect(() => insert({ id: 'i4', amount: 0 })).not.toThrow();
  });

  it('aborts cleanly rather than half-applying when a statement in the file fails', () => {
    const { db, dir } = dbAtVersion3();
    const sql = readFileSync(join(MIGRATIONS_DIR, '004_meal_plan.sql'), 'utf8');
    writeFileSync(join(dir, '004_meal_plan.sql'), `${sql}\nSELECT this_function_does_not_exist();\n`);

    expect(() => migrate(db, dir)).toThrow();
    expect(db.pragma('user_version', { simple: true })).toBe(3);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'plan_entry'").get()).toBeUndefined();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'plan_item'").get()).toBeUndefined();
  });

  it('refuses to run when a plan_entry table already exists', () => {
    const { db, dir } = dbAtVersion3();
    db.prepare('CREATE TABLE plan_entry (id TEXT PRIMARY KEY)').run();
    expect(() => migrate(db, dir)).toThrow(/migration 004: plan_entry\/plan_item already exist/);
    expect(db.pragma('user_version', { simple: true })).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @carbbook/server exec vitest run test/migration-004.test.ts`
Expected: FAIL — `expected 3 to be 4` (there is no 004 file yet).

- [ ] **Step 3: Write the migration**

Create `server/migrations/004_meal_plan.sql`:

```sql
-- Meal planning (docs/superpowers/specs/2026-09-16-meal-planning-design.md §2): plan_entry and
-- plan_item. Nothing existing is altered -- the per-window carb goals live inside the existing
-- dose_settings.windows JSON column, so there is no column change and no data rewrite. Both
-- CREATEs run inside the migration runner's transaction (server/src/db.ts), so any failure in
-- this file rolls the whole file back and leaves user_version at 3.

-- Deploy guard: a hand-applied or partially restored schema could already hold these tables.
-- Abort with a readable message instead of an opaque "table plan_entry already exists".
CREATE TEMP TABLE migration_004_guard (existing INTEGER NOT NULL);
CREATE TEMP TRIGGER migration_004_guard_check BEFORE INSERT ON migration_004_guard
  WHEN NEW.existing > 0
  BEGIN
    SELECT RAISE(ABORT, 'migration 004: plan_entry/plan_item already exist; drop them (or restore a clean backup) before upgrading');
  END;
INSERT INTO migration_004_guard (existing)
  SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name IN ('plan_entry', 'plan_item');
DROP TRIGGER migration_004_guard_check;
DROP TABLE migration_004_guard;

-- log_entry_id is deliberately NOT a REFERENCES column: sync is offline-first and a plan entry may
-- arrive before the log entry it points at (same reasoning as log_item.ref_id, see sync/tables.ts).
-- The push layer checks the reference instead, where it can reject the record rather than the batch.
CREATE TABLE plan_entry (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  window_name TEXT NOT NULL CHECK (length(window_name) BETWEEN 1 AND 64),
  status TEXT NOT NULL CHECK (status IN ('planned', 'logged', 'skipped')),
  note TEXT,
  log_entry_id TEXT,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  server_seq INTEGER NOT NULL
);
CREATE INDEX plan_entry_server_seq ON plan_entry (server_seq);
CREATE INDEX plan_entry_date ON plan_entry (date);
CREATE INDEX plan_entry_log_entry ON plan_entry (log_entry_id);
-- At most one non-deleted entry per (date, window_name); soft-deleted rows free the slot again.
CREATE UNIQUE INDEX plan_entry_slot ON plan_entry (date, window_name) WHERE deleted = 0;

CREATE TABLE plan_item (
  id TEXT PRIMARY KEY,
  plan_entry_id TEXT NOT NULL,
  ref_type TEXT NOT NULL CHECK (ref_type IN ('food', 'meal')),
  ref_id TEXT NOT NULL,
  amount REAL NOT NULL CHECK (amount >= 0),
  unit TEXT NOT NULL,
  position INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  server_seq INTEGER NOT NULL
);
CREATE INDEX plan_item_server_seq ON plan_item (server_seq);
CREATE INDEX plan_item_entry ON plan_item (plan_entry_id);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @carbbook/server exec vitest run test/migration-004.test.ts`
Expected: PASS (all 9 tests).

Run: `pnpm --filter @carbbook/server test`
Expected: PASS — in particular `migration-003.test.ts` and `db.test.ts` are unaffected.

- [ ] **Step 5: Commit**

```bash
git add server/migrations/004_meal_plan.sql server/test/migration-004.test.ts
git commit -m "feat(server): add migration 004 for plan_entry and plan_item"
```

---

## Task 10: Sync table specs for `plan_entry` and `plan_item`

**Files:**
- Modify: `server/src/sync/tables.ts`
- Modify: `server/test/sync-helpers.ts`
- Modify: `server/test/sync-validate.test.ts`

- [ ] **Step 1: Add test fixtures**

Append to `server/test/sync-helpers.ts`:

```ts
export const planEntry = (fields: Partial<Record<string, unknown>> & Meta = {}) => ({
  id: uid('plan'),
  date: '2026-09-17',
  window_name: 'Lunch',
  status: 'planned',
  note: null,
  log_entry_id: null,
  ...fields,
  ...meta(fields),
});

export const planItem = (planEntryId: string, fields: Partial<Record<string, unknown>> & Meta = {}) => ({
  id: uid('planitem'),
  plan_entry_id: planEntryId,
  ref_type: 'food',
  ref_id: 'f1',
  amount: 1,
  unit: 'g',
  position: 0,
  ...fields,
  ...meta(fields),
});
```

- [ ] **Step 2: Write the failing test**

Append to `server/test/sync-validate.test.ts`:

```ts
describe('plan_entry validation', () => {
  it('accepts a complete plan entry', () => {
    const result = validateRecord(TABLE_SPECS.plan_entry, planEntry({ id: 'p1', note: 'leftovers' }));
    expect(result).toEqual({
      ok: true,
      row: {
        id: 'p1',
        updated_at: 1000,
        updated_by: 'phone',
        deleted: 0,
        date: '2026-09-17',
        window_name: 'Lunch',
        status: 'planned',
        note: 'leftovers',
        log_entry_id: null,
      },
    });
  });

  it.each([
    [{ date: '17-09-2026' }, 'date must be a real calendar date in YYYY-MM-DD form'],
    [{ date: '2026-02-30' }, 'date must be a real calendar date in YYYY-MM-DD form'],
    [{ date: '2026-13-01' }, 'date must be a real calendar date in YYYY-MM-DD form'],
    [{ date: '' }, 'date must not be empty'],
    [{ window_name: '' }, 'window_name must not be empty'],
    [{ window_name: 'x'.repeat(65) }, 'window_name is longer than 64 characters'],
    [{ status: 'eaten' }, 'status must be one of planned, logged, skipped'],
    [{ log_entry_id: 'x'.repeat(65) }, 'log_entry_id is longer than 64 characters'],
  ])('rejects plan_entry %j', (fields, message) => {
    expect(validateRecord(TABLE_SPECS.plan_entry, planEntry(fields))).toEqual({ ok: false, message });
  });

  it('accepts a leap day', () => {
    expect(validateRecord(TABLE_SPECS.plan_entry, planEntry({ date: '2028-02-29' })).ok).toBe(true);
  });
});

describe('plan_item validation', () => {
  it('accepts a complete plan item', () => {
    const result = validateRecord(TABLE_SPECS.plan_item, planItem('p1', { id: 'i1' }));
    expect(result).toEqual({
      ok: true,
      row: {
        id: 'i1',
        updated_at: 1000,
        updated_by: 'phone',
        deleted: 0,
        plan_entry_id: 'p1',
        ref_type: 'food',
        ref_id: 'f1',
        amount: 1,
        unit: 'g',
        position: 0,
      },
    });
  });

  it.each([
    [{ ref_type: 'snack' }, 'ref_type must be one of food, meal'],
    [{ amount: -1 }, 'amount must be >= 0'],
    [{ amount: 'lots' }, 'amount must be a finite number'],
    [{ unit: '' }, 'unit must not be empty'],
    [{ position: 1.5 }, 'position must be an integer'],
    [{ position: -1 }, 'position must be >= 0'],
  ])('rejects plan_item %j', (fields, message) => {
    expect(validateRecord(TABLE_SPECS.plan_item, planItem('p1', fields))).toEqual({ ok: false, message });
  });
});
```

Add `planEntry, planItem` to the `./sync-helpers` import at the top of `server/test/sync-validate.test.ts`.

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @carbbook/server exec vitest run test/sync-validate.test.ts`
Expected: FAIL — `Property 'plan_entry' does not exist on type 'Record<SyncTable, TableSpec>'`.

- [ ] **Step 4: Add the specs**

In `server/src/sync/tables.ts`, extend `SYNC_TABLES` (append, so existing pull ordering is unchanged):

```ts
export const SYNC_TABLES = [
  'food',
  'portion',
  'barcode',
  'meal',
  'meal_item',
  'log_entry',
  'log_item',
  'dose_settings',
  'plan_entry',
  'plan_item',
] as const;
```

Add this helper just above `export const TABLE_SPECS`:

```ts
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** True for a real calendar day written as YYYY-MM-DD (so "2026-02-30" is rejected). */
export function isValidPlanDate(value: unknown): boolean {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
```

Add these two entries to `TABLE_SPECS`, after `dose_settings`:

```ts
  plan_entry: {
    name: 'plan_entry',
    fields: {
      date: text(10),
      window_name: text(64),
      status: { type: 'enum', values: ['planned', 'logged', 'skipped'] },
      note: optionalText(4000),
      // Checked against the log_entry table in push.ts, where the DB is available.
      log_entry_id: optionalText(64),
    },
    check: (r) => (isValidPlanDate(r.date) ? null : 'date must be a real calendar date in YYYY-MM-DD form'),
  },
  plan_item: {
    name: 'plan_item',
    fields: {
      plan_entry_id: text(64),
      ref_type: { type: 'enum', values: REF_TYPES },
      ref_id: text(64),
      amount: { type: 'number', min: 0 },
      unit: text(64),
      position: { type: 'number', integer: true, min: 0 },
    },
  },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @carbbook/server exec vitest run test/sync-validate.test.ts`
Expected: PASS.

Run: `pnpm --filter @carbbook/server test`
Expected: PASS — `pullChanges` now queries the two new tables as well and finds them empty.

- [ ] **Step 6: Commit**

```bash
git add server/src/sync/tables.ts server/test/sync-helpers.ts server/test/sync-validate.test.ts
git commit -m "feat(server): add plan_entry and plan_item sync table specs"
```

---

## Task 11: Reject a duplicate slot on push

**Files:**
- Modify: `server/src/sync/push.ts`
- Create: `server/test/sync-plan.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/test/sync-plan.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { initDatabase } from '../src/init';
import { applyPush } from '../src/sync/push';
import { planEntry, planItem } from './sync-helpers';

describe('applyPush plan_entry slot uniqueness', () => {
  it('rejects a second live entry for the same date and window', () => {
    const db = initDatabase(':memory:');
    const first = applyPush(db, 'owner', [{ table: 'plan_entry', record: planEntry({ id: 'p1' }) }]);
    expect(first[0]!.status).toBe('accepted');

    const second = applyPush(db, 'owner', [{ table: 'plan_entry', record: planEntry({ id: 'p2' }) }]);
    expect(second).toEqual([
      {
        table: 'plan_entry',
        id: 'p2',
        status: 'rejected',
        reason: 'duplicate_slot',
        message: 'Another plan entry already exists for 2026-09-17 Lunch',
      },
    ]);
    expect(db.prepare('SELECT count(*) FROM plan_entry').pluck().get()).toBe(1);
  });

  it('rejects a duplicate that arrives later in the same batch', () => {
    const db = initDatabase(':memory:');
    const results = applyPush(db, 'owner', [
      { table: 'plan_entry', record: planEntry({ id: 'p1' }) },
      { table: 'plan_entry', record: planEntry({ id: 'p2' }) },
    ]);
    expect(results.map((r) => r.status)).toEqual(['accepted', 'rejected']);
  });

  it('allows a different window, a different date, and an update of the same row', () => {
    const db = initDatabase(':memory:');
    const results = applyPush(db, 'owner', [
      { table: 'plan_entry', record: planEntry({ id: 'p1' }) },
      { table: 'plan_entry', record: planEntry({ id: 'p2', window_name: 'Dinner' }) },
      { table: 'plan_entry', record: planEntry({ id: 'p3', date: '2026-09-18' }) },
      { table: 'plan_entry', record: planEntry({ id: 'p1', status: 'skipped', updated_at: 2000 }) },
    ]);
    expect(results.map((r) => r.status)).toEqual(['accepted', 'accepted', 'accepted', 'accepted']);
    expect(db.prepare('SELECT status FROM plan_entry WHERE id = ?').pluck().get('p1')).toBe('skipped');
  });

  it('frees the slot once the first entry is soft-deleted', () => {
    const db = initDatabase(':memory:');
    applyPush(db, 'owner', [{ table: 'plan_entry', record: planEntry({ id: 'p1' }) }]);
    applyPush(db, 'owner', [{ table: 'plan_entry', record: planEntry({ id: 'p1', deleted: 1, updated_at: 2000 }) }]);
    const replacement = applyPush(db, 'owner', [{ table: 'plan_entry', record: planEntry({ id: 'p2' }) }]);
    expect(replacement[0]!.status).toBe('accepted');
  });

  it('always accepts a delete, even of a row whose slot looks taken', () => {
    const db = initDatabase(':memory:');
    applyPush(db, 'owner', [{ table: 'plan_entry', record: planEntry({ id: 'p1' }) }]);
    const deletion = applyPush(db, 'owner', [
      { table: 'plan_entry', record: planEntry({ id: 'p1', deleted: 1, updated_at: 2000 }) },
    ]);
    expect(deletion[0]!.status).toBe('accepted');
  });

  it('lets a viewer write plans (spec §4: owner and viewers both edit plans)', () => {
    const db = initDatabase(':memory:');
    const results = applyPush(db, 'viewer', [
      { table: 'plan_entry', record: planEntry({ id: 'p1' }) },
      { table: 'plan_item', record: planItem('p1', { id: 'i1' }) },
    ]);
    expect(results.map((r) => r.status)).toEqual(['accepted', 'accepted']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @carbbook/server exec vitest run test/sync-plan.test.ts`
Expected: FAIL — the second push is accepted (or throws a raw `UNIQUE constraint failed: plan_entry.date, plan_entry.window_name`), not rejected with `duplicate_slot`.

- [ ] **Step 3: Add the rule**

In `server/src/sync/push.ts`, extend the reason union (line 12):

```ts
export type RejectReason = 'unknown_table' | 'invalid' | 'forbidden' | 'cycle' | 'append_only' | 'duplicate_slot';
```

Add this helper after `dosSettingsAppendOnlyViolation`:

```ts
/**
 * Spec §2: at most one non-deleted plan_entry per (date, window_name). Checked here rather than
 * relying on the partial unique index so the offending record gets a per-record rejection instead
 * of the whole push batch failing. Rows accepted earlier in the same batch are already written
 * inside this transaction, so they are visible to this query.
 */
function duplicateSlot(db: Db, row: SqlRow): boolean {
  if (row.deleted === 1) return false;
  const clash = db
    .prepare('SELECT 1 FROM plan_entry WHERE date = ? AND window_name = ? AND deleted = 0 AND id <> ?')
    .get(row.date, row.window_name, row.id);
  return clash !== undefined;
}
```

In `applyOne`, insert this block immediately after the `dose_settings` append-only block and before the `const stored = ...` line:

```ts
  if (spec.name === 'plan_entry' && duplicateSlot(db, row)) {
    return {
      table, id: rowId, status: 'rejected', reason: 'duplicate_slot',
      message: `Another plan entry already exists for ${String(row.date)} ${String(row.window_name)}`,
    };
  }
```

Placing it before the last-write-wins check is deliberate and mirrors the append-only rule: a stale duplicate must be told it is a duplicate, not silently reported as `ignored`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @carbbook/server exec vitest run test/sync-plan.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/sync/push.ts server/test/sync-plan.test.ts
git commit -m "feat(server): reject duplicate plan slots on push"
```

---

## Task 12: `log_entry_id` must reference an existing log entry

**Files:**
- Modify: `server/src/sync/push.ts`
- Modify: `server/test/sync-plan.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `server/test/sync-plan.test.ts`:

```ts
const logEntry = (id: string, fields: Record<string, unknown> = {}) => ({
  id,
  eaten_at: Date.parse('2026-09-17T17:00:00Z'),
  window_name: 'Lunch',
  bg_mgdl: null,
  bg_source: 'none',
  bg_trend: null,
  total_carbs_g: 60,
  suggested_units: null,
  taken_units: null,
  settings_version_id: null,
  notes: null,
  updated_at: 1000,
  updated_by: 'phone',
  deleted: 0,
  ...fields,
});

describe('applyPush plan_entry log_entry_id', () => {
  it('accepts a slot whose log_entry_id points at a known log entry', () => {
    const db = initDatabase(':memory:');
    const results = applyPush(db, 'owner', [
      { table: 'log_entry', record: logEntry('l1') },
      { table: 'plan_entry', record: planEntry({ id: 'p1', status: 'logged', log_entry_id: 'l1' }) },
    ]);
    expect(results.map((r) => r.status)).toEqual(['accepted', 'accepted']);
  });

  it('rejects a slot whose log_entry_id is unknown', () => {
    const db = initDatabase(':memory:');
    const results = applyPush(db, 'owner', [
      { table: 'plan_entry', record: planEntry({ id: 'p1', status: 'logged', log_entry_id: 'nope' }) },
    ]);
    expect(results).toEqual([
      {
        table: 'plan_entry',
        id: 'p1',
        status: 'rejected',
        reason: 'invalid',
        message: 'log_entry_id "nope" does not reference a known log entry',
      },
    ]);
    expect(db.prepare('SELECT count(*) FROM plan_entry').pluck().get()).toBe(0);
  });

  it('accepts a null log_entry_id', () => {
    const db = initDatabase(':memory:');
    expect(applyPush(db, 'owner', [{ table: 'plan_entry', record: planEntry({ id: 'p1' }) }])[0]!.status).toBe('accepted');
  });

  it('accepts a link to a log entry that is already soft-deleted, then reverts it on the next delete push', () => {
    const db = initDatabase(':memory:');
    applyPush(db, 'owner', [{ table: 'log_entry', record: logEntry('l1', { deleted: 1 }) }]);
    // The row exists, so the reference resolves; the revert rule (Task 13) handles the state.
    expect(
      applyPush(db, 'owner', [
        { table: 'plan_entry', record: planEntry({ id: 'p1', status: 'logged', log_entry_id: 'l1' }) },
      ])[0]!.status,
    ).toBe('accepted');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @carbbook/server exec vitest run test/sync-plan.test.ts`
Expected: FAIL — `rejects a slot whose log_entry_id is unknown` gets `status: 'accepted'`.

- [ ] **Step 3: Add the rule**

In `server/src/sync/push.ts`, add after `duplicateSlot`:

```ts
/**
 * Spec §6: when a plan entry claims a log entry, that row must already exist on the server. Unlike
 * ref_id on items (which may legitimately race ahead of its food), log_entry_id is only ever set by
 * the same client in the same breath as the log entry itself, so a dangling link means a bug or a
 * stale client, not an out-of-order sync.
 */
function unknownLogEntry(db: Db, row: SqlRow): boolean {
  if (row.log_entry_id == null) return false;
  return db.prepare('SELECT 1 FROM log_entry WHERE id = ?').get(row.log_entry_id) === undefined;
}
```

In `applyOne`, replace the `plan_entry` block added in Task 11 with:

```ts
  if (spec.name === 'plan_entry') {
    if (unknownLogEntry(db, row)) {
      return {
        table, id: rowId, status: 'rejected', reason: 'invalid',
        message: `log_entry_id "${String(row.log_entry_id)}" does not reference a known log entry`,
      };
    }
    if (duplicateSlot(db, row)) {
      return {
        table, id: rowId, status: 'rejected', reason: 'duplicate_slot',
        message: `Another plan entry already exists for ${String(row.date)} ${String(row.window_name)}`,
      };
    }
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @carbbook/server exec vitest run test/sync-plan.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/sync/push.ts server/test/sync-plan.test.ts
git commit -m "feat(server): require plan_entry.log_entry_id to reference a real log entry"
```

---

## Task 13: Deleting a log entry returns its slot to `planned`

**Files:**
- Modify: `server/src/sync/push.ts`
- Modify: `server/test/sync-plan.test.ts`

This is the spec §5 rule. It lives on the server (see the design decision in the File Structure section above): the deleting device may not hold the plan row, and the revert must reach every device exactly once through the normal pull.

- [ ] **Step 1: Write the failing test**

Append to `server/test/sync-plan.test.ts`:

```ts
describe('deleting a log entry returns its plan slot to planned', () => {
  function plannedAndLogged() {
    const db = initDatabase(':memory:');
    applyPush(db, 'owner', [
      { table: 'log_entry', record: logEntry('l1') },
      { table: 'plan_entry', record: planEntry({ id: 'p1', status: 'logged', log_entry_id: 'l1', updated_at: 1500 }) },
    ]);
    return db;
  }

  it('clears the link and the logged status when the log entry is soft-deleted', () => {
    const db = plannedAndLogged();
    const before = db.prepare('SELECT server_seq FROM plan_entry WHERE id = ?').pluck().get('p1') as number;

    applyPush(db, 'owner', [{ table: 'log_entry', record: logEntry('l1', { deleted: 1, updated_at: 3000, updated_by: 'laptop' }) }]);

    const after = db.prepare('SELECT * FROM plan_entry WHERE id = ?').get('p1') as Record<string, unknown>;
    expect(after).toMatchObject({ status: 'planned', log_entry_id: null, deleted: 0, updated_by: 'laptop' });
    expect(after.server_seq as number).toBeGreaterThan(before);
    expect(after.updated_at as number).toBeGreaterThan(1500);
  });

  it('makes the reverted slot visible to a pulling client', () => {
    const db = plannedAndLogged();
    const since = currentServerSeq(db);
    applyPush(db, 'owner', [{ table: 'log_entry', record: logEntry('l1', { deleted: 1, updated_at: 3000 }) }]);
    const page = pullChanges(db, since, 50);
    const planChange = page.changes.find((c) => c.table === 'plan_entry');
    expect(planChange?.record).toMatchObject({ id: 'p1', status: 'planned', log_entry_id: null });
  });

  it('reverts every slot pointing at the deleted entry and leaves other slots alone', () => {
    const db = initDatabase(':memory:');
    applyPush(db, 'owner', [
      { table: 'log_entry', record: logEntry('l1') },
      { table: 'log_entry', record: logEntry('l2') },
      { table: 'plan_entry', record: planEntry({ id: 'p1', status: 'logged', log_entry_id: 'l1' }) },
      { table: 'plan_entry', record: planEntry({ id: 'p2', window_name: 'Dinner', status: 'logged', log_entry_id: 'l2' }) },
      { table: 'plan_entry', record: planEntry({ id: 'p3', date: '2026-09-18', status: 'skipped' }) },
    ]);

    applyPush(db, 'owner', [{ table: 'log_entry', record: logEntry('l1', { deleted: 1, updated_at: 3000 }) }]);

    const rows = db.prepare('SELECT id, status, log_entry_id FROM plan_entry ORDER BY id').all();
    expect(rows).toEqual([
      { id: 'p1', status: 'planned', log_entry_id: null },
      { id: 'p2', status: 'logged', log_entry_id: 'l2' },
      { id: 'p3', status: 'skipped', log_entry_id: null },
    ]);
  });

  it('does nothing when the log entry is merely updated', () => {
    const db = plannedAndLogged();
    applyPush(db, 'owner', [{ table: 'log_entry', record: logEntry('l1', { total_carbs_g: 70, updated_at: 3000 }) }]);
    expect(db.prepare('SELECT status, log_entry_id FROM plan_entry WHERE id = ?').get('p1')).toEqual({
      status: 'logged',
      log_entry_id: 'l1',
    });
  });

  it('does nothing when a stale delete is ignored by last-write-wins', () => {
    const db = plannedAndLogged();
    applyPush(db, 'owner', [{ table: 'log_entry', record: logEntry('l1', { total_carbs_g: 70, updated_at: 5000 }) }]);
    const stale = applyPush(db, 'owner', [{ table: 'log_entry', record: logEntry('l1', { deleted: 1, updated_at: 4000 }) }]);
    expect(stale[0]!.status).toBe('ignored');
    expect(db.prepare('SELECT status FROM plan_entry WHERE id = ?').pluck().get('p1')).toBe('logged');
  });

  it('leaves a soft-deleted plan entry alone', () => {
    const db = plannedAndLogged();
    applyPush(db, 'owner', [
      { table: 'plan_entry', record: planEntry({ id: 'p1', status: 'logged', log_entry_id: 'l1', deleted: 1, updated_at: 2000 }) },
    ]);
    applyPush(db, 'owner', [{ table: 'log_entry', record: logEntry('l1', { deleted: 1, updated_at: 3000 }) }]);
    expect(db.prepare('SELECT status, deleted FROM plan_entry WHERE id = ?').get('p1')).toEqual({
      status: 'logged',
      deleted: 1,
    });
  });
});
```

Add these imports at the top of `server/test/sync-plan.test.ts`:

```ts
import { currentServerSeq } from '../src/db';
import { pullChanges } from '../src/sync/pull';
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @carbbook/server exec vitest run test/sync-plan.test.ts`
Expected: FAIL — the first test reports `status: 'logged'` instead of `'planned'`.

- [ ] **Step 3: Implement the revert**

In `server/src/sync/push.ts`, add after `unknownLogEntry`:

```ts
/**
 * Spec §5: deleting a log entry returns any slot that points at it to `planned` and clears the
 * link. Done server-side, not on the client: the deleting device may never have held the plan row,
 * and doing it here means the repair happens exactly once and reaches every device on the next
 * pull. Each reverted row gets a fresh server_seq, and an updated_at at least one millisecond past
 * its own previous value so a client's stale copy cannot win the next last-write-wins comparison.
 */
function revertPlanEntriesForDeletedLog(db: Db, row: SqlRow): void {
  const affected = db
    .prepare('SELECT id, updated_at FROM plan_entry WHERE log_entry_id = ? AND deleted = 0')
    .all(row.id) as { id: string; updated_at: number }[];
  if (affected.length === 0) return;
  const update = db.prepare(
    `UPDATE plan_entry
        SET status = 'planned', log_entry_id = NULL, updated_at = ?, updated_by = ?, server_seq = ?
      WHERE id = ?`,
  );
  for (const entry of affected) {
    const updatedAt = Math.max(row.updated_at as number, entry.updated_at + 1);
    update.run(updatedAt, row.updated_by, nextServerSeq(db), entry.id);
  }
}
```

In `applyOne`, after the `upsert(...)` call and the `meal_item` snapshot line, add:

```ts
  if (spec.name === 'log_entry' && row.deleted === 1) revertPlanEntriesForDeletedLog(db, row);
```

so the tail of `applyOne` reads:

```ts
  const serverSeq = nextServerSeq(db);
  upsert(db, spec, { ...row, server_seq: serverSeq });
  if (spec.name === 'meal_item') updateMealItemsSnapshot(mealItems, row);
  if (spec.name === 'log_entry' && row.deleted === 1) revertPlanEntriesForDeletedLog(db, row);
  return { table, id: rowId, status: 'accepted', server_seq: serverSeq };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @carbbook/server exec vitest run test/sync-plan.test.ts`
Expected: PASS.

Run: `pnpm --filter @carbbook/server test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/sync/push.ts server/test/sync-plan.test.ts
git commit -m "feat(server): revert plan slots when their log entry is deleted"
```

---

## Task 14: Plan push/pull round trip

**Files:**
- Modify: `server/test/sync-plan.test.ts`

Proves that a full plan — entry plus items — survives a push, comes back through `pullChanges` with the right shape, and that a later edit and delete propagate.

- [ ] **Step 1: Write the failing test**

Append to `server/test/sync-plan.test.ts`:

```ts
describe('plan push/pull round trip', () => {
  it('returns a pushed plan entry and its items in server_seq order', () => {
    const db = initDatabase(':memory:');
    const since = currentServerSeq(db);
    const results = applyPush(db, 'owner', [
      { table: 'plan_entry', record: planEntry({ id: 'p1', note: 'prep the night before' }) },
      { table: 'plan_item', record: planItem('p1', { id: 'i1', ref_id: 'rice', unit: 'g', amount: 150, position: 0 }) },
      { table: 'plan_item', record: planItem('p1', { id: 'i2', ref_type: 'meal', ref_id: 'm1', unit: 'serving', amount: 1, position: 1 }) },
    ]);
    expect(results.map((r) => r.status)).toEqual(['accepted', 'accepted', 'accepted']);

    const page = pullChanges(db, since, 50);
    expect(page.changes.map((c) => [c.table, c.record.id])).toEqual([
      ['plan_entry', 'p1'],
      ['plan_item', 'i1'],
      ['plan_item', 'i2'],
    ]);
    expect(page.changes[0]!.record).toMatchObject({
      date: '2026-09-17',
      window_name: 'Lunch',
      status: 'planned',
      note: 'prep the night before',
      log_entry_id: null,
      deleted: 0,
    });
    expect(page.changes[2]!.record).toMatchObject({
      plan_entry_id: 'p1',
      ref_type: 'meal',
      ref_id: 'm1',
      amount: 1,
      unit: 'serving',
      position: 1,
    });
    expect(page.has_more).toBe(false);
  });

  it('propagates a skip and a soft-deleted item', () => {
    const db = initDatabase(':memory:');
    applyPush(db, 'owner', [
      { table: 'plan_entry', record: planEntry({ id: 'p1' }) },
      { table: 'plan_item', record: planItem('p1', { id: 'i1' }) },
    ]);
    const since = currentServerSeq(db);
    applyPush(db, 'owner', [
      { table: 'plan_entry', record: planEntry({ id: 'p1', status: 'skipped', updated_at: 2000 }) },
      { table: 'plan_item', record: planItem('p1', { id: 'i1', deleted: 1, updated_at: 2000 }) },
    ]);
    const page = pullChanges(db, since, 50);
    expect(page.changes.map((c) => [c.table, c.record.id, c.record.status ?? c.record.deleted])).toEqual([
      ['plan_entry', 'p1', 'skipped'],
      ['plan_item', 'i1', 1],
    ]);
  });

  it('ignores a stale plan push under last-write-wins', () => {
    const db = initDatabase(':memory:');
    applyPush(db, 'owner', [{ table: 'plan_entry', record: planEntry({ id: 'p1', status: 'skipped', updated_at: 5000 }) }]);
    const stale = applyPush(db, 'owner', [
      { table: 'plan_entry', record: planEntry({ id: 'p1', status: 'planned', updated_at: 4000 }) },
    ]);
    expect(stale[0]!.status).toBe('ignored');
    expect(db.prepare('SELECT status FROM plan_entry WHERE id = ?').pluck().get('p1')).toBe('skipped');
  });
});
```

- [ ] **Step 2: Run the test**

Run: `pnpm --filter @carbbook/server exec vitest run test/sync-plan.test.ts`
Expected: PASS — everything this test needs was built in Tasks 9–13; this task is a regression net over the whole path. If it fails, the failure is real; fix the code, not the test.

- [ ] **Step 3: Commit**

```bash
git add server/test/sync-plan.test.ts
git commit -m "test(server): cover the plan push/pull round trip"
```

---

## Task 15: Full verification sweep

**Files:**
- Modify: `docs/superpowers/specs/2026-09-16-meal-planning-design.md` (status line only)

- [ ] **Step 1: Run every test suite**

Run: `pnpm --filter @carbbook/core test`
Expected: PASS — includes `goal.test.ts` and the `goal vectors` describe in `vectors.test.ts`.

Run: `pnpm --filter @carbbook/server test`
Expected: PASS — includes `migration-004.test.ts` and `sync-plan.test.ts`.

- [ ] **Step 2: Typecheck the workspace**

Run: `pnpm -r typecheck`
Expected: exits 0.

- [ ] **Step 3: Confirm the shared vectors are in sync for the Swift port**

Run: `ios/scripts/sync-testdata.sh --check`
Expected output: `testdata vectors in sync` (exit 0).

- [ ] **Step 4: Confirm the existing vectors were not edited**

Run: `git diff --stat main -- testdata/`
Expected: only `testdata/goal-vectors.json` appears; `units-vectors.json`, `dose-vectors.json` and `number-parse-vectors.json` must show no changes.

- [ ] **Step 5: Rehearse the live-database upgrade**

Run (against a copy, never the live file):

```bash
cp /path/to/live/carbbook.db /tmp/carbbook-upgrade-test.db
pnpm --filter @carbbook/server exec tsx -e "
import { initDatabase } from './src/init';
const db = initDatabase('/tmp/carbbook-upgrade-test.db');
console.log('user_version', db.pragma('user_version', { simple: true }));
console.log('dose_settings rows', db.prepare('SELECT count(*) FROM dose_settings').pluck().get());
console.log('plan_entry rows', db.prepare('SELECT count(*) FROM plan_entry').pluck().get());
"
```

Expected output:

```
user_version 4
dose_settings rows 2
plan_entry rows 0
```

Run the same command a second time and expect the identical output — seeding is idempotent, so the restart adds nothing.

If you do not have a copy of the live DB to hand, say so rather than skipping silently; `migration-004.test.ts` already covers the version-3-with-rows path.

- [ ] **Step 6: Mark the spec's delivery item 1 done**

In `docs/superpowers/specs/2026-09-16-meal-planning-design.md`, change the status line near the top:

```markdown
Status: approved in brainstorming, pending written-spec review
```

to:

```markdown
Status: approved; delivery step 1 (core goalStatus + vectors, server migration/validation, seeded goals) implemented
```

- [ ] **Step 7: Commit**

```bash
git add docs/superpowers/specs/2026-09-16-meal-planning-design.md
git commit -m "docs: mark meal-planning core+server delivery step done"
```

---

## Self-Review

**1. Spec coverage**

| Spec requirement | Task |
| --- | --- |
| §2 `plan_entry` fields, statuses, one live entry per slot | 5, 9, 10, 11 |
| §2 `plan_item` fields, same shape as `log_item` minus snapshots | 5, 9, 10 |
| §2 Plans computed live with `itemCarbs`/`sumCarbs`, never snapshotted | No code needed — no snapshot columns exist on `plan_item` (Task 9); consumed by the web/iOS plans |
| §2 migration 004 with indexes, CHECKs, partial unique index | 9 |
| §2 `carb_goal` on `dose_settings.windows[]`, bounds, `null` allowed | 4, 7 |
| §2 goals seeded as a new version, existing versions untouched, dose math ignores the field | 4, 8 |
| §3 `goalStatus` distance rule and five states | 2 |
| §3 short screen-reader label per state | 2 (`GOAL_STATUS_LABELS`) |
| §3 day totals sum the day's window goals; `none` when no window has one | 3 |
| §4/§5 Plan screen and Calculator integration | Out of scope — web and iOS plans |
| §5 deleting a linked log entry returns the slot to `planned` | 13 |
| §6 server validates date, `window_name` ≤ 64, status enum, one live slot, `log_entry_id` exists, item fields, `carb_goal` bounds | 7, 10, 11, 12 |
| §6 per-record reasons `invalid` / `duplicate_slot` / `forbidden` | 11, 12 (`forbidden` already exists and does not apply: plan tables are not `ownerOnly`, verified in Task 11's viewer test) |
| §6 no referential integrity for item refs | 9 (comment) + 10 (no check on `ref_id`) |
| §7 core boundary vectors in `testdata/goal-vectors.json`, run by Vitest, consumable by XCTest | 6 |
| §7 server: migration on the live DB shape, slot uniqueness, goal bounds, viewer writes, `log_entry_id` | 9, 11, 7, 11, 12 |
| §7 web/iOS/Playwright tests | Out of scope |
| §8 delivery item 1 | This whole plan; marked in 15 |

No gaps within the stated scope.

**2. Placeholder scan**

Every code step carries complete code. The only forward reference is Task 3 Step 3 depending on Task 4's one-line type change, which is called out explicitly in that step. No "TBD", no "add validation", no "similar to Task N".

**3. Type consistency**

- `CarbGoal` is declared once in `packages/core/src/types.ts` (Task 1) and imported by `goal.ts` (Tasks 1–3), `tables.ts` (via `isValidCarbGoal`, Task 7) and `seed.ts` (Task 8). No duplicate definition.
- `isValidCarbGoal`, `goalStatus`, `dayGoal`, `GOAL_STATUS_LABELS`, `GOAL_NEAR_G`, `GOAL_OFF_G`, `GoalStatus` — same names in the implementation (Tasks 1–3), in the vectors runner (Task 6) and in the server (Task 7).
- `goalStatus` takes a `CarbResult` (`{ carbs_g, complete }`) everywhere, matching `itemCarbs`/`sumCarbs`.
- `PlanEntryData` / `PlanItemData` field names (Task 5) match the SQL columns (Task 9), the table specs (Task 10) and the test fixtures (Task 10).
- `duplicateSlot`, `unknownLogEntry`, `revertPlanEntriesForDeletedLog` are each defined once in `push.ts` and each called once from `applyOne` (Tasks 11–13); the Task 12 block replaces — not duplicates — the Task 11 block.
- Rejection messages are quoted identically in the implementation and in the assertions: `Another plan entry already exists for ${date} ${window_name}`, `log_entry_id "${id}" does not reference a known log entry`, `window "${name}" has an invalid carb_goal (need 0 <= min <= max <= 2000)`, `date must be a real calendar date in YYYY-MM-DD form`.
- The `server_seq` baseline is 2 everywhere after Task 8, and Task 8 Step 5 lists each stale assertion by file and line.
