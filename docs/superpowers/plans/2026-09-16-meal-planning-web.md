# Meal Planning — Web Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add meal planning to the CarbBook web app — a Plan screen (week grid, phone-first), copy day/week, a Calculator suggestion line with Load / Skip / Dismiss, plan→log linking, and goal colours on plan cells, day totals, the Calculator total and Log entries — all offline-first and synced like every other record.

**Architecture:** Two new synced Dexie tables (`plan_entry`, `plan_item`) join `SYNC_TABLES`, so push/pull/outbox/ownership already handle them with no change to the sync engine. All carb and goal math comes from `@carbbook/core` (`itemCarbs`, `sumCarbs`, `goalStatus`, `dayGoal`); the web side only groups, formats and renders. Planning logic lives in small pure modules under `web/src/plan/` (`slots.ts`, `copy.ts`, `suggestion.ts`, `goal.ts`, `dismissed.ts`) that are unit-tested without React or IndexedDB; the three components (`Plan.tsx`, `SlotEditor.tsx`, `CopyDialog.tsx`) are thin. Plan slots reuse the existing item picker (`SearchPanel` + `ItemEditor` + `DraftItem` + strict `parseAmount`), so fractions work exactly as they do in the Calculator and Meal editor.

**Tech Stack:** React 19.3.0, Vite 8.3.0, Dexie 4.4.6 + dexie-react-hooks 4.4.0, `@carbbook/core` (workspace), Vitest ^5 + jsdom 30.0.1 + Testing Library, @playwright/test 1.63.0. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-16-meal-planning-design.md` — §2 (data model), §3 (colour feedback), §4 (Plan screen), §5 (Calculator integration), §7 (testing), §8 delivery step 2.

**Branch:** `feat/plan-web`.

---

## Prerequisite: the core + server contract

This plan depends on the concurrently written plan
`docs/superpowers/plans/2026-09-16-meal-planning-core-server.md`. **At the time this plan was
written that file did not exist**, so the following contract is an explicit assumption. Task 1
Step 1 verifies it against the built core before any other work starts. If any name differs,
change the name in this plan (and only the name) and carry on — no behaviour here depends on
anything beyond these seven exports.

`@carbbook/core` must export:

```ts
export type PlanStatus = 'planned' | 'logged' | 'skipped';

export interface PlanEntryData {
  id: Id;
  date: string;            // "YYYY-MM-DD", local
  window_name: string;
  status: PlanStatus;
  note?: string | null;
  log_entry_id?: Id | null;
}

export interface PlanItemData {
  id: Id;
  plan_entry_id: Id;
  ref_type: RefType;       // 'food' | 'meal'
  ref_id: Id;
  amount: number;
  unit: string;
  position: number;
}

export interface CarbGoal { min: number; max: number }

export type GoalStatus = 'none' | 'in' | 'near' | 'off' | 'out';

/** `none` when there is no goal or `carbs.complete` is false; otherwise the spec §3 banding. */
export function goalStatus(carbs: CarbResult, goal: CarbGoal | null): GoalStatus;

/** Summed goal for a set of windows; null when none of them has a goal. */
export function dayGoal(goals: (CarbGoal | null)[]): CarbGoal | null;

// `DoseWindow` gains:  carb_goal?: CarbGoal | null
```

and `testdata/goal-vectors.json` must exist with this shape (read by Task 2's test):

```json
{ "cases": [{ "carbs_g": 68, "complete": true, "goal": { "min": 50, "max": 80 }, "status": "in" }] }
```

The server side (migration `004_meal_plan.sql`, validation, seeded `carb_goal`s) is entirely that
other plan's job. Nothing here writes a `carb_goal` except the Settings editor in Task 21, which
only carries existing goals forward and lets the owner edit them.

---

## Decisions made while writing this plan

1. **One DOM, two layouts.** The Plan screen always renders a day list with that day's windows
   stacked inside it (phone-first, correct at 375 px). At `min-width: 900px` a CSS grid turns the
   same markup into the week grid (days as rows, windows as columns). No responsive JavaScript, no
   second component.
2. **Weeks start Monday** and are navigated with ‹ / › plus a date input, mirroring the Log
   screen's `day-nav`. Past weeks are fully readable and editable (the spec only requires
   readable; blocking edits would need a rule the spec does not give).
3. **Colour is never alone.** Every goal readout renders the numbers ("68 g · goal 50–80"), a
   visible status word ("on target"), a `goal-<status>` class for the colour, and an `aria-label`
   spelling all of it out. One helper, `goalView`, produces all four, so the Plan cell, day total,
   Calculator total and Log entry can never drift apart.
4. **The window list for a date comes from the dose-settings version active at local noon of that
   date**, via `activeSettings` over `useEligibleDoseVersions()` — the single sanctioned
   eligible-versions path. Plan cells never read `db.dose_settings` directly.
5. **A slot with no live entry is "empty"** and shows a "+" button; creating one writes a
   `plan_entry` with `status: 'planned'` plus its items in one `saveMany` transaction, so an
   offline slot is queued as one unit like a meal.
6. **Copy conflicts are asked once per action, not once per day.** "Copy week → next week" asks a
   single replace / merge / skip question that applies to every conflicting day in that week; the
   dialog lists the conflicting dates so the choice is informed.
7. **Copied slots are always `planned`** with `log_entry_id: null`, whatever the source status
   was — copying yesterday's logged dinner plans it again, it does not claim it was eaten.
8. **Dismissals are per device and never synced**: a `localStorage` set of `"<date>|<window>"`
   keys, read once into React state on mount. Every access is wrapped in try/catch so a browser
   with storage blocked still renders (it simply forgets dismissals).
9. **A loaded slot is remembered in Calculator component state only.** Reloading the page loses
   the link, which is correct: the suggestion line comes straight back, because the slot is still
   `planned`.
10. **No dose numbers anywhere in the plan UI.** Plans show carbs and goals; doses stay in
    `DoseCard`, which already refuses to print a number when core refuses. Nothing in this plan
    touches that path.

---

## File structure

```
web/src/db/db.ts                  MODIFY  plan_entry + plan_item in SYNC_TABLES/SyncRecords, Dexie v3
web/src/ui/format.ts              MODIFY  startOfWeek / weekDates / formatDayLabel
web/src/plan/goal.ts              NEW     goalView: class + text + status word + aria-label (the ONLY goal formatter)
web/src/plan/slots.ts             NEW     slotKey, windowsFor, buildSlots, dayTotal (pure)
web/src/plan/saveSlot.ts          NEW     saveSlot / removeSlot over Store (mirrors meals/saveMeal.ts)
web/src/plan/copy.ts              NEW     conflictDates, copyChanges, applyCopy (pure + one applier)
web/src/plan/suggestion.ts        NEW     suggestionFor (pure)
web/src/plan/dismissed.ts         NEW     per-device dismissed-slot set in localStorage
web/src/plan/SlotEditor.tsx       NEW     edit one slot's items with SearchPanel + ItemEditor
web/src/plan/CopyDialog.tsx       NEW     replace / merge / skip choice
web/src/screens/Plan.tsx          NEW     week navigation, day list, cells, copy actions
web/src/app/hooks.ts              MODIFY  usePlanData
web/src/app/Shell.tsx             MODIFY  /plan route + nav entry
web/src/screens/Calculator.tsx    MODIFY  suggestion line, Load/Skip/Dismiss, mark logged, goal on total
web/src/screens/Log.tsx           MODIFY  goal colour per entry
web/src/log/LogEntryEditor.tsx    MODIFY  deleting an entry returns its slot to planned
web/src/settings/DoseSettingsEditor.tsx  MODIFY  carry + edit carb_goal
web/src/styles.css                MODIFY  goal colours, plan grid

web/test/plan-db.test.ts          NEW     schema + sync wiring for the two tables
web/test/goal.test.ts             NEW     goalView + shared goal vectors
web/test/plan-slots.test.ts       NEW     buildSlots, dayTotal
web/test/plan-copy.test.ts        NEW     conflictDates, copyChanges
web/test/plan-suggestion.test.ts  NEW     suggestionFor
web/test/plan.test.tsx            NEW     Plan screen
web/test/plan-calculator.test.tsx NEW     suggestion line end to end in the Calculator
web/test/log.test.tsx             MODIFY  goal colour + slot unlink on delete
web/test/settings.test.tsx        MODIFY  carb_goal carry-through
web/e2e/carbbook.spec.ts          MODIFY  plan → load → log offline → sync
```

---

## Conventions every task follows

- Run one test file with `pnpm --filter @carbbook/web test <file>`; the whole suite with
  `pnpm --filter @carbbook/web test`.
- Tests open a throwaway IndexedDB with `openTestDb()` and delete it in `afterEach`; render with
  `renderWith(<X />, services)` from `web/test/render.tsx`. `NOW` is local noon on
  **2026-09-14 (a Monday)**, which is inside the "Lunch" window of `SEED_SETTINGS`.
- `useLiveQuery` is `undefined` on first render, so assert with `findBy*`, never `getBy*`, on the
  first read of live data.
- Commit after every task with the message given in the task's last step.

---

### Task 1: Plan tables in Dexie and the sync path

**Files:**
- Modify: `web/src/db/db.ts`
- Test: `web/test/plan-db.test.ts` (create)

- [ ] **Step 1: Verify the core contract before anything else**

Run: `cd ~/Projects/CarbBook && pnpm -r build && node -e "const c=require('./packages/core/dist/index.cjs')||{};" 2>/dev/null; grep -n "goalStatus\|dayGoal\|CarbGoal\|PlanEntryData\|PlanItemData\|carb_goal" packages/core/src/*.ts`

Expected: matches for `PlanEntryData`, `PlanItemData`, `CarbGoal`, `GoalStatus`, `goalStatus`,
`dayGoal` and `carb_goal` on `DoseWindow`. Also run `ls testdata/goal-vectors.json` and expect the
path to print. If any are missing, the core/server plan is not merged yet — **stop and report
that**, do not stub the core.

- [ ] **Step 2: Write the failing test**

Create `web/test/plan-db.test.ts`:

```ts
import type { PlanEntryData, PlanItemData } from '@carbbook/core';
import { afterEach, describe, expect, it } from 'vitest';
import { SYNC_TABLES } from '../src/db/db';
import { createStore } from '../src/db/store';
import { pushOutbox } from '../src/sync/push';
import { FakeApi, openTestDb } from './helpers';

let db = openTestDb();
afterEach(async () => {
  await db.delete();
});

const entry: PlanEntryData = {
  id: 'plan-1',
  date: '2026-09-16',
  window_name: 'Lunch',
  status: 'planned',
  note: null,
  log_entry_id: null,
};

const item: PlanItemData = {
  id: 'plan-item-1',
  plan_entry_id: 'plan-1',
  ref_type: 'food',
  ref_id: 'tortilla',
  amount: 1.5,
  unit: 'g',
  position: 0,
};

describe('plan tables', () => {
  it('lists both plan tables as synced tables', () => {
    expect(SYNC_TABLES).toContain('plan_entry');
    expect(SYNC_TABLES).toContain('plan_item');
  });

  it('stores, indexes and pushes plan records like any other synced record', async () => {
    db = openTestDb();
    const store = createStore(db, 'device-test', { now: () => 1000 });
    await store.saveMany([
      { table: 'plan_entry', data: entry },
      { table: 'plan_item', data: item },
    ]);

    expect(await db.plan_entry.where('date').equals('2026-09-16').count()).toBe(1);
    expect(await db.plan_item.where('plan_entry_id').equals('plan-1').count()).toBe(1);
    expect(await db.outbox.count()).toBe(2);

    const api = new FakeApi().on('POST', '/api/sync/push', (body) => ({
      results: (body as { changes: unknown[] }).changes.map((_, i) => ({ status: 'accepted', server_seq: i + 1 })),
    }));
    const summary = await pushOutbox(db, api, () => 2000);
    expect(summary.accepted).toBe(2);
    expect(await db.outbox.count()).toBe(0);
    const pushed = api.calls.at(-1)!.body as { changes: { table: string }[] };
    expect(pushed.changes.map((c) => c.table).sort()).toEqual(['plan_entry', 'plan_item']);
  });

  it('indexes log_entry_id so a deleted log entry can find its slot', async () => {
    db = openTestDb();
    const store = createStore(db, 'device-test', { now: () => 1000 });
    await store.save('plan_entry', { ...entry, status: 'logged', log_entry_id: 'log-9' });
    expect(await db.plan_entry.where('log_entry_id').equals('log-9').count()).toBe(1);
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `pnpm --filter @carbbook/web test plan-db`
Expected: FAIL — `SYNC_TABLES` has no `plan_entry`, and `db.plan_entry` is undefined.

- [ ] **Step 4: Add the tables to `web/src/db/db.ts`**

Add the two type imports to the existing `@carbbook/core` import block:

```ts
import type {
  BarcodeData,
  DoseSettingsData,
  FoodData,
  LogEntryData,
  LogItemData,
  MealData,
  MealItemData,
  PlanEntryData,
  PlanItemData,
  PortionData,
  PortionKind,
  Synced,
} from '@carbbook/core';
```

Append both tables to `SYNC_TABLES` (appended last: the server accepts any order within a push,
and appending keeps every existing index in this array stable):

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

Add both to `SyncRecords`:

```ts
  dose_settings: Synced<DoseSettingsData>;
  plan_entry: Synced<PlanEntryData>;
  plan_item: Synced<PlanItemData>;
}
```

Add both table declarations after `dose_settings`:

```ts
  declare dose_settings: Table<SyncRecords['dose_settings'], string>;
  declare plan_entry: Table<SyncRecords['plan_entry'], string>;
  declare plan_item: Table<SyncRecords['plan_item'], string>;
```

Add a version 3 at the end of the constructor, after the `this.version(2)` block. Dexie needs the
full store map for the new version; only the two lines at the end are new, everything else repeats
v2 unchanged. No `.upgrade()` is needed: adding object stores creates them empty.

```ts
    // v3 adds the two meal-planning tables (spec 2026-09-16 §2). Pure additions: no existing
    // store definition changes and no data migration is needed.
    this.version(3).stores({
      food: 'id, source_ref',
      portion: 'id, food_id',
      barcode: 'id, code, food_id',
      meal: 'id',
      meal_item: 'id, meal_id, ref_id',
      log_entry: 'id, eaten_at',
      log_item: 'id, log_entry_id, ref_id',
      dose_settings: 'id, effective_from',
      plan_entry: 'id, date, window_name, log_entry_id',
      plan_item: 'id, plan_entry_id, ref_id',
      outbox: 'key',
      meta: 'key',
      sync_error: 'key, at',
      usda_food: 'fdc_id',
      usda_portion: 'id, fdc_id',
      pending_barcode: 'code',
    });
```

- [ ] **Step 5: Run the test**

Run: `pnpm --filter @carbbook/web test plan-db`
Expected: PASS (3 tests).

- [ ] **Step 6: Run the full suite — nothing else may break**

Run: `pnpm --filter @carbbook/web test && pnpm -r typecheck`
Expected: all existing test files pass, `tsc` clean.

- [ ] **Step 7: Commit**

```bash
git add web/src/db/db.ts web/test/plan-db.test.ts
git commit -m "feat(web): add plan_entry and plan_item to the synced Dexie schema"
```

---

### Task 2: `goalView` — the single goal formatter

**Files:**
- Create: `web/src/plan/goal.ts`
- Modify: `web/src/styles.css`
- Test: `web/test/goal.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `web/test/goal.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import vectors from '../../testdata/goal-vectors.json';
import { goalView, GOAL_WORDS } from '../src/plan/goal';

describe('goalView', () => {
  it('renders carbs, the goal range, a status word and a full aria-label', () => {
    const view = goalView({ carbs_g: 68, complete: true }, { min: 50, max: 80 });
    expect(view.status).toBe('in');
    expect(view.text).toBe('68 g · goal 50–80');
    expect(view.word).toBe('on target');
    expect(view.className).toBe('goal goal-in');
    expect(view.ariaLabel).toBe('68 g, goal 50 to 80, on target');
  });

  it('shows the carbs alone when the window has no goal', () => {
    const view = goalView({ carbs_g: 68, complete: true }, null);
    expect(view.status).toBe('none');
    expect(view.text).toBe('68 g');
    expect(view.word).toBe('');
    expect(view.ariaLabel).toBe('68 g');
  });

  it('says "missing data" instead of a number when carbs are incomplete', () => {
    const view = goalView({ carbs_g: 0, complete: false }, { min: 50, max: 80 });
    expect(view.status).toBe('none');
    expect(view.text).toBe('missing data · goal 50–80');
    expect(view.ariaLabel).toBe('missing data, goal 50 to 80');
  });

  it('agrees with the shared core vectors on every banding case', () => {
    expect(vectors.cases.length).toBeGreaterThan(0);
    for (const c of vectors.cases) {
      const view = goalView({ carbs_g: c.carbs_g, complete: c.complete }, c.goal);
      expect(view.status, `${c.carbs_g} g vs ${JSON.stringify(c.goal)}`).toBe(c.status);
      expect(GOAL_WORDS[view.status]).toBeDefined();
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @carbbook/web test goal.test`
Expected: FAIL — `Cannot find module '../src/plan/goal'`.

- [ ] **Step 3: Write `web/src/plan/goal.ts`**

```ts
import { type CarbGoal, type CarbResult, type GoalStatus, goalStatus } from '@carbbook/core';
import { formatCarbs } from '../ui/format';

/**
 * The words shown beside every goal number. Spec §3: colour is never the only signal, so each
 * state has a short label that is rendered visibly AND folded into the aria-label.
 */
export const GOAL_WORDS: Record<GoalStatus, string> = {
  none: '',
  in: 'on target',
  near: 'just outside',
  off: 'outside',
  out: 'far outside',
};

const trimGoal = (n: number): string => String(Number(n.toFixed(1)));

export interface GoalView {
  status: GoalStatus;
  /** CSS classes carrying the colour. Never the only signal — always rendered with `text`. */
  className: string;
  /** "68 g · goal 50–80" (en dash), or "68 g" with no goal, or "missing data …" when incomplete. */
  text: string;
  /** "on target" etc., or '' when there is no goal. Render this visibly next to `text`. */
  word: string;
  /** Screen-reader form: numbers spelled out with "to" and the status word. */
  ariaLabel: string;
}

/**
 * The ONE place carbs-against-a-goal are turned into something renderable. Plan cells, plan day
 * totals, the Calculator total and Log entries all go through this, so the four can never drift.
 * Banding itself is core's `goalStatus` — this function never re-implements the spec §3 formula.
 */
export function goalView(carbs: CarbResult, goal: CarbGoal | null): GoalView {
  const status = goalStatus(carbs, goal);
  const value = carbs.complete ? formatCarbs(carbs.carbs_g) : 'missing data';
  const range = goal ? `${trimGoal(goal.min)}–${trimGoal(goal.max)}` : null;
  const word = GOAL_WORDS[status];
  return {
    status,
    className: `goal goal-${status}`,
    text: range ? `${value} · goal ${range}` : value,
    word,
    ariaLabel: [value, range ? `goal ${trimGoal(goal!.min)} to ${trimGoal(goal!.max)}` : null, word || null]
      .filter(Boolean)
      .join(', '),
  };
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @carbbook/web test goal.test`
Expected: PASS (4 tests).

- [ ] **Step 5: Add the colours to `web/src/styles.css`**

Append at the end of the file, before the existing `@media (min-width: 600px)` block:

```css
.goal {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 4px 8px;
  align-items: baseline;
  padding: 2px 8px;
  border-left: 4px solid currentcolor;
  border-radius: 4px;
}

.goal-word {
  font-size: 0.85em;
  opacity: 0.85;
}

.goal-none {
  color: var(--text);
  border-left-color: var(--border);
}
.goal-in {
  color: #0f6b3a;
  background: #e6f4ec;
}
.goal-near {
  color: #6b5200;
  background: #fbf3d5;
}
.goal-off {
  color: #8a3f00;
  background: #fbe9dc;
}
.goal-out {
  color: #8a1418;
  background: #fbe3e4;
}
```

- [ ] **Step 6: Commit**

```bash
git add web/src/plan/goal.ts web/test/goal.test.ts web/src/styles.css
git commit -m "feat(web): goalView formats carbs against a carb goal with text, word and colour"
```

---

### Task 3: Week date helpers

**Files:**
- Modify: `web/src/ui/format.ts`
- Test: `web/test/format.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `web/test/format.test.ts` (inside the existing top-level `describe`, or as a new
`describe` block at the end of the file):

```ts
describe('week helpers', () => {
  it('starts weeks on Monday', () => {
    expect(startOfWeek('2026-09-16')).toBe('2026-09-14'); // Wednesday → Monday
    expect(startOfWeek('2026-09-14')).toBe('2026-09-14'); // Monday → itself
    expect(startOfWeek('2026-09-20')).toBe('2026-09-14'); // Sunday → that Monday
  });

  it('lists the seven dates of a week in order', () => {
    expect(weekDates('2026-09-14')).toEqual([
      '2026-09-14',
      '2026-09-15',
      '2026-09-16',
      '2026-09-17',
      '2026-09-18',
      '2026-09-19',
      '2026-09-20',
    ]);
  });

  it('labels a day with its weekday and date', () => {
    expect(formatDayLabel('2026-09-16')).toBe('Wed 16 Sep');
  });
});
```

Add `startOfWeek`, `weekDates` and `formatDayLabel` to the file's import from `../src/ui/format`.

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @carbbook/web test format.test`
Expected: FAIL — `startOfWeek is not a function`.

- [ ] **Step 3: Add the helpers to `web/src/ui/format.ts`**

Append after the existing `shiftDay`:

```ts
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The Monday of the local week containing `key` (spec §4: weeks are Monday-first). */
export function startOfWeek(key: string): string {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  const date = new Date(y, m - 1, d);
  // getDay(): 0 = Sunday. Monday-first means Sunday is 6 days into the week, not 0.
  const offset = (date.getDay() + 6) % 7;
  return shiftDay(key, -offset);
}

/** The seven local day keys of the week starting at `monday`, in order. */
export function weekDates(monday: string): string[] {
  return Array.from({ length: 7 }, (_, i) => shiftDay(monday, i));
}

/** "Wed 16 Sep" — short enough for a 375 px row header. */
export function formatDayLabel(key: string): string {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  const date = new Date(y, m - 1, d);
  return `${WEEKDAYS[date.getDay()]} ${d} ${MONTHS[m - 1]}`;
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @carbbook/web test format.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/ui/format.ts web/test/format.test.ts
git commit -m "feat(web): Monday-first week date helpers"
```

---

### Task 4: `buildSlots` — plan rows grouped into slots with live carbs

**Files:**
- Create: `web/src/plan/slots.ts`
- Test: `web/test/plan-slots.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `web/test/plan-slots.test.ts`:

```ts
import type { DoseWindow, PlanEntryData, PlanItemData, Synced } from '@carbbook/core';
import { describe, expect, it } from 'vitest';
import { buildCatalog } from '../src/db/catalog';
import { buildSlots, slotKey, windowsFor } from '../src/plan/slots';
import { foodData, synced } from './helpers';
import { SEED_SETTINGS } from './render';

const WINDOWS: DoseWindow[] = [
  { name: 'Breakfast', start: '05:00', ratio_g_per_unit: 8, carb_goal: { min: 30, max: 50 } },
  { name: 'Lunch', start: '11:00', ratio_g_per_unit: 8, carb_goal: { min: 50, max: 80 } },
  { name: 'HS Snack', start: '19:30', ratio_g_per_unit: 12, carb_goal: null },
];

const catalog = buildCatalog({
  foods: [synced(foodData({ id: 'tortilla', name: 'Tortilla', carbs_per_100g: 48 }))],
  portions: [],
  meals: [],
  meal_items: [],
});

const entry = (fields: Partial<PlanEntryData>): Synced<PlanEntryData> =>
  synced({ id: 'p1', date: '2026-09-16', window_name: 'Lunch', status: 'planned', note: null, log_entry_id: null, ...fields });

const item = (fields: Partial<PlanItemData>): Synced<PlanItemData> =>
  synced({ id: 'i1', plan_entry_id: 'p1', ref_type: 'food', ref_id: 'tortilla', amount: 100, unit: 'g', position: 0, ...fields });

describe('buildSlots', () => {
  it('produces one slot per date × window, in window order, empty where nothing is planned', () => {
    const slots = buildSlots({ dates: ['2026-09-16'], windows: WINDOWS, entries: [], items: [], catalog });
    expect(slots.map((s) => s.windowName)).toEqual(['Breakfast', 'Lunch', 'HS Snack']);
    expect(slots.every((s) => s.entry === null && s.items.length === 0)).toBe(true);
    expect(slots[0]!.key).toBe(slotKey('2026-09-16', 'Breakfast'));
  });

  it('fills a slot with its live items in position order and core carbs', () => {
    const slots = buildSlots({
      dates: ['2026-09-16'],
      windows: WINDOWS,
      entries: [entry({})],
      items: [item({ id: 'i2', position: 1, amount: 50 }), item({ id: 'i1', position: 0, amount: 100 })],
      catalog,
    });
    const lunch = slots.find((s) => s.windowName === 'Lunch')!;
    expect(lunch.items.map((i) => i.id)).toEqual(['i1', 'i2']);
    expect(lunch.carbs).toEqual({ carbs_g: 72, complete: true });
    expect(lunch.goal).toEqual({ min: 50, max: 80 });
    expect(lunch.entry!.status).toBe('planned');
  });

  it('ignores deleted entries and deleted items', () => {
    const slots = buildSlots({
      dates: ['2026-09-16'],
      windows: WINDOWS,
      entries: [entry({ id: 'gone' }), synced(entry({}), { deleted: 1 })],
      items: [synced(item({ plan_entry_id: 'gone' }), { deleted: 1 })],
      catalog,
    });
    const lunch = slots.find((s) => s.windowName === 'Lunch')!;
    expect(lunch.entry!.id).toBe('gone');
    expect(lunch.items).toEqual([]);
    expect(lunch.carbs).toEqual({ carbs_g: 0, complete: true });
  });

  it('marks a slot incomplete when an item points at a food that has not synced yet', () => {
    const slots = buildSlots({
      dates: ['2026-09-16'],
      windows: WINDOWS,
      entries: [entry({})],
      items: [item({ ref_id: 'not-here-yet' })],
      catalog,
    });
    expect(slots.find((s) => s.windowName === 'Lunch')!.carbs.complete).toBe(false);
  });
});

describe('windowsFor', () => {
  it('uses the dose-settings version active at local noon of that date', () => {
    const versions = [synced(SEED_SETTINGS)];
    expect(windowsFor(versions, '2026-09-16').map((w) => w.name)).toEqual(SEED_SETTINGS.windows.map((w) => w.name));
  });

  it('returns no windows when no version is effective yet', () => {
    const future = synced({ ...SEED_SETTINGS, id: 'later', effective_from: new Date(2030, 0, 1).getTime() });
    expect(windowsFor([future], '2026-09-16')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @carbbook/web test plan-slots`
Expected: FAIL — `Cannot find module '../src/plan/slots'`.

- [ ] **Step 3: Write `web/src/plan/slots.ts`**

```ts
import {
  activeSettings,
  type CarbGoal,
  type CarbResult,
  type Catalog,
  type DoseSettingsData,
  type DoseWindow,
  itemCarbs,
  parseHHMM,
  type PlanEntryData,
  type PlanItemData,
  type Synced,
  sumCarbs,
} from '@carbbook/core';
import { isLive } from '../db/db';
import { dayRange } from '../ui/format';

/** Stable identity of a slot: a date plus a window name (spec §2: at most one live entry each). */
export const slotKey = (date: string, windowName: string): string => `${date}|${windowName}`;

export interface Slot {
  key: string;
  date: string;
  windowName: string;
  /** The live plan_entry for this slot, or null when nothing is planned here. */
  entry: Synced<PlanEntryData> | null;
  /** Live items in `position` order. */
  items: Synced<PlanItemData>[];
  /** Carbs computed live through core — plans never snapshot (spec §2). */
  carbs: CarbResult;
  goal: CarbGoal | null;
}

const NOON_MS = 12 * 3_600_000;

/**
 * The windows that apply to a calendar date: those of the dose-settings version effective at local
 * noon of that date. Callers must pass versions from the single eligible-versions path
 * (`useEligibleDoseVersions` / `selectActiveSettings`) — never the raw dose_settings table.
 */
export function windowsFor(versions: Synced<DoseSettingsData>[], date: string): DoseWindow[] {
  const settings = activeSettings(versions, dayRange(date)[0] + NOON_MS);
  return settings ? [...settings.windows].sort((a, b) => parseHHMM(a.start) - parseHHMM(b.start)) : [];
}

/** One slot per date × window, in date then window-start order. */
export function buildSlots(args: {
  dates: string[];
  windows: DoseWindow[];
  entries: Synced<PlanEntryData>[];
  items: Synced<PlanItemData>[];
  catalog: Catalog;
}): Slot[] {
  const { dates, windows, catalog } = args;
  const liveEntries = args.entries.filter(isLive);
  const byKey = new Map(liveEntries.map((e) => [slotKey(e.date, e.window_name), e]));
  const itemsByEntry = new Map<string, Synced<PlanItemData>[]>();
  for (const item of args.items.filter(isLive)) {
    itemsByEntry.set(item.plan_entry_id, [...(itemsByEntry.get(item.plan_entry_id) ?? []), item]);
  }

  return dates.flatMap((date) =>
    windows.map((window): Slot => {
      const entry = byKey.get(slotKey(date, window.name)) ?? null;
      const items = entry ? [...(itemsByEntry.get(entry.id) ?? [])].sort((a, b) => a.position - b.position) : [];
      return {
        key: slotKey(date, window.name),
        date,
        windowName: window.name,
        entry,
        items,
        carbs: sumCarbs(items.map((i) => itemCarbs(catalog, i.ref_type, i.ref_id, i.amount, i.unit))),
        goal: window.carb_goal ?? null,
      };
    }),
  );
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @carbbook/web test plan-slots`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/plan/slots.ts web/test/plan-slots.test.ts
git commit -m "feat(web): buildSlots groups plan entries into date x window slots with live carbs"
```

---

### Task 5: Day totals against the summed day goal

**Files:**
- Modify: `web/src/plan/slots.ts`
- Test: `web/test/plan-slots.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `web/test/plan-slots.test.ts`:

```ts
describe('dayTotal', () => {
  it('sums the slots carbs and the window goals', () => {
    const slots = buildSlots({
      dates: ['2026-09-16'],
      windows: WINDOWS,
      entries: [entry({})],
      items: [item({})],
      catalog,
    });
    expect(dayTotal(slots)).toEqual({ carbs: { carbs_g: 48, complete: true }, goal: { min: 80, max: 130 } });
  });

  it('has no day goal when no window in the day has one', () => {
    const noGoals = WINDOWS.map((w) => ({ ...w, carb_goal: null }));
    const slots = buildSlots({ dates: ['2026-09-16'], windows: noGoals, entries: [], items: [], catalog });
    expect(dayTotal(slots).goal).toBeNull();
  });

  it('is incomplete when any slot in the day is incomplete', () => {
    const slots = buildSlots({
      dates: ['2026-09-16'],
      windows: WINDOWS,
      entries: [entry({})],
      items: [item({ ref_id: 'not-here-yet' })],
      catalog,
    });
    expect(dayTotal(slots).carbs.complete).toBe(false);
  });
});
```

Add `dayTotal` to the import from `../src/plan/slots`.

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @carbbook/web test plan-slots`
Expected: FAIL — `dayTotal is not a function`.

- [ ] **Step 3: Add `dayTotal` to `web/src/plan/slots.ts`**

Add `dayGoal` to the `@carbbook/core` import list, then append:

```ts
/**
 * A day's planned carbs against the sum of that day's window goals (spec §3). Windows with no goal
 * contribute nothing to either side; with no goals at all the total has none, which `goalView`
 * renders as a plain number with no colour.
 */
export function dayTotal(slots: Slot[]): { carbs: CarbResult; goal: CarbGoal | null } {
  return {
    carbs: sumCarbs(slots.map((s) => s.carbs)),
    goal: dayGoal(slots.map((s) => s.goal)),
  };
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @carbbook/web test plan-slots`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/plan/slots.ts web/test/plan-slots.test.ts
git commit -m "feat(web): day totals against the summed day carb goal"
```

---

### Task 6: `usePlanData` live hook

**Files:**
- Modify: `web/src/app/hooks.ts`
- Test: `web/test/plan-db.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `web/test/plan-db.test.ts` (and add the imports shown):

```ts
import { renderHook, waitFor } from '@testing-library/react';
import { usePlanData } from '../src/app/hooks';
import { ServicesProvider } from '../src/app/services';
import { makeServices } from './render';

describe('usePlanData', () => {
  it('returns only live plan entries and items', async () => {
    const services = makeServices();
    db = services.db;
    await db.plan_entry.bulkPut([
      { ...entry, updated_at: 1, updated_by: 'x', deleted: 0 },
      { ...entry, id: 'plan-2', updated_at: 1, updated_by: 'x', deleted: 1 },
    ]);
    await db.plan_item.put({ ...item, updated_at: 1, updated_by: 'x', deleted: 0 });

    const { result } = renderHook(() => usePlanData(), {
      wrapper: ({ children }) => <ServicesProvider services={services}>{children}</ServicesProvider>,
    });
    await waitFor(() => expect(result.current).toBeDefined());
    expect(result.current!.entries.map((e) => e.id)).toEqual(['plan-1']);
    expect(result.current!.items.map((i) => i.id)).toEqual(['plan-item-1']);
  });
});
```

Rename the file to `web/test/plan-db.test.tsx` (JSX in the wrapper) and update the earlier
`pnpm --filter @carbbook/web test plan-db` invocations — the pattern still matches.

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @carbbook/web test plan-db`
Expected: FAIL — `usePlanData` is not exported.

- [ ] **Step 3: Add the hook to `web/src/app/hooks.ts`**

Add `PlanEntryData, PlanItemData` to the `@carbbook/core` type import, then add after
`useLogData`:

```ts
/** Live (non-deleted) plan entries and items — the Plan screen and the Calculator suggestion. */
export function usePlanData(): { entries: Synced<PlanEntryData>[]; items: Synced<PlanItemData>[] } | undefined {
  const { db } = useServices();
  return useLiveQuery(async () => {
    const [entries, items] = await Promise.all([db.plan_entry.filter(isLive).toArray(), db.plan_item.filter(isLive).toArray()]);
    return { entries, items };
  }, [db]);
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @carbbook/web test plan-db`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/app/hooks.ts web/test/plan-db.test.tsx
git commit -m "feat(web): usePlanData live query for plan entries and items"
```

---

### Task 7: `saveSlot` / `removeSlot`

**Files:**
- Create: `web/src/plan/saveSlot.ts`
- Test: `web/test/plan-db.test.tsx`

- [ ] **Step 1: Write the failing test**

Append to `web/test/plan-db.test.tsx`:

```ts
import { removeSlot, saveSlot } from '../src/plan/saveSlot';

describe('saveSlot', () => {
  it('writes the entry and its items with positions, and removes dropped items', async () => {
    const services = makeServices();
    db = services.db;
    await saveSlot(services.store, entry, [
      { key: 'a', ref_type: 'food', ref_id: 'tortilla', amount: '1 1/2', unit: 'g' },
      { key: 'b', ref_type: 'food', ref_id: 'tortilla', amount: '2', unit: 'g' },
    ]);
    const saved = (await db.plan_item.toArray()).sort((x, y) => x.position - y.position);
    expect(saved.map((i) => [i.id, i.amount, i.position])).toEqual([
      ['a', 1.5, 0],
      ['b', 2, 1],
    ]);

    await saveSlot(services.store, entry, [{ key: 'b', ref_type: 'food', ref_id: 'tortilla', amount: '2', unit: 'g' }], ['a']);
    expect((await db.plan_item.get('a'))!.deleted).toBe(1);
    expect((await db.plan_item.get('b'))!.position).toBe(0);
  });
});

describe('removeSlot', () => {
  it('soft-deletes the entry and every one of its items', async () => {
    const services = makeServices();
    db = services.db;
    await saveSlot(services.store, entry, [{ key: 'a', ref_type: 'food', ref_id: 'tortilla', amount: '1', unit: 'g' }]);
    await removeSlot(services.store, 'plan-1', ['a']);
    expect((await db.plan_entry.get('plan-1'))!.deleted).toBe(1);
    expect((await db.plan_item.get('a'))!.deleted).toBe(1);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @carbbook/web test plan-db`
Expected: FAIL — `Cannot find module '../src/plan/saveSlot'`.

- [ ] **Step 3: Write `web/src/plan/saveSlot.ts`**

```ts
import type { PlanEntryData } from '@carbbook/core';
import type { Change, Store } from '../db/store';
import { parseAmount } from '../ui/format';
import type { DraftItem } from '../ui/ItemEditor';
import { saveUsdaFoodsFor } from '../usda/materialize';

/**
 * Saves a plan slot and its items in one transaction (item key = plan_item id, order = position),
 * exactly as `saveMeal` does for meals. Every amount must already parse with `parseAmount` — the
 * editor blocks saving otherwise, so `!` here is safe.
 */
export async function saveSlot(
  store: Store,
  entry: PlanEntryData,
  items: DraftItem[],
  removedItemIds: string[] = [],
): Promise<void> {
  // A USDA library food picked into a plan must become a real `food` row, or the plan item would
  // dangle on every other device (same rule as the calculator and the meal editor).
  await saveUsdaFoodsFor(store, items);
  const changes: Change[] = [
    { table: 'plan_entry', data: entry },
    ...items.map(
      (item, position): Change => ({
        table: 'plan_item',
        data: {
          id: item.key,
          plan_entry_id: entry.id,
          ref_type: item.ref_type,
          ref_id: item.ref_id,
          amount: parseAmount(item.amount)!,
          unit: item.unit,
          position,
        },
      }),
    ),
  ];
  await store.saveMany(changes);
  for (const id of removedItemIds) await store.remove('plan_item', id);
}

/** Soft-deletes a slot: its items first, then the entry. */
export async function removeSlot(store: Store, entryId: string, itemIds: string[]): Promise<void> {
  for (const id of itemIds) await store.remove('plan_item', id);
  await store.remove('plan_entry', entryId);
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @carbbook/web test plan-db`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/plan/saveSlot.ts web/test/plan-db.test.tsx
git commit -m "feat(web): saveSlot and removeSlot for plan slots"
```

---

### Task 8: `SlotEditor` — edit one slot with the existing item picker

**Files:**
- Create: `web/src/plan/SlotEditor.tsx`
- Test: `web/test/plan.test.tsx` (create)

- [ ] **Step 1: Write the failing test**

Create `web/test/plan.test.tsx`:

```tsx
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { loadCatalogData } from '../src/db/catalog';
import { SlotEditor } from '../src/plan/SlotEditor';
import { foodData, synced } from './helpers';
import { makeServices, renderWith, seedSettings, type TestServices } from './render';

let services: TestServices;
afterEach(async () => {
  await services.db.delete();
});

async function setup() {
  services = makeServices();
  await seedSettings(services.db);
  await services.db.food.put(synced(foodData({ id: 'tortilla', name: 'Tortilla', carbs_per_100g: 48 })));
  return { user: userEvent.setup(), data: await loadCatalogData(services.db) };
}

describe('SlotEditor', () => {
  it('adds an item with a fraction amount and saves the slot as planned', async () => {
    const { user, data } = await setup();
    renderWith(<SlotEditor date="2026-09-16" windowName="Lunch" slot={null} data={data} onDone={() => {}} />, services);

    await user.type(screen.getByLabelText('Add to this slot'), 'tort');
    await user.click(await screen.findByRole('button', { name: /Tortilla/ }));
    const amount = screen.getByLabelText('Amount of Tortilla');
    await user.clear(amount);
    await user.type(amount, '2/3');
    await user.click(screen.getByRole('button', { name: 'Save slot' }));

    const [entry] = await services.db.plan_entry.toArray();
    expect(entry).toMatchObject({ date: '2026-09-16', window_name: 'Lunch', status: 'planned', log_entry_id: null });
    const [item] = await services.db.plan_item.toArray();
    expect(item).toMatchObject({ plan_entry_id: entry!.id, ref_id: 'tortilla', amount: 2 / 3, position: 0 });
  });

  it('refuses to save an item with an unparseable amount', async () => {
    const { user, data } = await setup();
    renderWith(<SlotEditor date="2026-09-16" windowName="Lunch" slot={null} data={data} onDone={() => {}} />, services);
    await user.type(screen.getByLabelText('Add to this slot'), 'tort');
    await user.click(await screen.findByRole('button', { name: /Tortilla/ }));
    const amount = screen.getByLabelText('Amount of Tortilla');
    await user.clear(amount);
    await user.type(amount, '11/2');
    await user.click(screen.getByRole('button', { name: 'Save slot' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Every item needs an amount.');
    expect(await services.db.plan_entry.count()).toBe(0);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @carbbook/web test plan.test`
Expected: FAIL — `Cannot find module '../src/plan/SlotEditor'`.

- [ ] **Step 3: Write `web/src/plan/SlotEditor.tsx`**

```tsx
import type { PlanEntryData } from '@carbbook/core';
import { useState } from 'react';
import { useUsdaPicks } from '../app/hooks';
import { useServices } from '../app/services';
import { buildCatalog, type CatalogData } from '../db/catalog';
import { parseUsdaFoodId, uuidv7 } from '../lib/ids';
import type { SearchResult } from '../search/search';
import { formatDayLabel, parseAmount } from '../ui/format';
import { type DraftItem, ItemEditor, newDraftItem } from '../ui/ItemEditor';
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
    (slot?.items ?? []).map((i) => ({ key: i.id, ref_type: i.ref_type, ref_id: i.ref_id, amount: String(i.amount), unit: i.unit })),
  );
  const [note, setNote] = useState(slot?.entry?.note ?? '');
  const [errors, setErrors] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const catalog = buildCatalog(data, usda.entries);
  const carbs = items.reduce(
    (acc, item) => {
      const amount = parseAmount(item.amount);
      const result = amount === null ? { carbs_g: 0, complete: false } : { carbs_g: 0, complete: true };
      return { carbs_g: acc.carbs_g, complete: acc.complete && result.complete };
    },
    { carbs_g: 0, complete: true },
  );

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
    if (items.some((i) => parseAmount(i.amount) === null)) problems.push('Every item needs an amount.');
    setErrors(problems);
    if (problems.length > 0) return;
    const entry: PlanEntryData = {
      id: entryId,
      date,
      window_name: windowName,
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
      <SearchPanel label="Add to this slot" onPick={(result) => void pick(result)} />
      <p className="total" data-testid="slot-carbs">
        <span className={goalView(carbs, slot?.goal ?? null).className}>
          <span>{goalView(carbs, slot?.goal ?? null).text}</span>
        </span>
      </p>
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
```

- [ ] **Step 4: Replace the placeholder carbs calculation with core**

The `carbs` reducer above is a stub. Replace it with the real one, which reuses the same
`draftItemCarbs` the Calculator uses (core `itemCarbs` under the hood):

```tsx
import { sumCarbs } from '@carbbook/core';
import { type DraftItem, draftItemCarbs, ItemEditor, newDraftItem } from '../ui/ItemEditor';

  const catalog = buildCatalog(data, usda.entries);
  const carbs = sumCarbs(items.map((item) => draftItemCarbs(catalog, item)));
```

Delete the stub reducer and the now-unused `parseAmount` reference inside it (`parseAmount` is
still used by `save()`).

- [ ] **Step 5: Run the test**

Run: `pnpm --filter @carbbook/web test plan.test`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add web/src/plan/SlotEditor.tsx web/test/plan.test.tsx
git commit -m "feat(web): SlotEditor edits a plan slot with the existing item picker"
```

---

### Task 9: The Plan screen — week navigation and the day list

**Files:**
- Create: `web/src/screens/Plan.tsx`
- Test: `web/test/plan.test.tsx`

- [ ] **Step 1: Write the failing test**

Append to `web/test/plan.test.tsx`:

```tsx
import { Plan } from '../src/screens/Plan';

describe('Plan screen', () => {
  it('shows the Monday-first week containing today, with every window of each day', async () => {
    await setup();
    renderWith(<Plan />, services);
    expect(await screen.findByLabelText('Week starting')).toHaveValue('2026-09-14');
    expect(screen.getByRole('heading', { name: 'Mon 14 Sep' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Sun 20 Sep' })).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { name: 'Lunch' })).toHaveLength(7);
  });

  it('navigates to the previous and next week, including past weeks', async () => {
    const { user } = await setup();
    renderWith(<Plan />, services);
    await user.click(await screen.findByRole('button', { name: 'Previous week' }));
    expect(screen.getByLabelText('Week starting')).toHaveValue('2026-09-07');
    await user.click(screen.getByRole('button', { name: 'Next week' }));
    await user.click(screen.getByRole('button', { name: 'Next week' }));
    expect(screen.getByLabelText('Week starting')).toHaveValue('2026-09-21');
  });

  it('snaps a typed date back to that week Monday', async () => {
    const { user } = await setup();
    renderWith(<Plan />, services);
    const input = await screen.findByLabelText('Week starting');
    await user.clear(input);
    await user.type(input, '2026-09-17');
    expect(input).toHaveValue('2026-09-14');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @carbbook/web test plan.test`
Expected: FAIL — `Cannot find module '../src/screens/Plan'`.

- [ ] **Step 3: Write `web/src/screens/Plan.tsx`**

```tsx
import { useState } from 'react';
import { useCatalogData, useEligibleDoseVersions, usePlanData } from '../app/hooks';
import { useServices } from '../app/services';
import { buildCatalog } from '../db/catalog';
import { SlotEditor } from '../plan/SlotEditor';
import { buildSlots, type Slot, windowsFor } from '../plan/slots';
import { dayKey, formatDayLabel, shiftDay, startOfWeek, weekDates } from '../ui/format';

export function Plan() {
  const { now } = useServices();
  const data = useCatalogData();
  const versions = useEligibleDoseVersions();
  const plan = usePlanData();
  const [monday, setMonday] = useState(() => startOfWeek(dayKey(now())));
  const [editing, setEditing] = useState<{ date: string; windowName: string } | null>(null);

  if (!data || !versions || !plan) return <p>Loading…</p>;

  const catalog = buildCatalog(data);
  const dates = weekDates(monday);
  const byDate = new Map(
    dates.map((date) => [
      date,
      buildSlots({ dates: [date], windows: windowsFor(versions, date), entries: plan.entries, items: plan.items, catalog }),
    ]),
  );

  if (editing) {
    const slot = (byDate.get(editing.date) ?? []).find((s) => s.windowName === editing.windowName) ?? null;
    return (
      <SlotEditor
        date={editing.date}
        windowName={editing.windowName}
        slot={slot && slot.entry ? slot : null}
        data={data}
        onDone={() => setEditing(null)}
      />
    );
  }

  return (
    <div className="screen plan">
      <h1>Plan</h1>
      <div className="day-nav">
        <button type="button" aria-label="Previous week" onClick={() => setMonday(shiftDay(monday, -7))}>
          ‹
        </button>
        <input
          type="date"
          aria-label="Week starting"
          value={monday}
          onChange={(e) => e.target.value && setMonday(startOfWeek(e.target.value))}
        />
        <button type="button" aria-label="Next week" onClick={() => setMonday(shiftDay(monday, 7))}>
          ›
        </button>
      </div>
      <div className="plan-week">
        {dates.map((date) => (
          <section className="plan-day" key={date} aria-label={formatDayLabel(date)}>
            <h2>{formatDayLabel(date)}</h2>
            {(byDate.get(date) ?? []).length === 0 && <p className="muted">No time windows apply to this day.</p>}
            {(byDate.get(date) ?? []).map((slot) => (
              <PlanCell key={slot.key} slot={slot} onEdit={() => setEditing({ date: slot.date, windowName: slot.windowName })} />
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}

function PlanCell(props: { slot: Slot; onEdit: () => void }) {
  const { slot } = props;
  return (
    <div className="plan-cell" data-testid="plan-cell">
      <h3>{slot.windowName}</h3>
      <button type="button" onClick={props.onEdit}>
        {slot.entry ? 'Edit' : '+'}
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @carbbook/web test plan.test`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/screens/Plan.tsx web/test/plan.test.tsx
git commit -m "feat(web): Plan screen with Monday-first week navigation and a day list"
```

---

### Task 10: Plan cells show items, goal-coloured carbs and status; day totals

**Files:**
- Modify: `web/src/screens/Plan.tsx`, `web/src/styles.css`
- Test: `web/test/plan.test.tsx`

- [ ] **Step 1: Write the failing test**

Append to `web/test/plan.test.tsx`:

```tsx
import { synced as sync } from './helpers';

async function seedLunch(date = '2026-09-16', grams = 150) {
  await services.db.plan_entry.put(
    sync({ id: `p-${date}`, date, window_name: 'Lunch', status: 'planned', note: null, log_entry_id: null }),
  );
  await services.db.plan_item.put(
    sync({ id: `i-${date}`, plan_entry_id: `p-${date}`, ref_type: 'food', ref_id: 'tortilla', amount: grams, unit: 'g', position: 0 }),
  );
}

describe('Plan cells', () => {
  it('shows the items, the carbs with the goal and an accessible label, and the status', async () => {
    await setup();
    await seedLunch(); // 150 g tortilla = 72 g carbs, Lunch goal 50-80 → in
    renderWith(<Plan />, services);
    const cell = await screen.findByTestId('plan-cell-2026-09-16-Lunch');
    expect(cell).toHaveTextContent('Tortilla');
    expect(cell).toHaveTextContent('72 g · goal 50–80');
    expect(cell).toHaveTextContent('on target');
    expect(cell).toHaveTextContent('planned');
    expect(within(cell).getByLabelText('72 g, goal 50 to 80, on target')).toHaveClass('goal-in');
  });

  it('colours a slot that is far outside its goal red, still with the numbers in text', async () => {
    await setup();
    await seedLunch('2026-09-16', 300); // 144 g carbs vs 50-80 → out
    renderWith(<Plan />, services);
    const cell = await screen.findByTestId('plan-cell-2026-09-16-Lunch');
    expect(within(cell).getByLabelText('144 g, goal 50 to 80, far outside')).toHaveClass('goal-out');
  });

  it('shows a day total against the summed day goal', async () => {
    await setup();
    await seedLunch();
    renderWith(<Plan />, services);
    const total = await screen.findByTestId('plan-day-total-2026-09-16');
    expect(total).toHaveTextContent('72 g · goal');
  });

  it('shows "missing data" and no number when an item does not resolve', async () => {
    await setup();
    await seedLunch();
    await services.db.plan_item.update('i-2026-09-16', { ref_id: 'not-synced-yet' });
    renderWith(<Plan />, services);
    const cell = await screen.findByTestId('plan-cell-2026-09-16-Lunch');
    expect(cell).toHaveTextContent('missing data');
  });
});
```

Add `within` to the `@testing-library/react` import.

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @carbbook/web test plan.test`
Expected: FAIL — no element with test id `plan-cell-2026-09-16-Lunch`.

- [ ] **Step 3: Fill in the cell and add day totals in `web/src/screens/Plan.tsx`**

Add these imports:

```tsx
import { dayTotal } from '../plan/slots';
import { goalView } from '../plan/goal';
import { itemName } from '../ui/ItemEditor';
import type { Catalog } from '@carbbook/core';
```

Replace the whole `PlanCell` function with:

```tsx
const STATUS_WORDS = { planned: 'planned', logged: 'logged', skipped: 'skipped' } as const;

function GoalReadout(props: { view: ReturnType<typeof goalView>; testId: string }) {
  const { view } = props;
  return (
    <span className={view.className} aria-label={view.ariaLabel} data-testid={props.testId}>
      <span aria-hidden="true">{view.text}</span>
      {view.word && (
        <span className="goal-word" aria-hidden="true">
          {view.word}
        </span>
      )}
    </span>
  );
}

function PlanCell(props: { slot: Slot; catalog: Catalog; onEdit: () => void }) {
  const { slot, catalog } = props;
  const view = goalView(slot.carbs, slot.goal);
  const names = slot.items.map((i) => itemName(catalog, i.ref_type, i.ref_id)).join(', ');
  return (
    <div className="plan-cell" data-testid={`plan-cell-${slot.date}-${slot.windowName}`}>
      <h3>{slot.windowName}</h3>
      {slot.entry ? (
        <>
          <p className="muted">{names || 'No items'}</p>
          <GoalReadout view={view} testId={`plan-carbs-${slot.date}-${slot.windowName}`} />
          <span className="tag">{STATUS_WORDS[slot.entry.status]}</span>
          <button type="button" aria-label={`Edit ${slot.windowName} on ${formatDayLabel(slot.date)}`} onClick={props.onEdit}>
            Edit
          </button>
        </>
      ) : (
        <button type="button" aria-label={`Add to ${slot.windowName} on ${formatDayLabel(slot.date)}`} onClick={props.onEdit}>
          +
        </button>
      )}
    </div>
  );
}
```

In the day `<section>`, pass the catalog and render the total after the cells:

```tsx
            {(byDate.get(date) ?? []).map((slot) => (
              <PlanCell
                key={slot.key}
                slot={slot}
                catalog={catalog}
                onEdit={() => setEditing({ date: slot.date, windowName: slot.windowName })}
              />
            ))}
            <p className="total">
              <GoalReadout view={goalView(dayTotal(byDate.get(date) ?? []).carbs, dayTotal(byDate.get(date) ?? []).goal)} testId={`plan-day-total-${date}`} />
            </p>
```

- [ ] **Step 4: Add the plan layout CSS to `web/src/styles.css`**

Append after the `.goal-*` rules from Task 2:

```css
.plan-week {
  display: grid;
  gap: 16px;
}

.plan-day h2 {
  margin: 0 0 4px;
  font-size: 1rem;
}

.plan-cell {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: center;
  gap: 4px 8px;
  padding: 8px 0;
  border-top: 1px solid var(--border);
}

.plan-cell h3 {
  grid-column: 1;
  margin: 0;
  font-size: 0.95rem;
}

.plan-cell button {
  grid-column: 2;
  grid-row: 1 / span 4;
  min-width: var(--tap);
  min-height: var(--tap);
}

.plan-cell p,
.plan-cell .goal,
.plan-cell .tag {
  grid-column: 1;
}

/* Tablet and up: the same markup becomes the week grid (days as rows, windows as columns). */
@media (min-width: 900px) {
  .plan-day {
    display: grid;
    grid-template-columns: 8rem repeat(auto-fit, minmax(9rem, 1fr));
    align-items: start;
    gap: 8px;
  }
  .plan-day h2 {
    grid-row: 1;
  }
  .plan-cell {
    display: block;
    border-top: none;
  }
  .plan-cell button {
    width: 100%;
  }
}
```

- [ ] **Step 5: Run the test**

Run: `pnpm --filter @carbbook/web test plan.test`
Expected: PASS (9 tests).

- [ ] **Step 6: Commit**

```bash
git add web/src/screens/Plan.tsx web/src/styles.css web/test/plan.test.tsx
git commit -m "feat(web): plan cells show items, goal-coloured carbs, status and day totals"
```

---

### Task 11: Plan route and nav entry

**Files:**
- Modify: `web/src/app/Shell.tsx`
- Test: `web/test/app.test.tsx`

- [ ] **Step 1: Write the failing test**

Append to `web/test/app.test.tsx`:

```tsx
describe('Plan route', () => {
  it('routes /plan to the Plan screen and lists it in the nav', () => {
    expect(routeFor('/plan').label).toBe('Plan');
    expect(ROUTES.map((r) => r.path)).toEqual(['/', '/plan', '/foods', '/meals', '/log', '/settings']);
  });
});
```

Make sure `ROUTES` and `routeFor` are imported from `../src/app/Shell`.

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @carbbook/web test app.test`
Expected: FAIL — `routeFor('/plan').label` is `'Calculator'`.

- [ ] **Step 3: Add the route in `web/src/app/Shell.tsx`**

```tsx
import { Plan } from '../screens/Plan';

export const ROUTES: Route[] = [
  { path: '/', label: 'Calculator', render: () => <Calculator /> },
  { path: '/plan', label: 'Plan', render: () => <Plan /> },
  { path: '/foods', label: 'Foods', render: () => <Foods /> },
  { path: '/meals', label: 'Meals', render: () => <Meals /> },
  { path: '/log', label: 'Log', render: () => <Log /> },
  { path: '/settings', label: 'Settings', render: () => <Settings /> },
];
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @carbbook/web test app.test`
Expected: PASS.

- [ ] **Step 5: Check the tab bar still fits at 375 px**

Run: `pnpm --filter @carbbook/web build && pnpm --filter @carbbook/web preview`
Open `http://localhost:4173` at 375 px width and confirm six tabs fit without horizontal scroll.
If they do not, add to `web/src/styles.css`:

```css
.tabbar a {
  font-size: 0.8rem;
  padding: 8px 4px;
}
```

Stop the preview with Ctrl-C.

- [ ] **Step 6: Commit**

```bash
git add web/src/app/Shell.tsx web/src/styles.css web/test/app.test.tsx
git commit -m "feat(web): add the Plan tab and /plan route"
```

---

### Task 12: `copyChanges` — copy a day or a week with replace / merge / skip

**Files:**
- Create: `web/src/plan/copy.ts`
- Test: `web/test/plan-copy.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `web/test/plan-copy.test.ts`:

```ts
import type { PlanEntryData, PlanItemData, Synced } from '@carbbook/core';
import { describe, expect, it } from 'vitest';
import { conflictDates, copyChanges } from '../src/plan/copy';
import { synced } from './helpers';

const entry = (id: string, date: string, windowName: string, fields: Partial<PlanEntryData> = {}): Synced<PlanEntryData> =>
  synced({ id, date, window_name: windowName, status: 'planned', note: null, log_entry_id: null, ...fields });

const item = (id: string, entryId: string, position: number): Synced<PlanItemData> =>
  synced({ id, plan_entry_id: entryId, ref_type: 'food', ref_id: 'tortilla', amount: 100, unit: 'g', position });

let counter = 0;
const newId = () => `new-${++counter}`;

describe('conflictDates', () => {
  it('lists target dates that already have a live entry', () => {
    const entries = [entry('a', '2026-09-17', 'Lunch')];
    expect(conflictDates(entries, ['2026-09-16', '2026-09-17'])).toEqual(['2026-09-17']);
  });
});

describe('copyChanges', () => {
  const source = [entry('src', '2026-09-16', 'Lunch', { status: 'logged', log_entry_id: 'log-1', note: 'big one' })];
  const sourceItems = [item('si1', 'src', 0), item('si2', 'src', 1)];

  it('copies into an empty target as planned, with fresh ids and no log link', () => {
    counter = 0;
    const result = copyChanges({
      pairs: [{ from: '2026-09-16', to: '2026-09-17' }],
      entries: source,
      items: sourceItems,
      mode: 'skip',
      newId,
    });
    expect(result.removed).toEqual([]);
    const entries = result.changes.filter((c) => c.table === 'plan_entry').map((c) => c.data);
    expect(entries).toEqual([
      { id: 'new-1', date: '2026-09-17', window_name: 'Lunch', status: 'planned', note: 'big one', log_entry_id: null },
    ]);
    const items = result.changes.filter((c) => c.table === 'plan_item').map((c) => c.data);
    expect(items.map((i) => [i.id, i.plan_entry_id, i.position])).toEqual([
      ['new-2', 'new-1', 0],
      ['new-3', 'new-1', 1],
    ]);
  });

  it('skips a day that already has entries', () => {
    counter = 0;
    const result = copyChanges({
      pairs: [{ from: '2026-09-16', to: '2026-09-17' }],
      entries: [...source, entry('tgt', '2026-09-17', 'Dinner')],
      items: sourceItems,
      mode: 'skip',
      newId,
    });
    expect(result.changes).toEqual([]);
    expect(result.removed).toEqual([]);
  });

  it('replace deletes every live entry and item of the target day first', () => {
    counter = 0;
    const result = copyChanges({
      pairs: [{ from: '2026-09-16', to: '2026-09-17' }],
      entries: [...source, entry('tgt', '2026-09-17', 'Dinner')],
      items: [...sourceItems, item('ti1', 'tgt', 0)],
      mode: 'replace',
      newId,
    });
    expect(result.removed).toEqual([
      { table: 'plan_item', id: 'ti1' },
      { table: 'plan_entry', id: 'tgt' },
    ]);
    expect(result.changes.filter((c) => c.table === 'plan_entry')).toHaveLength(1);
  });

  it('merge appends into a matching window and leaves other windows alone', () => {
    counter = 0;
    const result = copyChanges({
      pairs: [{ from: '2026-09-16', to: '2026-09-17' }],
      entries: [...source, entry('tgt', '2026-09-17', 'Lunch'), entry('other', '2026-09-17', 'Dinner')],
      items: [...sourceItems, item('ti1', 'tgt', 0)],
      mode: 'merge',
      newId,
    });
    expect(result.removed).toEqual([]);
    // No new plan_entry: the existing Lunch slot absorbed the items.
    expect(result.changes.filter((c) => c.table === 'plan_entry')).toEqual([]);
    const items = result.changes.filter((c) => c.table === 'plan_item').map((c) => c.data);
    expect(items.map((i) => [i.plan_entry_id, i.position])).toEqual([
      ['tgt', 1],
      ['tgt', 2],
    ]);
  });

  it('merge creates the slot when the target day has no entry for that window', () => {
    counter = 0;
    const result = copyChanges({
      pairs: [{ from: '2026-09-16', to: '2026-09-17' }],
      entries: [...source, entry('other', '2026-09-17', 'Dinner')],
      items: sourceItems,
      mode: 'merge',
      newId,
    });
    expect(result.changes.filter((c) => c.table === 'plan_entry').map((c) => c.data.window_name)).toEqual(['Lunch']);
  });

  it('copies a whole week, one pair per day', () => {
    counter = 0;
    const result = copyChanges({
      pairs: [
        { from: '2026-09-14', to: '2026-09-21' },
        { from: '2026-09-16', to: '2026-09-23' },
      ],
      entries: [entry('a', '2026-09-14', 'Lunch'), entry('b', '2026-09-16', 'Dinner')],
      items: [],
      mode: 'skip',
      newId,
    });
    expect(result.changes.map((c) => c.data.date)).toEqual(['2026-09-21', '2026-09-23']);
  });

  it('ignores deleted source entries and items', () => {
    counter = 0;
    const result = copyChanges({
      pairs: [{ from: '2026-09-16', to: '2026-09-17' }],
      entries: [synced(entry('src', '2026-09-16', 'Lunch'), { deleted: 1 })],
      items: [synced(item('si1', 'src', 0), { deleted: 1 })],
      mode: 'skip',
      newId,
    });
    expect(result.changes).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @carbbook/web test plan-copy`
Expected: FAIL — `Cannot find module '../src/plan/copy'`.

- [ ] **Step 3: Write `web/src/plan/copy.ts`**

```ts
import type { PlanEntryData, PlanItemData, Synced } from '@carbbook/core';
import { isLive } from '../db/db';
import type { Change, Store } from '../db/store';

/** What to do when the target day already has planned slots (spec §4). */
export type CopyMode = 'replace' | 'merge' | 'skip';

export interface CopyResult {
  changes: Change[];
  /** Soft deletes to apply after the writes, items before their entry. */
  removed: { table: 'plan_entry' | 'plan_item'; id: string }[];
}

/** Target dates that already hold at least one live entry, in the order given. */
export function conflictDates(entries: Synced<PlanEntryData>[], dates: string[]): string[] {
  const live = new Set(entries.filter(isLive).map((e) => e.date));
  return dates.filter((date) => live.has(date));
}

/**
 * Computes the writes for one or more `from → to` day copies. Pure: no db, no clock — the caller
 * supplies `newId` (uuidv7) so the result is deterministic in tests. Copied slots are always
 * `planned` with no `log_entry_id`: copying a logged dinner plans it again, it does not claim it
 * was eaten.
 */
export function copyChanges(args: {
  pairs: { from: string; to: string }[];
  entries: Synced<PlanEntryData>[];
  items: Synced<PlanItemData>[];
  mode: CopyMode;
  newId: () => string;
}): CopyResult {
  const { mode, newId } = args;
  const liveEntries = args.entries.filter(isLive);
  const liveItems = args.items.filter(isLive);
  const itemsOf = (entryId: string) => liveItems.filter((i) => i.plan_entry_id === entryId).sort((a, b) => a.position - b.position);

  const changes: Change[] = [];
  const removed: CopyResult['removed'] = [];

  for (const { from, to } of args.pairs) {
    const sources = liveEntries.filter((e) => e.date === from);
    if (sources.length === 0) continue;
    let targets = liveEntries.filter((e) => e.date === to);

    if (targets.length > 0) {
      if (mode === 'skip') continue;
      if (mode === 'replace') {
        for (const target of targets) {
          for (const item of itemsOf(target.id)) removed.push({ table: 'plan_item', id: item.id });
          removed.push({ table: 'plan_entry', id: target.id });
        }
        targets = [];
      }
    }

    for (const source of sources) {
      const existing = targets.find((t) => t.window_name === source.window_name);
      const sourceItems = itemsOf(source.id);
      if (existing) {
        // merge: append after whatever is already in that slot.
        const base = itemsOf(existing.id).reduce((max, i) => Math.max(max, i.position + 1), 0);
        sourceItems.forEach((item, offset) => {
          changes.push({
            table: 'plan_item',
            data: {
              id: newId(),
              plan_entry_id: existing.id,
              ref_type: item.ref_type,
              ref_id: item.ref_id,
              amount: item.amount,
              unit: item.unit,
              position: base + offset,
            },
          });
        });
        continue;
      }
      const entryId = newId();
      changes.push({
        table: 'plan_entry',
        data: {
          id: entryId,
          date: to,
          window_name: source.window_name,
          status: 'planned',
          note: source.note ?? null,
          log_entry_id: null,
        },
      });
      sourceItems.forEach((item, position) => {
        changes.push({
          table: 'plan_item',
          data: {
            id: newId(),
            plan_entry_id: entryId,
            ref_type: item.ref_type,
            ref_id: item.ref_id,
            amount: item.amount,
            unit: item.unit,
            position,
          },
        });
      });
    }
  }
  return { changes, removed };
}

/** Applies a `copyChanges` result: writes first (one transaction), then the soft deletes. */
export async function applyCopy(store: Store, result: CopyResult): Promise<void> {
  await store.saveMany(result.changes);
  for (const { table, id } of result.removed) await store.remove(table, id);
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @carbbook/web test plan-copy`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/plan/copy.ts web/test/plan-copy.test.ts
git commit -m "feat(web): copyChanges computes day and week plan copies with replace/merge/skip"
```

---

### Task 13: `CopyDialog` and the Plan screen's copy actions

**Files:**
- Create: `web/src/plan/CopyDialog.tsx`
- Modify: `web/src/screens/Plan.tsx`
- Test: `web/test/plan.test.tsx`

- [ ] **Step 1: Write the failing test**

Append to `web/test/plan.test.tsx`:

```tsx
describe('copying', () => {
  it('copies a day straight into an empty target date', async () => {
    const { user } = await setup();
    await seedLunch('2026-09-16');
    renderWith(<Plan />, services);
    await user.click(await screen.findByRole('button', { name: 'Copy Wed 16 Sep to another day' }));
    const target = screen.getByLabelText('Copy to');
    await user.clear(target);
    await user.type(target, '2026-09-17');
    await user.click(screen.getByRole('button', { name: 'Copy' }));

    const entries = await services.db.plan_entry.filter((e) => e.date === '2026-09-17' && e.deleted === 0).toArray();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.status).toBe('planned');
  });

  it('asks replace / merge / skip when the target day is not empty and merges on request', async () => {
    const { user } = await setup();
    await seedLunch('2026-09-16');
    await seedLunch('2026-09-17');
    renderWith(<Plan />, services);
    await user.click(await screen.findByRole('button', { name: 'Copy Wed 16 Sep to another day' }));
    const target = screen.getByLabelText('Copy to');
    await user.clear(target);
    await user.type(target, '2026-09-17');
    await user.click(screen.getByRole('button', { name: 'Copy' }));

    expect(await screen.findByRole('dialog', { name: 'Target already has plans' })).toHaveTextContent('2026-09-17');
    await user.click(screen.getByRole('button', { name: 'Merge' }));

    const items = await services.db.plan_item.filter((i) => i.plan_entry_id === 'p-2026-09-17' && i.deleted === 0).toArray();
    expect(items.map((i) => i.position).sort()).toEqual([0, 1]);
  });

  it('replace clears the target day first', async () => {
    const { user } = await setup();
    await seedLunch('2026-09-16');
    await seedLunch('2026-09-17');
    renderWith(<Plan />, services);
    await user.click(await screen.findByRole('button', { name: 'Copy Wed 16 Sep to another day' }));
    const target = screen.getByLabelText('Copy to');
    await user.clear(target);
    await user.type(target, '2026-09-17');
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    await user.click(await screen.findByRole('button', { name: 'Replace' }));

    expect((await services.db.plan_entry.get('p-2026-09-17'))!.deleted).toBe(1);
    const live = await services.db.plan_entry.filter((e) => e.date === '2026-09-17' && e.deleted === 0).toArray();
    expect(live).toHaveLength(1);
    expect(live[0]!.id).not.toBe('p-2026-09-17');
  });

  it('copies the whole week to the next week', async () => {
    const { user } = await setup();
    await seedLunch('2026-09-16');
    renderWith(<Plan />, services);
    await user.click(await screen.findByRole('button', { name: 'Copy week to next week' }));

    const entries = await services.db.plan_entry.filter((e) => e.date === '2026-09-23' && e.deleted === 0).toArray();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.window_name).toBe('Lunch');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @carbbook/web test plan.test`
Expected: FAIL — no button named "Copy Wed 16 Sep to another day".

- [ ] **Step 3: Write `web/src/plan/CopyDialog.tsx`**

```tsx
import type { CopyMode } from './copy';

/**
 * Asked once per copy action (not once per day): the chosen mode applies to every conflicting
 * date, which are listed so the choice is informed.
 */
export function CopyDialog(props: { conflicts: string[]; onChoose: (mode: CopyMode) => void; onCancel: () => void }) {
  return (
    <div className="card" role="dialog" aria-modal="true" aria-label="Target already has plans">
      <p>
        {props.conflicts.length === 1 ? 'This day already has plans:' : 'These days already have plans:'}{' '}
        {props.conflicts.join(', ')}
      </p>
      <div className="button-row">
        <button type="button" onClick={() => props.onChoose('replace')}>
          Replace
        </button>
        <button type="button" onClick={() => props.onChoose('merge')}>
          Merge
        </button>
        <button type="button" onClick={() => props.onChoose('skip')}>
          Skip
        </button>
        <button type="button" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Wire the copy actions into `web/src/screens/Plan.tsx`**

Add imports:

```tsx
import { uuidv7 } from '../lib/ids';
import { applyCopy, conflictDates, type CopyMode, copyChanges } from '../plan/copy';
import { CopyDialog } from '../plan/CopyDialog';
```

Add state next to `editing`:

```tsx
  const [copyForm, setCopyForm] = useState<{ from: string; to: string } | null>(null);
  const [pending, setPending] = useState<{ pairs: { from: string; to: string }[]; conflicts: string[] } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
```

Add the two actions above the `return` (after `byDate` is built):

```tsx
  async function run(pairs: { from: string; to: string }[], mode: CopyMode) {
    const result = copyChanges({ pairs, entries: plan!.entries, items: plan!.items, mode, newId: () => uuidv7(now()) });
    await applyCopy(store, result);
    setPending(null);
    setCopyForm(null);
    setMessage(result.changes.length === 0 ? 'Nothing copied.' : `Copied ${pairs.length === 1 ? 'the day' : 'the week'}.`);
  }

  /** Asks replace/merge/skip only when at least one target day is not empty. */
  function start(pairs: { from: string; to: string }[]) {
    const conflicts = conflictDates(plan!.entries, pairs.map((p) => p.to));
    if (conflicts.length === 0) return void run(pairs, 'skip');
    setPending({ pairs, conflicts });
  }
```

Add `store` to the `useServices()` destructuring at the top: `const { now, store } = useServices();`.

Render, inside the screen `<div>` just after the `day-nav`:

```tsx
      {message && (
        <p role="status" className="message">
          {message}
        </p>
      )}
      <div className="button-row">
        <button type="button" onClick={() => start(dates.map((date) => ({ from: date, to: shiftDay(date, 7) })))}>
          Copy week to next week
        </button>
      </div>
      {pending && <CopyDialog conflicts={pending.conflicts} onChoose={(mode) => void run(pending.pairs, mode)} onCancel={() => setPending(null)} />}
      {copyForm && (
        <form
          className="card"
          aria-label="Copy day"
          onSubmit={(e) => {
            e.preventDefault();
            start([copyForm]);
          }}
        >
          <label>
            Copy to
            <input type="date" value={copyForm.to} onChange={(e) => setCopyForm({ ...copyForm, to: e.target.value })} />
          </label>
          <div className="button-row">
            <button type="submit" className="primary">
              Copy
            </button>
            <button type="button" onClick={() => setCopyForm(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}
```

Add the per-day button inside each day `<section>`, right after the `<h2>`:

```tsx
            <button
              type="button"
              aria-label={`Copy ${formatDayLabel(date)} to another day`}
              onClick={() => setCopyForm({ from: date, to: shiftDay(date, 1) })}
            >
              Copy day
            </button>
```

- [ ] **Step 5: Run the test**

Run: `pnpm --filter @carbbook/web test plan.test`
Expected: PASS (13 tests).

- [ ] **Step 6: Commit**

```bash
git add web/src/plan/CopyDialog.tsx web/src/screens/Plan.tsx web/test/plan.test.tsx
git commit -m "feat(web): copy a plan day or week with replace/merge/skip"
```

---

### Task 14: Per-device dismissed slots

**Files:**
- Create: `web/src/plan/dismissed.ts`
- Test: `web/test/plan-suggestion.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `web/test/plan-suggestion.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { DISMISSED_KEY, dismissSlot, loadDismissed } from '../src/plan/dismissed';

describe('dismissed slots (per device, never synced)', () => {
  beforeEach(() => localStorage.clear());

  it('starts empty', () => {
    expect(loadDismissed().size).toBe(0);
  });

  it('remembers a dismissal keyed by date and window', () => {
    dismissSlot('2026-09-16|Lunch');
    expect(loadDismissed().has('2026-09-16|Lunch')).toBe(true);
    expect(loadDismissed().has('2026-09-16|Dinner')).toBe(false);
    expect(JSON.parse(localStorage.getItem(DISMISSED_KEY)!)).toEqual(['2026-09-16|Lunch']);
  });

  it('survives corrupt storage without throwing', () => {
    localStorage.setItem(DISMISSED_KEY, 'not json');
    expect(loadDismissed().size).toBe(0);
    dismissSlot('2026-09-16|Lunch');
    expect(loadDismissed().has('2026-09-16|Lunch')).toBe(true);
  });

  it('does not throw when storage is unavailable', () => {
    const broken = {
      getItem() {
        throw new Error('blocked');
      },
      setItem() {
        throw new Error('blocked');
      },
    } as unknown as Storage;
    expect(loadDismissed(broken).size).toBe(0);
    expect(() => dismissSlot('2026-09-16|Lunch', broken)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @carbbook/web test plan-suggestion`
Expected: FAIL — `Cannot find module '../src/plan/dismissed'`.

- [ ] **Step 3: Write `web/src/plan/dismissed.ts`**

```ts
/**
 * Slots whose Calculator suggestion was dismissed on THIS device (spec §5). Deliberately
 * localStorage and never a synced record: dismissing hides the prompt here while the other device
 * still offers it. Keys are `slotKey(date, windowName)`.
 */
export const DISMISSED_KEY = 'carbbook.plan.dismissed';

const storageOrNull = (storage?: Storage): Storage | null => {
  try {
    return storage ?? window.localStorage;
  } catch {
    return null; // storage blocked (private mode, disabled cookies)
  }
};

export function loadDismissed(storage?: Storage): Set<string> {
  const store = storageOrNull(storage);
  if (!store) return new Set();
  try {
    const parsed: unknown = JSON.parse(store.getItem(DISMISSED_KEY) ?? '[]');
    return new Set(Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : []);
  } catch {
    return new Set();
  }
}

/** Adds a key; returns the new set so React state can be replaced without re-reading. */
export function dismissSlot(key: string, storage?: Storage): Set<string> {
  const next = loadDismissed(storage).add(key);
  const store = storageOrNull(storage);
  try {
    store?.setItem(DISMISSED_KEY, JSON.stringify([...next]));
  } catch {
    // Storage full or blocked: the dismissal lasts for this session only, which is acceptable.
  }
  return next;
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @carbbook/web test plan-suggestion`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/plan/dismissed.ts web/test/plan-suggestion.test.ts
git commit -m "feat(web): per-device dismissed plan suggestions in localStorage"
```

---

### Task 15: `suggestionFor` — which slot the Calculator should offer

**Files:**
- Create: `web/src/plan/suggestion.ts`
- Test: `web/test/plan-suggestion.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `web/test/plan-suggestion.test.ts`:

```ts
import type { PlanEntryData, PlanItemData, Synced } from '@carbbook/core';
import { buildCatalog } from '../src/db/catalog';
import { suggestionFor } from '../src/plan/suggestion';
import { foodData, synced } from './helpers';

const catalog = buildCatalog({
  foods: [synced(foodData({ id: 'tortilla', name: 'Tortilla', carbs_per_100g: 48 }))],
  portions: [],
  meals: [],
  meal_items: [],
});

const planned: Synced<PlanEntryData> = synced({
  id: 'p1',
  date: '2026-09-16',
  window_name: 'Lunch',
  status: 'planned',
  note: null,
  log_entry_id: null,
});

const planItem: Synced<PlanItemData> = synced({
  id: 'i1',
  plan_entry_id: 'p1',
  ref_type: 'food',
  ref_id: 'tortilla',
  amount: 150,
  unit: 'g',
  position: 0,
});

const args = (over: Partial<Parameters<typeof suggestionFor>[0]> = {}) => ({
  date: '2026-09-16',
  windowName: 'Lunch',
  entries: [planned],
  items: [planItem],
  catalog,
  dismissed: new Set<string>(),
  ...over,
});

describe('suggestionFor', () => {
  it('offers the planned slot for the current date and window, with names and carbs', () => {
    const suggestion = suggestionFor(args())!;
    expect(suggestion.entry.id).toBe('p1');
    expect(suggestion.names).toEqual(['Tortilla']);
    expect(suggestion.carbs).toEqual({ carbs_g: 72, complete: true });
  });

  it('offers nothing when the window is unknown', () => {
    expect(suggestionFor(args({ windowName: null }))).toBeNull();
  });

  it('offers nothing for another date or another window', () => {
    expect(suggestionFor(args({ date: '2026-09-17' }))).toBeNull();
    expect(suggestionFor(args({ windowName: 'Dinner' }))).toBeNull();
  });

  it('offers nothing once the slot is skipped or logged', () => {
    expect(suggestionFor(args({ entries: [{ ...planned, status: 'skipped' }] }))).toBeNull();
    expect(suggestionFor(args({ entries: [{ ...planned, status: 'logged' }] }))).toBeNull();
  });

  it('offers nothing for a slot dismissed on this device', () => {
    expect(suggestionFor(args({ dismissed: new Set(['2026-09-16|Lunch']) }))).toBeNull();
  });

  it('offers nothing for a deleted entry or an entry with no items', () => {
    expect(suggestionFor(args({ entries: [synced(planned, { deleted: 1 })] }))).toBeNull();
    expect(suggestionFor(args({ items: [] }))).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @carbbook/web test plan-suggestion`
Expected: FAIL — `Cannot find module '../src/plan/suggestion'`.

- [ ] **Step 3: Write `web/src/plan/suggestion.ts`**

```ts
import { type CarbResult, type Catalog, itemCarbs, type PlanEntryData, type PlanItemData, type Synced, sumCarbs } from '@carbbook/core';
import { isLive } from '../db/db';
import { itemName } from '../ui/ItemEditor';
import { slotKey } from './slots';

export interface Suggestion {
  key: string;
  entry: Synced<PlanEntryData>;
  /** Live items in position order — what "Load" appends to the Calculator. */
  items: Synced<PlanItemData>[];
  names: string[];
  carbs: CarbResult;
}

/**
 * The planned slot the Calculator should offer right now (spec §5), or null. Never nags: a slot
 * that is already `logged` or `skipped`, or dismissed on this device, produces nothing. An empty
 * slot produces nothing either — there would be nothing to load.
 */
export function suggestionFor(args: {
  date: string;
  /** The window the Calculator is currently in; null (no window) means no suggestion. */
  windowName: string | null;
  entries: Synced<PlanEntryData>[];
  items: Synced<PlanItemData>[];
  catalog: Catalog;
  dismissed: Set<string>;
}): Suggestion | null {
  if (!args.windowName) return null;
  const key = slotKey(args.date, args.windowName);
  if (args.dismissed.has(key)) return null;
  const entry = args.entries.find((e) => isLive(e) && e.date === args.date && e.window_name === args.windowName);
  if (!entry || entry.status !== 'planned') return null;
  const items = args.items.filter((i) => isLive(i) && i.plan_entry_id === entry.id).sort((a, b) => a.position - b.position);
  if (items.length === 0) return null;
  return {
    key,
    entry,
    items,
    names: items.map((i) => itemName(args.catalog, i.ref_type, i.ref_id)),
    carbs: sumCarbs(items.map((i) => itemCarbs(args.catalog, i.ref_type, i.ref_id, i.amount, i.unit))),
  };
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @carbbook/web test plan-suggestion`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/plan/suggestion.ts web/test/plan-suggestion.test.ts
git commit -m "feat(web): suggestionFor picks the planned slot to offer in the Calculator"
```

---

### Task 16: Calculator suggestion line — Load

**Files:**
- Modify: `web/src/screens/Calculator.tsx`
- Test: `web/test/plan-calculator.test.tsx` (create)

- [ ] **Step 1: Write the failing test**

Create `web/test/plan-calculator.test.tsx`:

```tsx
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Calculator } from '../src/screens/Calculator';
import { foodData, synced } from './helpers';
import { makeServices, renderWith, seedSettings, type TestServices } from './render';

let services: TestServices;
afterEach(async () => {
  await services.db.delete();
});
beforeEach(() => localStorage.clear());

/** NOW is local noon on 2026-09-14 → the Lunch window of SEED_SETTINGS. */
async function setup(status: 'planned' | 'skipped' = 'planned') {
  services = makeServices();
  await seedSettings(services.db);
  await services.db.food.put(synced(foodData({ id: 'tortilla', name: 'Tortilla', carbs_per_100g: 48 })));
  await services.db.plan_entry.put(
    synced({ id: 'p1', date: '2026-09-14', window_name: 'Lunch', status, note: null, log_entry_id: null }),
  );
  await services.db.plan_item.put(
    synced({ id: 'i1', plan_entry_id: 'p1', ref_type: 'food', ref_id: 'tortilla', amount: 150, unit: 'g', position: 0 }),
  );
  return userEvent.setup();
}

describe('Calculator plan suggestion', () => {
  it('shows the planned slot with its items and carbs', async () => {
    await setup();
    renderWith(<Calculator />, services);
    const line = await screen.findByTestId('plan-suggestion');
    expect(line).toHaveTextContent('Planned: Tortilla · 72 g');
    expect(screen.getByRole('button', { name: 'Load' })).toBeInTheDocument();
  });

  it('shows nothing when the slot is already skipped', async () => {
    await setup('skipped');
    renderWith(<Calculator />, services);
    await screen.findByRole('heading', { name: 'Calculator' });
    expect(screen.queryByTestId('plan-suggestion')).not.toBeInTheDocument();
  });

  it('Load appends editable rows and hides the line', async () => {
    const user = await setup();
    renderWith(<Calculator />, services);
    await user.click(await screen.findByRole('button', { name: 'Load' }));

    expect(screen.getByLabelText('Amount of Tortilla')).toHaveValue('150');
    expect(screen.getByLabelText('Carbs in Tortilla')).toHaveTextContent('72 g');
    expect(screen.queryByTestId('plan-suggestion')).not.toBeInTheDocument();

    const amount = screen.getByLabelText('Amount of Tortilla');
    await user.clear(amount);
    await user.type(amount, '1/2');
    expect(screen.getByLabelText('Carbs in Tortilla')).toHaveTextContent('0.2 g');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @carbbook/web test plan-calculator`
Expected: FAIL — no element with test id `plan-suggestion`.

- [ ] **Step 3: Add the suggestion line to `web/src/screens/Calculator.tsx`**

Add imports:

```tsx
import { usePlanData } from '../app/hooks';
import { loadDismissed } from '../plan/dismissed';
import { suggestionFor } from '../plan/suggestion';
import { dayKey } from '../ui/format';
```

(`dayKey` joins the existing `../ui/format` import; add it there rather than a second import.)

Add state and data after the existing hooks:

```tsx
  const plan = usePlanData();
  const [dismissed, setDismissed] = useState<Set<string>>(() => loadDismissed());
  /** The slot whose items are currently loaded, so logging can mark it (session-only, not stored). */
  const [loadedSlot, setLoadedSlot] = useState<Synced<PlanEntryData> | null>(null);
```

Add `PlanEntryData, Synced` to the `@carbbook/core` type import.

Extend the loading guard:

```tsx
  if (!data || !versions || !log || !plan) return <p>Loading…</p>;
```

After `autoWindow` / `badAmounts` are computed, add:

```tsx
  const currentWindow = estimate?.window?.name ?? windowName;
  const suggestion =
    loadedSlot === null
      ? suggestionFor({
          date: dayKey(Number.isFinite(eatenAt) ? eatenAt : now()),
          windowName: currentWindow,
          entries: plan.entries,
          items: plan.items,
          catalog,
          dismissed,
        })
      : null;
```

Add the load action next to `addFood`:

```tsx
  function loadSuggestion() {
    if (!suggestion) return;
    // Plain draft rows: amount is text, so the loaded items are editable and removable like any
    // other row. Fresh keys — a plan_item id must never become a log_item id.
    setItems((current) => [
      ...current,
      ...suggestion.items.map((item) => ({
        key: uuidv7(now()),
        ref_type: item.ref_type,
        ref_id: item.ref_id,
        amount: String(item.amount),
        unit: item.unit,
      })),
    ]);
    setLoadedSlot(suggestion.entry);
  }
```

Clear it in `reset()`:

```tsx
  function reset() {
    setItems([]);
    setLoadedSlot(null);
    setTakenEdited(false);
    ...
```

Render the line immediately above `<ItemEditor …>`:

```tsx
      {suggestion && (
        <section className="card plan-suggestion" data-testid="plan-suggestion">
          <p>
            Planned: {suggestion.names.join(', ')} ·{' '}
            {suggestion.carbs.complete ? formatCarbs(suggestion.carbs.carbs_g) : 'missing data'}
          </p>
          <div className="button-row">
            <button type="button" className="primary" onClick={loadSuggestion}>
              Load
            </button>
          </div>
        </section>
      )}
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @carbbook/web test plan-calculator`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/screens/Calculator.tsx web/test/plan-calculator.test.tsx
git commit -m "feat(web): Calculator offers the planned slot and loads it as editable rows"
```

---

### Task 17: Calculator suggestion — Skip and Dismiss

**Files:**
- Modify: `web/src/screens/Calculator.tsx`
- Test: `web/test/plan-calculator.test.tsx`

- [ ] **Step 1: Write the failing test**

Append to `web/test/plan-calculator.test.tsx`:

```tsx
import { DISMISSED_KEY } from '../src/plan/dismissed';

describe('Skip and Dismiss', () => {
  it('Skip sets the slot to skipped and queues it for sync', async () => {
    const user = await setup();
    renderWith(<Calculator />, services);
    await user.click(await screen.findByRole('button', { name: 'Skip' }));

    expect((await services.db.plan_entry.get('p1'))!.status).toBe('skipped');
    expect(await services.db.outbox.get('plan_entry:p1')).toBeDefined();
    expect(screen.queryByTestId('plan-suggestion')).not.toBeInTheDocument();
  });

  it('Dismiss hides it on this device only and never touches the record', async () => {
    const user = await setup();
    renderWith(<Calculator />, services);
    await user.click(await screen.findByRole('button', { name: 'Dismiss' }));

    expect(screen.queryByTestId('plan-suggestion')).not.toBeInTheDocument();
    expect((await services.db.plan_entry.get('p1'))!.status).toBe('planned');
    expect(await services.db.outbox.count()).toBe(0);
    expect(JSON.parse(localStorage.getItem(DISMISSED_KEY)!)).toEqual(['2026-09-14|Lunch']);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @carbbook/web test plan-calculator`
Expected: FAIL — no button named "Skip".

- [ ] **Step 3: Add both actions to `web/src/screens/Calculator.tsx`**

Add `dismissSlot` to the `../plan/dismissed` import and `dataOf` to the `../db/store` import
(`import { type Change, dataOf } from '../db/store';`). Add next to `loadSuggestion`:

```tsx
  /** Spec §5: Skip is a real status change and syncs. */
  async function skipSuggestion() {
    if (!suggestion) return;
    await store.save('plan_entry', { ...dataOf<'plan_entry'>(suggestion.entry), status: 'skipped' });
  }

  /** Spec §5: Dismiss is local to this device and never synced. */
  function dismissSuggestion() {
    if (!suggestion) return;
    setDismissed(dismissSlot(suggestion.key));
  }
```

Add the buttons to the suggestion card's `button-row`:

```tsx
            <button type="button" onClick={() => void skipSuggestion()}>
              Skip
            </button>
            <button type="button" onClick={dismissSuggestion}>
              Dismiss
            </button>
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @carbbook/web test plan-calculator`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/screens/Calculator.tsx web/test/plan-calculator.test.tsx
git commit -m "feat(web): Skip syncs the plan slot, Dismiss hides it on this device only"
```

---

### Task 18: Logging from a loaded slot marks it `logged`

**Files:**
- Modify: `web/src/screens/Calculator.tsx`
- Test: `web/test/plan-calculator.test.tsx`

- [ ] **Step 1: Write the failing test**

Append to `web/test/plan-calculator.test.tsx`:

```tsx
describe('logging a loaded slot', () => {
  it('marks the slot logged and links the log entry', async () => {
    const user = await setup();
    renderWith(<Calculator />, services);
    await user.click(await screen.findByRole('button', { name: 'Load' }));
    await user.click(screen.getByRole('button', { name: 'Log it' }));
    await screen.findByText(/Logged/);

    const slot = (await services.db.plan_entry.get('p1'))!;
    const [logEntry] = await services.db.log_entry.toArray();
    expect(slot.status).toBe('logged');
    expect(slot.log_entry_id).toBe(logEntry!.id);
  });

  it('leaves the plan alone when logging without loading', async () => {
    const user = await setup();
    renderWith(<Calculator />, services);
    await user.type(await screen.findByLabelText('Search foods and meals'), 'tort');
    await user.click(await screen.findByRole('button', { name: /Tortilla/ }));
    await user.click(screen.getByRole('button', { name: 'Log it' }));
    await screen.findByText(/Logged/);

    expect((await services.db.plan_entry.get('p1'))!.status).toBe('planned');
    expect((await services.db.plan_entry.get('p1'))!.log_entry_id).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @carbbook/web test plan-calculator`
Expected: FAIL — slot status is still `planned` after logging a loaded slot.

- [ ] **Step 3: Mark the slot in `logIt()` in `web/src/screens/Calculator.tsx`**

Inside `logIt`, extend the `changes` array build to include the slot update. Insert this
immediately before `await store.saveMany(changes);`:

```tsx
    // Spec §5: logging while a slot is loaded marks the slot and links the entry, in the SAME
    // transaction as the log rows — an offline device must never end up with one without the other.
    if (loadedSlot) {
      changes.push({
        table: 'plan_entry',
        data: { ...dataOf<'plan_entry'>(loadedSlot), status: 'logged', log_entry_id: entryId },
      });
    }
```

(`changes` is declared with `const changes: Change[] = [...]`; `push` on a `const` array is fine.)

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @carbbook/web test plan-calculator`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/screens/Calculator.tsx web/test/plan-calculator.test.tsx
git commit -m "feat(web): logging a loaded plan slot marks it logged and stores log_entry_id"
```

---

### Task 19: Goal colour on the Calculator total

**Files:**
- Modify: `web/src/screens/Calculator.tsx`
- Test: `web/test/plan-calculator.test.tsx`

- [ ] **Step 1: Write the failing test**

Append to `web/test/plan-calculator.test.tsx`:

```tsx
describe('Calculator total against the window goal', () => {
  it('shows the running total with the current window goal and an accessible label', async () => {
    const user = await setup();
    // Give Lunch a goal of 50-80 on a NEW settings version (append-only).
    const current = (await services.db.dose_settings.toArray())[0]!;
    await services.db.dose_settings.put({
      ...current,
      id: 'dose-goals',
      windows: current.windows.map((w) => (w.name === 'Lunch' ? { ...w, carb_goal: { min: 50, max: 80 } } : { ...w, carb_goal: null })),
    });
    renderWith(<Calculator />, services);
    await user.click(await screen.findByRole('button', { name: 'Load' }));

    const total = await screen.findByTestId('total-carbs');
    expect(total).toHaveTextContent('72 g · goal 50–80');
    expect(total).toHaveTextContent('on target');
    expect(screen.getByLabelText('72 g, goal 50 to 80, on target')).toHaveClass('goal-in');
  });

  it('shows the plain total when the current window has no goal', async () => {
    const user = await setup();
    renderWith(<Calculator />, services);
    await user.click(await screen.findByRole('button', { name: 'Load' }));
    const total = await screen.findByTestId('total-carbs');
    expect(total).toHaveTextContent('72 g');
    expect(total).not.toHaveTextContent('goal');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @carbbook/web test plan-calculator`
Expected: FAIL — the total renders "Total 72 g carbs" with no goal.

- [ ] **Step 3: Colour the total in `web/src/screens/Calculator.tsx`**

Add `import { goalView } from '../plan/goal';`. After `currentWindow` is computed, add:

```tsx
  const windowGoal = settings?.windows.find((w) => w.name === currentWindow)?.carb_goal ?? null;
  const totalView = goalView(carbs, windowGoal);
```

Replace the existing total paragraph:

```tsx
      {items.length > 0 && (
        <p className="total" data-testid="total-carbs">
          <span className={totalView.className} aria-label={totalView.ariaLabel}>
            <span aria-hidden="true">{totalView.text}</span>
            {totalView.word && (
              <span className="goal-word" aria-hidden="true">
                {totalView.word}
              </span>
            )}
          </span>
          {carbs.complete ? '' : ' (incomplete)'}
        </p>
      )}
```

Note: `goalView` already renders "missing data" instead of a number when carbs are incomplete, so
the existing `calculator.test.tsx` assertion on `'(incomplete)'` still holds.

- [ ] **Step 4: Run the test and the existing Calculator suite**

Run: `pnpm --filter @carbbook/web test plan-calculator calculator.test`
Expected: PASS. If `calculator.test.tsx` asserted `'Total 72 g carbs'`, update that assertion to
`'72 g'` — the total no longer repeats the words "Total"/"carbs", which `goalView` replaces with
the goal phrasing.

- [ ] **Step 5: Commit**

```bash
git add web/src/screens/Calculator.tsx web/test/plan-calculator.test.tsx web/test/calculator.test.tsx
git commit -m "feat(web): colour the Calculator total against the current window carb goal"
```

---

### Task 20: Goal colour on Log entries, and unlinking a slot when its entry is deleted

**Files:**
- Modify: `web/src/screens/Log.tsx`, `web/src/log/LogEntryEditor.tsx`
- Test: `web/test/log.test.tsx`

- [ ] **Step 1: Write the failing test**

Append to `web/test/log.test.tsx` (reuse that file's existing `setup`/`services` helpers; the
snippet below assumes `services` and a `userEvent` instance the way the file already creates them):

```tsx
describe('Log goal colours', () => {
  it('shows each entry carbs against its window goal', async () => {
    const user = await setup();
    const current = (await services.db.dose_settings.toArray())[0]!;
    await services.db.dose_settings.put({
      ...current,
      id: 'dose-goals',
      windows: current.windows.map((w) => (w.name === 'Lunch' ? { ...w, carb_goal: { min: 50, max: 80 } } : { ...w, carb_goal: null })),
    });
    await services.db.log_entry.put(
      synced({
        id: 'log-1',
        eaten_at: NOW,
        window_name: 'Lunch',
        bg_mgdl: null,
        bg_source: 'none',
        bg_trend: null,
        total_carbs_g: 72,
        suggested_units: null,
        taken_units: null,
        settings_version_id: 'dose-goals',
        notes: null,
      }),
    );
    renderWith(<Log />, services);
    expect(await screen.findByLabelText('72 g, goal 50 to 80, on target')).toHaveClass('goal-in');
    expect(user).toBeDefined();
  });
});

describe('deleting a logged entry', () => {
  it('returns the slot it came from to planned and clears the link', async () => {
    const user = await setup();
    await services.db.log_entry.put(
      synced({
        id: 'log-1',
        eaten_at: NOW,
        window_name: 'Lunch',
        bg_mgdl: null,
        bg_source: 'none',
        bg_trend: null,
        total_carbs_g: 72,
        suggested_units: null,
        taken_units: null,
        settings_version_id: null,
        notes: null,
      }),
    );
    await services.db.plan_entry.put(
      synced({ id: 'p1', date: '2026-09-14', window_name: 'Lunch', status: 'logged', note: null, log_entry_id: 'log-1' }),
    );
    renderWith(<LogEntryEditor entryId="log-1" onDone={() => {}} />, services);
    await user.click(await screen.findByRole('button', { name: 'Delete entry' }));
    await user.click(screen.getByRole('button', { name: 'Tap again to delete' }));

    const slot = (await services.db.plan_entry.get('p1'))!;
    expect(slot.status).toBe('planned');
    expect(slot.log_entry_id).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @carbbook/web test log.test`
Expected: FAIL — no element labelled "72 g, goal 50 to 80, on target"; the slot stays `logged`.

- [ ] **Step 3: Colour Log entries in `web/src/screens/Log.tsx`**

Add imports:

```tsx
import { activeSettings } from '@carbbook/core';
import { useEligibleDoseVersions, useLogData } from '../app/hooks';
import { goalView } from '../plan/goal';
```

Add the hook and extend the guard:

```tsx
  const versions = useEligibleDoseVersions();
  ...
  if (!log || !versions) return <p>Loading…</p>;
```

Inside the entry `map`, before the returned `<li>`, compute the view. Change the map body to:

```tsx
        {entries.map((entry) => {
          // The entry's own settings version if it is still eligible, else whatever was active
          // then — the same precedence LogEntryEditor uses.
          const settings = versions.find((v) => v.id === entry.settings_version_id) ?? activeSettings(versions, entry.eaten_at);
          const goal = settings?.windows.find((w) => w.name === entry.window_name)?.carb_goal ?? null;
          const view = goalView({ carbs_g: entry.total_carbs_g, complete: true }, goal);
          return (
            <li key={entry.id}>
              <button type="button" className="list-item" onClick={() => setEditing(entry.id)}>
                <span>
                  <strong>{formatTime(entry.eaten_at)}</strong> {entry.window_name ?? ''}
                </span>
                <span>
                  <span className={view.className} aria-label={view.ariaLabel}>
                    <span aria-hidden="true">{view.text}</span>
                    {view.word && (
                      <span className="goal-word" aria-hidden="true">
                        {view.word}
                      </span>
                    )}
                  </span>{' '}
                  · BG {entry.bg_mgdl ?? '–'} · est. {entry.suggested_units == null ? '–' : formatUnits(entry.suggested_units)} · took{' '}
                  {entry.taken_units == null ? '–' : formatUnits(entry.taken_units)}
                </span>
                <span className="muted">{(itemsByEntry.get(entry.id) ?? []).map((i) => i.display_name).join(', ')}</span>
              </button>
            </li>
          );
        })}
```

- [ ] **Step 4: Unlink the slot in `web/src/log/LogEntryEditor.tsx`**

Add `dataOf` to the existing `../db/store` import (it is already imported there). Replace the
`remove()` body:

```tsx
  async function remove() {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    // Spec §5: a slot that points at this entry goes back to planned and loses the link, so the
    // Calculator offers it again instead of silently losing the plan.
    const slots = await db.plan_entry.where('log_entry_id').equals(entry.id).filter(isLive).toArray();
    for (const slot of slots) {
      await store.save('plan_entry', { ...dataOf<'plan_entry'>(slot), status: 'planned', log_entry_id: null });
    }
    for (const item of items) await store.remove('log_item', item.id);
    await store.remove('log_entry', entry.id);
    props.onDone();
  }
```

`EntryForm` currently destructures only `{ store, now }` from `useServices()`; change it to
`const { db, store, now } = useServices();`. `isLive` is already imported from `../db/db`.

- [ ] **Step 5: Run the test**

Run: `pnpm --filter @carbbook/web test log.test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/screens/Log.tsx web/src/log/LogEntryEditor.tsx web/test/log.test.tsx
git commit -m "feat(web): goal colours on Log entries; deleting an entry frees its plan slot"
```

---

### Task 21: Dose settings keeps and edits carb goals

**Files:**
- Modify: `web/src/settings/DoseSettingsEditor.tsx`
- Test: `web/test/settings.test.tsx`

Without this, saving any dose-settings change from the web app would silently wipe the seeded
`carb_goal`s — the editor rebuilds each window from its draft fields.

- [ ] **Step 1: Write the failing test**

Append to `web/test/settings.test.tsx` (using that file's existing setup helpers):

```tsx
describe('carb goals in the dose settings editor', () => {
  it('prefills, carries forward and saves an edited goal on a new version', async () => {
    const user = await setup();
    const current = (await services.db.dose_settings.toArray())[0]!;
    await services.db.dose_settings.put({
      ...current,
      windows: current.windows.map((w) => (w.name === 'Lunch' ? { ...w, carb_goal: { min: 50, max: 80 } } : { ...w, carb_goal: null })),
    });
    renderWith(<Settings />, services);
    await user.click(await screen.findByRole('button', { name: 'Edit dose settings' }));

    expect(screen.getByLabelText('Window 3 carb goal minimum (g)')).toHaveValue('50');
    expect(screen.getByLabelText('Window 3 carb goal maximum (g)')).toHaveValue('80');

    const max = screen.getByLabelText('Window 3 carb goal maximum (g)');
    await user.clear(max);
    await user.type(max, '90');
    await user.click(screen.getByRole('button', { name: 'Save as new version' }));

    const versions = await services.db.dose_settings.toArray();
    const saved = versions.find((v) => v.id !== current.id)!;
    expect(saved.windows.find((w) => w.name === 'Lunch')!.carb_goal).toEqual({ min: 50, max: 90 });
    expect(saved.windows.find((w) => w.name === 'Breakfast')!.carb_goal).toBeNull();
  });

  it('rejects a goal whose minimum is above its maximum', async () => {
    const user = await setup();
    renderWith(<Settings />, services);
    await user.click(await screen.findByRole('button', { name: 'Edit dose settings' }));
    await user.type(screen.getByLabelText('Window 3 carb goal minimum (g)'), '90');
    await user.type(screen.getByLabelText('Window 3 carb goal maximum (g)'), '50');
    await user.click(screen.getByRole('button', { name: 'Save as new version' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Window 3 carb goal minimum must not be above its maximum.');
  });
});
```

Adjust the button name `'Edit dose settings'` to whatever `web/src/screens/Settings.tsx` actually
renders — read that file first and use its exact label.

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @carbbook/web test settings.test`
Expected: FAIL — no field labelled "Window 3 carb goal minimum (g)".

- [ ] **Step 3: Add the goal fields to `web/src/settings/DoseSettingsEditor.tsx`**

Add `DOSE_LIMITS` to the `@carbbook/core` import. Extend the draft type and the field keys:

```tsx
interface WindowDraft {
  key: string;
  name: string;
  start: string;
  ratio: string;
  goalMin: string;
  goalMax: string;
}

type FieldKey = 'threshold' | 'step' | 'unitsPerStep' | 'increment' | 'roundDown' | `ratio:${string}` | `goal:${string}`;
```

Prefill from the existing window (this is what stops goals being wiped):

```tsx
  const [windows, setWindows] = useState<WindowDraft[]>(() =>
    initial.windows.map((w) => ({
      key: uuidv7(),
      name: w.name,
      start: w.start,
      ratio: numText(w.ratio_g_per_unit),
      goalMin: numText(w.carb_goal?.min ?? null),
      goalMax: numText(w.carb_goal?.max ?? null),
    })),
  );
```

Replace the `parsedWindows` build inside `save()`:

```tsx
    const parsedWindows = windows.map((w, i) => {
      const both = w.goalMin.trim() !== '' && w.goalMax.trim() !== '';
      const neither = w.goalMin.trim() === '' && w.goalMax.trim() === '';
      let carbGoal: { min: number; max: number } | null = null;
      if (!neither) {
        if (!both) {
          fieldErrors.push(`Window ${i + 1} carb goal needs both a minimum and a maximum, or neither.`);
          badFields.add(`goal:${w.key}`);
        } else {
          // Carb grams are not "amounts": strict decimal only, no fractions (same rule as ratios).
          const min = field(`goal:${w.key}`, w.goalMin, parseNonNegative, `Window ${i + 1} carb goal minimum must be a number.`);
          const max = field(`goal:${w.key}`, w.goalMax, parseNonNegative, `Window ${i + 1} carb goal maximum must be a number.`);
          if (Number.isFinite(min) && Number.isFinite(max)) {
            if (min > max) {
              fieldErrors.push(`Window ${i + 1} carb goal minimum must not be above its maximum.`);
              badFields.add(`goal:${w.key}`);
            } else if (max > DOSE_LIMITS.maxCarbsG) {
              fieldErrors.push(`Window ${i + 1} carb goal maximum must be ${DOSE_LIMITS.maxCarbsG} g or less.`);
              badFields.add(`goal:${w.key}`);
            } else {
              carbGoal = { min, max };
            }
          }
        }
      }
      return {
        name: w.name.trim(),
        start: w.start,
        ratio_g_per_unit: field(`ratio:${w.key}`, w.ratio, parseNonNegative, `Window ${i + 1} carb ratio must be a number (like 8 or 12.5).`),
        carb_goal: carbGoal,
      };
    });
```

Add the two inputs inside the `window-row`, after the ratio input:

```tsx
          <input
            aria-label={`Window ${i + 1} carb goal minimum (g)`}
            inputMode="decimal"
            placeholder="min"
            value={w.goalMin}
            aria-invalid={invalid.has(`goal:${w.key}`) || undefined}
            onChange={(e) => update(w.key, { goalMin: e.target.value })}
          />
          <input
            aria-label={`Window ${i + 1} carb goal maximum (g)`}
            inputMode="decimal"
            placeholder="max"
            value={w.goalMax}
            aria-invalid={invalid.has(`goal:${w.key}`) || undefined}
            onChange={(e) => update(w.key, { goalMax: e.target.value })}
          />
```

And give new windows empty goals:

```tsx
      <button
        type="button"
        onClick={() => setWindows((rows) => [...rows, { key: uuidv7(), name: '', start: '12:00', ratio: '', goalMin: '', goalMax: '' }])}
      >
        Add window
      </button>
```

Finally widen the row in `web/src/styles.css` — find the existing `.window-row` rule and set:

```css
.window-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  align-items: center;
  margin-bottom: 12px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border);
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @carbbook/web test settings.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/settings/DoseSettingsEditor.tsx web/src/styles.css web/test/settings.test.tsx
git commit -m "feat(web): dose settings editor keeps and edits per-window carb goals"
```

---

### Task 22: Playwright end-to-end — plan → load → log offline → sync, and final verification

**Files:**
- Modify: `web/e2e/carbbook.spec.ts`

- [ ] **Step 1: Add the end-to-end test**

Append this test to `web/e2e/carbbook.spec.ts` (it logs in fresh, so it does not depend on the
existing test's state beyond the seeded USDA library and user):

```ts
test('plan a slot, copy the day, load it in the Calculator and log offline, then sync (spec §7)', async ({
  page,
  context,
  playwright,
  baseURL,
}) => {
  await page.goto('/');
  await page.getByLabel('Username').fill(USERNAME);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Calculator' })).toBeVisible();

  // Plan today's Lunch. The Plan screen's week always contains today, so the cell is on screen.
  const today = await page.evaluate(() => {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  });
  await page.getByRole('link', { name: 'Plan' }).click();
  await page.getByTestId(`plan-cell-${today}-Lunch`).getByRole('button').click();
  await page.getByLabel('Add to this slot').fill('peanut');
  await page.getByRole('button', { name: new RegExp(PB) }).click();
  await page.getByLabel(`Amount of ${PB}`).fill('2');
  await page.getByLabel(`Unit for ${PB}`).selectOption('tbsp');
  await page.getByRole('button', { name: 'Save slot' }).click();
  await expect(page.getByTestId(`plan-cell-${today}-Lunch`)).toContainText(PB);
  await expect(page.getByTestId(`plan-carbs-${today}-Lunch`)).toContainText('g');

  // Copy the day to tomorrow (empty target → no conflict dialog).
  await page.getByRole('button', { name: new RegExp(`^Copy .* to another day$`) }).first().click();
  await page.getByRole('button', { name: 'Copy', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Copied the day');

  // Go offline, load the plan in the Calculator and log it.
  await page.getByRole('link', { name: 'Calculator' }).click();
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByTestId('plan-suggestion')).toContainText('Planned:');
  await page.getByRole('button', { name: 'Load' }).click();
  await expect(page.getByLabel(`Amount of ${PB}`)).toHaveValue('2');
  await page.getByRole('button', { name: 'Log it' }).click();
  await expect(page.getByRole('status')).toContainText('Logged');

  // The plan slot now reads "logged" even offline.
  await page.getByRole('link', { name: 'Plan' }).click();
  await expect(page.getByTestId(`plan-cell-${today}-Lunch`)).toContainText('logged');

  // Reconnect and drain the outbox.
  await context.setOffline(false);
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByTestId('pending-count')).toHaveText('0 pending changes', { timeout: 15_000 });

  // The server has the plan rows, the link and the copy.
  const api = await playwright.request.newContext({ baseURL });
  expect((await api.post('/api/auth/login', { data: { username: USERNAME, password: PASSWORD } })).ok()).toBe(true);
  const pull = (await (await api.get('/api/sync/pull?since=0&limit=1000')).json()) as { changes: { table: string; record: Record }[] };
  const rows = (table: string) => pull.changes.filter((c) => c.table === table).map((c) => c.record);

  const planned = rows('plan_entry').filter((e) => e.deleted === 0);
  const loggedSlot = planned.find((e) => e.date === today && e.window_name === 'Lunch')!;
  expect(loggedSlot.status).toBe('logged');
  expect(typeof loggedSlot.log_entry_id).toBe('string');
  expect(rows('log_entry').some((e) => e.id === loggedSlot.log_entry_id)).toBe(true);
  expect(planned.filter((e) => e.date !== today && e.window_name === 'Lunch')).toHaveLength(1);
  expect(rows('plan_item').filter((i) => i.deleted === 0).length).toBeGreaterThanOrEqual(2);
  await api.dispose();
});
```

- [ ] **Step 2: Run the end-to-end suite**

Run: `cd ~/Projects/CarbBook/web && pnpm e2e`
Expected: 2 passed. If the new test fails on the copy-day button name, run
`pnpm e2e --debug` and read the actual accessible name off the Plan screen; the aria-label is
`Copy <Weekday D Mon> to another day` from Task 13.

- [ ] **Step 3: Full verification of the whole plan**

Run each and confirm the stated output:

```bash
cd ~/Projects/CarbBook
pnpm --filter @carbbook/web test          # every web test file passes, 0 failed
pnpm -r typecheck                         # no TypeScript errors in any package
pnpm --filter @carbbook/web build         # tsc + vite build succeed, dist/sw.js is written
```

Expected: all three exit 0. `pnpm --filter @carbbook/web test` must report the eight new/changed
files (`plan-db`, `goal`, `plan-slots`, `plan-copy`, `plan-suggestion`, `plan`,
`plan-calculator`, plus the modified `log`, `settings`, `app`, `format`, `calculator`) all green.

- [ ] **Step 4: Check the Plan screen at 375 px by hand**

Run: `pnpm --filter @carbbook/web preview` (after the build above), open `http://localhost:4173/plan`
in a 375 px-wide window, and confirm:
- each day is one column with its windows stacked, no horizontal scrolling;
- every "+" / "Edit" button is at least 48 px tall;
- goal readouts show the numbers and the status word, not colour alone.

Widen past 900 px and confirm the week grid appears. Stop the preview with Ctrl-C.

- [ ] **Step 5: Commit**

```bash
git add web/e2e/carbbook.spec.ts
git commit -m "test(web): end-to-end plan, copy, load, offline log and sync"
```

---

## Self-review against the spec

**§2 Data model** — `plan_entry` / `plan_item` as synced Dexie tables (Task 1); items written with
`position` (Task 7); carbs always live through core `itemCarbs`/`sumCarbs`, never snapshotted
(Task 4); an unresolvable item makes the slot show "missing data" instead of a number (Tasks 4 and
10). The slot-uniqueness rule and migration 004 are server-side (core/server plan); the web side
never creates a second entry for a slot because `SlotEditor` reuses the existing entry's id.

**§3 Colour feedback** — one `goalView` used by plan cells, plan day totals, the Calculator total
and Log entries (Tasks 2, 10, 19, 20), verified against the shared `testdata/goal-vectors.json`
(Task 2). Numbers always in text, a visible status word, and an `aria-label` carrying both — colour
is never the only signal. Day totals use core `dayGoal` (Task 5).

**§4 Plan screen** — week grid via CSS over a phone-first day list (Tasks 9, 10); cells show items,
goal-coloured carbs and status, empty cells show "+" (Task 10); editing uses the existing picker
with fractions (Task 8); copy day → date and copy week → next week with replace / merge / skip
(Tasks 12, 13); week navigation including past weeks (Task 9). Viewer editing needs no client
change — the store queues writes for owner and viewer alike.

**§5 Calculator integration** — suggestion line with Load / Skip / Dismiss (Tasks 16, 17); Load
appends editable rows (Task 16); Skip syncs `skipped` (Task 17); Dismiss is `localStorage` keyed
date+window and never synced (Tasks 14, 17); logging a loaded slot sets `logged` + `log_entry_id`
in the same transaction (Task 18); logging without loading changes nothing (Task 18); deleting the
linked log entry returns the slot to `planned` (Task 20).

**§6 Sync** — no engine change needed: both tables join `SYNC_TABLES`, so push, pull, outbox,
ownership filtering and rejection restore cover them, proved end to end in Task 1 and Task 22.
Plans are fully editable offline and queue like any other record.

**§7 Testing** — Vitest unit coverage for every pure module, component tests for the Plan screen
and the Calculator suggestion, and the Playwright plan → load → log-offline → sync flow (Task 22).

**Constraints** — all dose/carb math is core (`itemCarbs`, `sumCarbs`, `goalStatus`, `dayGoal`,
`activeSettings`); amounts use strict `parseAmount` and non-amount fields (carb goals) use
`parseNonNegative`; settings always come from `useEligibleDoseVersions` / `activeSettings`; no dose
number is ever printed outside `DoseCard`, which is untouched.

**Out of scope, deliberately** — iOS (spec §8 step 3), the server migration/validation and goal
seeding, and automatic matching of an unplanned log to a planned slot (spec non-goal).
