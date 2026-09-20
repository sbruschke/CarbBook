# Meal-Plan Week Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The meal plan's week starts on a day the user chooses — the same day on every device — and both platforms can jump to today and see which day today is.

**Architecture:** A new one-row-per-key synced table, `preference`, carries `week_start` through the existing push/pull machinery, so no sync code changes — only a table spec and the client mirrors of it. The two week-slicing functions (`startOfWeek` on web, `PlanDate.week(containing:)` on iOS) stop hardcoding Monday and reading the device calendar respectively, and take the first weekday as a parameter instead; shared JSON vectors in `testdata/` keep both implementations honest.

**Tech Stack:** SQLite migrations (server + GRDB), Dexie v5, TypeScript/React (web), SwiftUI, vitest, XCTest.

**Spec:** `docs/superpowers/specs/2026-09-20-health-and-plan-week-design.md` §2.

**Order matters:** Tasks 1–4 land the `preference` table end to end; Tasks 5–7 use it. The server must be deployed (Task 8) before the clients can sync the new table.

---

### Task 1: Week-start vectors and the shared day names

The two cores must agree on what "week starting Wednesday" means. The vectors come first, because both implementations are written against them.

**Files:**
- Create: `testdata/week-start-vectors.json`
- Create: `packages/core/src/week.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/week.test.ts`

- [ ] **Step 1: Write the vectors**

Create `testdata/week-start-vectors.json`:

```json
{
  "days": ["sun", "mon", "tue", "wed", "thu", "fri", "sat"],
  "cases": [
    { "name": "Sunday-first, mid-week date", "date": "2026-09-16", "week_start": "sun", "expect_start": "2026-09-13" },
    { "name": "Monday-first, mid-week date", "date": "2026-09-16", "week_start": "mon", "expect_start": "2026-09-14" },
    { "name": "Wednesday-first, on the start day", "date": "2026-09-16", "week_start": "wed", "expect_start": "2026-09-16" },
    { "name": "Wednesday-first, day before the start day", "date": "2026-09-15", "week_start": "wed", "expect_start": "2026-09-09" },
    { "name": "Saturday-first", "date": "2026-09-16", "week_start": "sat", "expect_start": "2026-09-12" },
    { "name": "Sunday date, Monday-first, crosses back a month", "date": "2026-03-01", "week_start": "mon", "expect_start": "2026-02-23" },
    { "name": "New Year's Day, Sunday-first, crosses the year", "date": "2027-01-01", "week_start": "sun", "expect_start": "2026-12-27" },
    { "name": "Leap day, Monday-first", "date": "2028-02-29", "week_start": "mon", "expect_start": "2028-02-28" },
    { "name": "US spring-forward Sunday, Monday-first", "date": "2027-03-14", "week_start": "mon", "expect_start": "2027-03-08" },
    { "name": "US fall-back Sunday, Sunday-first", "date": "2026-11-01", "week_start": "sun", "expect_start": "2026-11-01" }
  ]
}
```

Each case's seven days are `expect_start` plus the next six calendar days; both implementations assert that too, so the DST cases catch a naive 24-hour-arithmetic bug.

- [ ] **Step 2: Write the failing test**

Create `packages/core/test/week.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type WeekStart, shiftDayKey, startOfWeekOn, weekDatesFrom } from '../src/week';

const vectors = JSON.parse(readFileSync(new URL('../../../testdata/week-start-vectors.json', import.meta.url), 'utf8')) as {
  days: WeekStart[];
  cases: { name: string; date: string; week_start: WeekStart; expect_start: string }[];
};

describe('week start vectors', () => {
  for (const testCase of vectors.cases) {
    it(testCase.name, () => {
      const start = startOfWeekOn(testCase.date, testCase.week_start);
      expect(start).toBe(testCase.expect_start);
      const week = weekDatesFrom(start);
      expect(week).toHaveLength(7);
      expect(week[0]).toBe(testCase.expect_start);
      expect(week[6]).toBe(shiftDayKey(testCase.expect_start, 6));
      expect(week).toContain(testCase.date);
    });
  }

  it('every start day maps a date onto itself when that date is the start day', () => {
    // 2026-09-13 is a Sunday, so day index i is 2026-09-13 + i.
    vectors.days.forEach((day, index) => {
      const date = shiftDayKey('2026-09-13', index);
      expect(startOfWeekOn(date, day)).toBe(date);
    });
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd packages/core && pnpm test week`
Expected: FAIL — cannot resolve `../src/week`.

- [ ] **Step 4: Write the implementation**

Create `packages/core/src/week.ts`:

```ts
/** The day a plan week starts on, as stored in the `preference` row `week_start`. */
export const WEEK_STARTS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

export type WeekStart = (typeof WEEK_STARTS)[number];

export const DEFAULT_WEEK_START: WeekStart = 'sun';

export function isWeekStart(value: unknown): value is WeekStart {
  return typeof value === 'string' && (WEEK_STARTS as readonly string[]).includes(value);
}

/** A day key (YYYY-MM-DD) moved by whole calendar days. Noon anchors it away from DST edges. */
export function shiftDayKey(key: string, days: number): string {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  const date = new Date(y, m - 1, d, 12);
  date.setDate(date.getDate() + days);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The first day of the week containing `key`, given the day weeks start on. */
export function startOfWeekOn(key: string, weekStart: WeekStart): string {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  // getDay(): 0 = Sunday, which is also index 0 of WEEK_STARTS.
  const weekday = new Date(y, m - 1, d, 12).getDay();
  const offset = (weekday - WEEK_STARTS.indexOf(weekStart) + 7) % 7;
  return shiftDayKey(key, -offset);
}

/** The seven day keys of the week beginning at `start`, in order. */
export function weekDatesFrom(start: string): string[] {
  return Array.from({ length: 7 }, (_, index) => shiftDayKey(start, index));
}
```

Add to `packages/core/src/index.ts`, alongside the other `export *` lines:

```ts
export * from './week';
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd packages/core && pnpm test week`
Expected: PASS, 11 tests.

- [ ] **Step 6: Commit**

```bash
git add testdata/week-start-vectors.json packages/core/src/week.ts packages/core/src/index.ts packages/core/test/week.test.ts
git commit -m "core: slice a plan week from any starting weekday"
```

---

### Task 2: The Swift side of the vectors

**Files:**
- Modify: `ios/CarbBookCore/Sources/CarbBookCore/` — create `Week.swift`
- Modify: `ios/CarbBookCore/Tests/CarbBookCoreTests/VectorTests.swift`
- Run: `ios/scripts/sync-testdata.sh` (copies `testdata/` into the Swift test resources)

- [ ] **Step 1: Copy the new vectors into the Swift resources**

Run: `ios/scripts/sync-testdata.sh`
Expected: `testdata/week-start-vectors.json` appears under `ios/CarbBookCore/Tests/CarbBookCoreTests/Resources/`. The CI job `testdata-copies` fails if this is skipped.

- [ ] **Step 2: Write the failing test**

Add to `ios/CarbBookCore/Tests/CarbBookCoreTests/VectorTests.swift`, inside the `VectorTests` class:

```swift
    struct WeekVectors: Decodable {
        struct Case: Decodable { let name: String; let date: String; let week_start: String; let expect_start: String }
        let days: [String]
        let cases: [Case]
    }

    func testWeekStartVectors() throws {
        let vectors: WeekVectors = try load("week-start-vectors")
        for testCase in vectors.cases {
            let start = try XCTUnwrap(WeekStart(rawValue: testCase.week_start), testCase.name)
            let first = CalendarWeek.start(of: testCase.date, weekStart: start)
            XCTAssertEqual(first, testCase.expect_start, testCase.name)
            let week = CalendarWeek.dates(from: first)
            XCTAssertEqual(week.count, 7, testCase.name)
            XCTAssertEqual(week.first, testCase.expect_start, testCase.name)
            XCTAssertTrue(week.contains(testCase.date), testCase.name)
        }
    }
```

Use the same `load(_:)` helper the existing vector tests in this file use; if its signature differs, match it rather than adding a second loader.

- [ ] **Step 3: Run the test to verify it fails**

Run: `ios/scripts/swift-test.sh CarbBookCore --filter testWeekStartVectors`
Expected: FAIL — "cannot find 'CalendarWeek' in scope".

- [ ] **Step 4: Write the implementation**

Create `ios/CarbBookCore/Sources/CarbBookCore/Week.swift`:

```swift
import Foundation

/// The day a plan week starts on, stored in the synced `preference` row `week_start`.
/// Raw values match the web's `WeekStart` union and the order matches `Calendar`'s weekday
/// numbering offset by one (Sunday = index 0).
public enum WeekStart: String, CaseIterable, Codable, Sendable {
    case sun, mon, tue, wed, thu, fri, sat

    public static let `default` = WeekStart.sun

    /// 1 = Sunday … 7 = Saturday, matching `Calendar.firstWeekday`.
    public var firstWeekday: Int { (Self.allCases.firstIndex(of: self) ?? 0) + 1 }
}

/// Week slicing over day keys (YYYY-MM-DD), mirroring `packages/core/src/week.ts` and driven by
/// the same `testdata/week-start-vectors.json`.
public enum CalendarWeek {
    /// The first day of the week containing `date`, for the given start day. An unparseable date
    /// comes back unchanged rather than crashing, matching `PlanDate`'s habit.
    public static func start(of date: String, weekStart: WeekStart, calendar: Calendar = .current) -> String {
        guard let day = PlanDate.date(date, calendar: calendar) else { return date }
        let weekday = calendar.component(.weekday, from: day)
        let offset = (weekday - weekStart.firstWeekday + 7) % 7
        guard let start = calendar.date(byAdding: .day, value: -offset, to: day) else { return date }
        return PlanDate.string(start, calendar: calendar)
    }

    /// The seven day keys beginning at `start`, in order.
    public static func dates(from start: String, calendar: Calendar = .current) -> [String] {
        (0..<7).map { PlanDate.shift(start, byDays: $0, calendar: calendar) }
    }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `ios/scripts/swift-test.sh CarbBookCore --filter testWeekStartVectors`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add ios/CarbBookCore/Sources/CarbBookCore/Week.swift ios/CarbBookCore/Tests/CarbBookCoreTests/VectorTests.swift ios/CarbBookCore/Tests/CarbBookCoreTests/Resources/week-start-vectors.json
git commit -m "core(ios): slice a plan week from any starting weekday"
```

---

### Task 3: The `preference` table on the server

**Files:**
- Create: `server/migrations/007_preferences.sql`
- Modify: `server/src/sync/tables.ts` (`SYNC_TABLES`, `TABLE_SPECS`)
- Test: `server/test/sync-preference.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/test/sync-preference.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { pushAs, testDb } from './sync-helpers';

describe('preference sync', () => {
  it('accepts a week_start row', () => {
    const db = testDb();
    const result = pushAs(db, 'owner', [{ table: 'preference', record: { id: 'week_start', value: 'wed' } }]);
    expect(result[0].status).toBe('accepted');
    expect(db.prepare('SELECT value FROM preference WHERE id = ?').get('week_start')).toEqual({ value: 'wed' });
  });

  it('rejects a week_start value that is not a day', () => {
    const db = testDb();
    const result = pushAs(db, 'owner', [{ table: 'preference', record: { id: 'week_start', value: 'someday' } }]);
    expect(result[0]).toMatchObject({ status: 'rejected', reason: 'invalid' });
  });

  it('leaves other keys unconstrained', () => {
    const db = testDb();
    const result = pushAs(db, 'owner', [{ table: 'preference', record: { id: 'theme', value: 'dark' } }]);
    expect(result[0].status).toBe('accepted');
  });
});
```

Match the helper names actually exported by `server/test/sync-helpers.ts` (the other `sync-*.test.ts` files show the shape); do not invent helpers.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && pnpm test sync-preference`
Expected: FAIL — rejected with reason `unknown_table`.

- [ ] **Step 3: Write the migration**

Create `server/migrations/007_preferences.sql`:

```sql
-- Synced UI preferences (docs/superpowers/specs/2026-09-20-health-and-plan-week-design.md §2).
-- One row per key; `id` is the key. A pure addition: no existing table changes.
-- The runner (server/src/db.ts) wraps this file in one transaction.

-- Deploy guard: refuse to run twice or over a hand-added table.
CREATE TEMP TABLE migration_007_guard (problems INTEGER NOT NULL);
CREATE TEMP TRIGGER migration_007_guard_check BEFORE INSERT ON migration_007_guard
  WHEN NEW.problems > 0
  BEGIN
    SELECT RAISE(ABORT, 'migration 007: preference table already exists; inspect the database before upgrading');
  END;
INSERT INTO migration_007_guard (problems) SELECT
  (SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'preference');
DROP TRIGGER migration_007_guard_check;
DROP TABLE migration_007_guard;

-- Values are opaque text here; per-key validation lives in tables.ts so a bad value is a
-- per-record rejection the client can see, not a failed transaction.
CREATE TABLE preference (
  id TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  server_seq INTEGER NOT NULL
);
CREATE INDEX preference_server_seq ON preference (server_seq);
```

- [ ] **Step 4: Register the table**

In `server/src/sync/tables.ts`, add `'preference',` to the end of the `SYNC_TABLES` array (after `'image'`), import `isWeekStart` from `@carbbook/core` alongside the existing imports, and add this entry to `TABLE_SPECS`:

```ts
  preference: {
    name: 'preference',
    fields: { value: text(200) },
    // `id` is the preference key. Only keys the apps understand are validated; an unknown key is
    // stored as-is so an older server never blocks a newer client's preference.
    check: (r) => (r.id === 'week_start' && !isWeekStart(r.value) ? 'week_start must be one of sun…sat' : null),
  },
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd server && pnpm test sync-preference`
Expected: PASS, 3 tests.

- [ ] **Step 6: Run the whole server suite**

Run: `cd server && pnpm test`
Expected: PASS. `sync-pull.test.ts` and `sync-routes.test.ts` assert over the table list, so update their expectations if they enumerate tables.

- [ ] **Step 7: Commit**

```bash
git add server/migrations/007_preferences.sql server/src/sync/tables.ts server/test/sync-preference.test.ts
git commit -m "server: add the synced preference table"
```

---

### Task 4: The `preference` table on both clients

**Files:**
- Modify: `packages/core/src/types.ts` (add `PreferenceData`)
- Modify: `web/src/db/db.ts:20-48` (`SYNC_TABLES`, `SyncRecords`), `:132-148` (table declaration), and add version 5
- Modify: `ios/CarbBookCore/Sources/CarbBookCore/Types.swift` (add `PreferenceData`)
- Modify: `ios/CarbBookCore/Sources/CarbBookCore/Sync.swift:34-38` (table list)
- Modify: `ios/CarbBookKit/Sources/CarbBookKit/TableCodec.swift:7-21` (`dataColumns`)
- Modify: `ios/CarbBookKit/Sources/CarbBookKit/Schema.swift` (migration `v6-preferences`)
- Test: `ios/CarbBookKit/Tests/CarbBookKitTests/PreferenceStoreTests.swift`

- [ ] **Step 1: Write the failing test**

Create `ios/CarbBookKit/Tests/CarbBookKitTests/PreferenceStoreTests.swift`:

```swift
import CarbBookCore
@testable import CarbBookKit
import XCTest

final class PreferenceStoreTests: XCTestCase {
    func testRoundTripsAPreference() throws {
        let store = try LocalStore(path: nil, now: { 1_000 })
        try store.save("preference", PreferenceData(id: "week_start", value: "wed"))
        let rows: [PreferenceData] = try store.records("preference")
        XCTAssertEqual(rows, [PreferenceData(id: "week_start", value: "wed")])
    }

    func testWeekStartFallsBackToTheDefaultWhenUnsetOrUnknown() throws {
        let store = try LocalStore(path: nil, now: { 1_000 })
        XCTAssertEqual(try store.weekStart(), .default)
        try store.save("preference", PreferenceData(id: "week_start", value: "nonsense"))
        XCTAssertEqual(try store.weekStart(), .default)
        try store.save("preference", PreferenceData(id: "week_start", value: "mon"))
        XCTAssertEqual(try store.weekStart(), .mon)
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `ios/scripts/swift-test.sh CarbBookKit --filter PreferenceStoreTests`
Expected: FAIL — "cannot find 'PreferenceData' in scope".

- [ ] **Step 3: Add the shared types**

In `packages/core/src/types.ts`, next to the other record interfaces:

```ts
/** One synced UI preference; `id` is the key (e.g. `week_start`). */
export interface PreferenceData {
  id: string;
  value: string;
}
```

In `ios/CarbBookCore/Sources/CarbBookCore/Types.swift`:

```swift
/// One synced UI preference; `id` is the key (e.g. `week_start`).
public struct PreferenceData: Codable, Equatable, Sendable {
    public var id: Id
    public var value: String
    public var deleted: Int?

    public init(id: Id, value: String, deleted: Int? = nil) {
        self.id = id; self.value = value; self.deleted = deleted
    }
}
```

- [ ] **Step 4: Register the table on iOS**

In `ios/CarbBookCore/Sources/CarbBookCore/Sync.swift`, append `"preference"` to the synced-table list (after `"image"`).

In `ios/CarbBookKit/Sources/CarbBookKit/TableCodec.swift`, add to `dataColumns`:

```swift
        "preference": ["value"],
```

In `ios/CarbBookKit/Sources/CarbBookKit/Schema.swift`, register the migration after `v5-images`:

```swift
        migrator.registerMigration("v6-preferences") { db in
            try db.execute(sql: v6Preferences)
        }
```

and add the SQL alongside the other `static let` blocks:

```swift
    /// Synced UI preferences (spec 2026-09-20 §2). Mirrors server migration 007 without its CHECKs:
    /// this database stores whatever the server sends, and a row the server would reject comes back
    /// as a `sync_rejection` rather than failing an INSERT here.
    /// No pull-cursor reset: the table is new, so its rows arrive on the next ordinary pull.
    static let v6Preferences = """
    CREATE TABLE preference (
      id TEXT PRIMARY KEY, value TEXT NOT NULL,
      updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, server_seq INTEGER
    );
    """
```

- [ ] **Step 5: Add the typed read**

In `ios/CarbBookKit/Sources/CarbBookKit/Queries.swift`, inside the `extension LocalStore`:

```swift
    /// The plan's first weekday. An unset, deleted or unrecognised value falls back to the default
    /// rather than throwing: a bad preference must never stop the plan from rendering.
    public func weekStart() throws -> WeekStart {
        let rows: [PreferenceData] = try records("preference", "WHERE deleted = 0 AND id = 'week_start'")
        return rows.first.flatMap { WeekStart(rawValue: $0.value) } ?? .default
    }
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `ios/scripts/swift-test.sh CarbBookKit --filter PreferenceStoreTests`
Expected: PASS, 2 tests.

- [ ] **Step 7: Register the table on web**

In `web/src/db/db.ts`: add `'preference',` to `SYNC_TABLES` (after `'image'`), `preference: Synced<PreferenceData>;` to `SyncRecords`, `PreferenceData` to the `@carbbook/core` type import, `declare preference: Table<SyncRecords['preference'], string>;` to the class, and a version 5 block that repeats the version 4 stores plus `preference: 'id',`:

```ts
    // v5 adds the synced `preference` table (spec 2026-09-20 §2). A pure addition: no existing
    // store definition changes, no data migration, and no pull-cursor reset — the rows are new on
    // the server too, so they arrive on the next ordinary pull.
    this.version(5).stores({
      food: 'id, source_ref, image_id',
      portion: 'id, food_id',
      barcode: 'id, code, food_id',
      meal: 'id, image_id',
      meal_item: 'id, meal_id, ref_id',
      log_entry: 'id, eaten_at',
      log_item: 'id, log_entry_id, ref_id',
      dose_settings: 'id, effective_from',
      plan_entry: 'id, date, window_name, log_entry_id',
      plan_item: 'id, plan_entry_id, ref_id',
      image: 'id',
      preference: 'id',
      outbox: 'key',
      meta: 'key',
      sync_error: 'key, at',
      usda_food: 'fdc_id',
      usda_portion: 'id, fdc_id',
      pending_barcode: 'code',
    });
```

- [ ] **Step 8: Run the web and core suites**

Run: `pnpm -r test`
Expected: PASS across `packages/core`, `server` and `web`.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/types.ts web/src/db/db.ts ios/CarbBookCore/Sources/CarbBookCore/Types.swift ios/CarbBookCore/Sources/CarbBookCore/Sync.swift ios/CarbBookKit/Sources/CarbBookKit/TableCodec.swift ios/CarbBookKit/Sources/CarbBookKit/Schema.swift ios/CarbBookKit/Sources/CarbBookKit/Queries.swift ios/CarbBookKit/Tests/CarbBookKitTests/PreferenceStoreTests.swift
git commit -m "clients: mirror the preference table"
```

---

### Task 5: Web — use the setting, add Today, mark today

**Files:**
- Modify: `web/src/ui/format.ts:63-75` (`startOfWeek`, `weekDates`)
- Modify: `web/src/app/hooks.ts` (add `useWeekStart`)
- Modify: `web/src/screens/Plan.tsx:15-110`
- Modify: `web/src/styles.css`
- Test: `web/test/plan-week.test.tsx` (new file; `web/test/plan.test.tsx` is the pattern to follow)

- [ ] **Step 1: Write the failing test**

Create `web/test/plan-week.test.tsx`. The harness is `makeServices`/`renderWith` from `test/render.tsx`,
exactly as `test/plan.test.tsx` uses them; `NOW` there is local noon on 2026-09-14 (a Monday):

```tsx
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { Plan } from '../src/screens/Plan';
import { synced } from './helpers';
import { makeServices, renderWith, seedSettings, type TestServices } from './render';

let services: TestServices;
afterEach(async () => {
  await services.db.delete();
});

async function setup(weekStart?: string) {
  services = makeServices();
  await seedSettings(services.db);
  if (weekStart) await services.db.preference.put(synced({ id: 'week_start', value: weekStart }));
  return userEvent.setup();
}

describe('Plan week navigation', () => {
  it('jumps back to the week containing today', async () => {
    const user = await setup();
    renderWith(<Plan />, services);
    await user.click(await screen.findByRole('button', { name: 'Next week' }));
    await user.click(screen.getByRole('button', { name: 'Today' }));
    // NOW is Monday 2026-09-14; the default week start is Sunday.
    expect((screen.getByLabelText('Week starting') as HTMLInputElement).value).toBe('2026-09-13');
  });

  it('marks today in the grid', async () => {
    await setup();
    renderWith(<Plan />, services);
    expect(await screen.findByTestId('day-2026-09-14')).toHaveAttribute('data-today', 'true');
    expect(screen.getByTestId('day-2026-09-15')).not.toHaveAttribute('data-today');
  });

  it('starts the week on the stored preference', async () => {
    await setup('wed');
    renderWith(<Plan />, services);
    // The Wednesday on or before Monday 2026-09-14.
    expect((await screen.findByLabelText('Week starting')) as HTMLInputElement).toHaveValue('2026-09-09');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && pnpm test plan-week`
Expected: FAIL — no "Today" button.

- [ ] **Step 3: Make the week functions take the start day**

In `web/src/ui/format.ts`, replace `startOfWeek` and `weekDates` with thin re-exports of the core functions so there is one implementation:

```ts
import { DEFAULT_WEEK_START, startOfWeekOn, weekDatesFrom, type WeekStart } from '@carbbook/core';

/** The first day of the week containing `key`, for the user's chosen start day (spec 2026-09-20 §2). */
export function startOfWeek(key: string, weekStart: WeekStart = DEFAULT_WEEK_START): string {
  return startOfWeekOn(key, weekStart);
}

/** The seven local day keys of the week starting at `start`, in order. */
export function weekDates(start: string): string[] {
  return weekDatesFrom(start);
}
```

Fix any caller that relied on the old Monday-only behaviour — `grep -rn "startOfWeek" web/src` and pass the setting through.

- [ ] **Step 4: Add the hook**

In `web/src/app/hooks.ts`:

```ts
/** The plan's first weekday, from the synced `preference` table; the default until one is stored. */
export function useWeekStart(): WeekStart {
  const { db } = useServices();
  const row = useLiveQuery(() => db.preference.get('week_start'), [db]);
  return row && row.deleted === 0 && isWeekStart(row.value) ? row.value : DEFAULT_WEEK_START;
}
```

Import `DEFAULT_WEEK_START`, `isWeekStart` and the `WeekStart` type from `@carbbook/core`.

- [ ] **Step 5: Use it in the Plan screen**

In `web/src/screens/Plan.tsx`:

- call `const weekStart = useWeekStart();`
- initialise the anchor with it: `useState(() => startOfWeek(dayKey(now()), weekStart))`
- re-snap when the preference changes, so an edit in Settings moves the visible grid:

```tsx
  useEffect(() => {
    setMonday((current) => {
      const snapped = startOfWeek(current, weekStart);
      setWeekInput(snapped);
      return snapped;
    });
  }, [weekStart]);
```

- snap the date input with the setting: `const snapped = startOfWeek(value, weekStart);`
- add the Today button between the arrows' container and the date input:

```tsx
        <button
          type="button"
          onClick={() => {
            const today = startOfWeek(dayKey(now()), weekStart);
            setMonday(today);
            setWeekInput(today);
          }}
        >
          Today
        </button>
```

- mark today on each day container, where the grid maps over `dates`:

```tsx
            <div className="plan-day" data-testid={`day-${date}`} data-today={date === dayKey(now()) ? 'true' : undefined}>
```

Rename the `monday`/`setMonday` state to `weekStartDate`/`setWeekStartDate` in this file — with a configurable start day, "monday" is now a lie.

- [ ] **Step 6: Style today's column**

In `web/src/styles.css`, next to the other `.plan-` rules:

```css
.plan-day[data-today='true'] > .plan-day-header {
  font-weight: 600;
  box-shadow: inset 0 -2px 0 currentColor;
}
```

Match the existing class names in `Plan.tsx`; if the header element has a different class, use that one.

- [ ] **Step 7: Run the test to verify it passes**

Run: `cd web && pnpm test plan-week`
Expected: PASS, 3 tests.

- [ ] **Step 8: Typecheck and run the whole web suite**

Run: `cd web && pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add web/src/ui/format.ts web/src/app/hooks.ts web/src/screens/Plan.tsx web/test/plan-week.test.tsx web/src/styles.css
git commit -m "web: honour the week-start preference, add Today, mark today"
```

---

### Task 6: Web — the Settings picker

**Files:**
- Modify: `web/src/screens/Settings.tsx`

- [ ] **Step 1: Add the section**

In `web/src/screens/Settings.tsx`, add a section component and render it alongside the existing ones:

```tsx
function WeekStartSection() {
  const { store } = useServices();
  const weekStart = useWeekStart();
  const labels: Record<WeekStart, string> = {
    sun: 'Sunday', mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday',
  };
  return (
    <section>
      <h2>Meal plan</h2>
      <label>
        Week starts on
        <select
          value={weekStart}
          onChange={(e) => void store.save('preference', { id: 'week_start', value: e.target.value })}
        >
          {WEEK_STARTS.map((day) => (
            <option key={day} value={day}>
              {labels[day]}
            </option>
          ))}
        </select>
      </label>
      <p className="muted">Applies to the plan on every device.</p>
    </section>
  );
}
```

Import `WEEK_STARTS` and the `WeekStart` type from `@carbbook/core` and `useWeekStart` from `../app/hooks`.

- [ ] **Step 2: Typecheck and test**

Run: `cd web && pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add web/src/screens/Settings.tsx
git commit -m "web: pick the day the plan week starts on"
```

---

### Task 7: iOS — use the setting, mark today, add the picker

**Files:**
- Modify: `ios/CarbBook/Plan/PlanModel.swift:21-45`, `:70-80`
- Modify: `ios/CarbBook/Plan/PlanWeekView.swift:20-70`
- Modify: `ios/CarbBook/Settings/SettingsView.swift`

iOS already has a Today button (`PlanWeekView.swift:40` → `PlanModel.showToday`), so only the week start, the highlight and the picker are new here.

- [ ] **Step 1: Slice the week with the preference**

In `ios/CarbBook/Plan/PlanModel.swift`, add a stored `private(set) var weekStart: WeekStart = .default`, and in the loading function (around line 39) replace:

```swift
            week = PlanDate.week(containing: anchor)
```

with:

```swift
            weekStart = (try? app.store.weekStart()) ?? .default
            week = CalendarWeek.dates(from: CalendarWeek.start(of: anchor, weekStart: weekStart))
```

Leave `PlanDate.week(containing:)` in place for any other caller; if `grep -rn "PlanDate.week" ios/` shows this was its only use, delete the function and its test instead of leaving dead code.

- [ ] **Step 2: Mark today in the grid**

In `ios/CarbBook/Plan/PlanWeekView.swift`, in `dayHeader(_:)` (around line 64):

```swift
    private func dayHeader(_ date: String) -> some View {
        let isToday = date == PlanDate.string(Date())
        return HStack {
            Text(PlanDate.date(date).map { $0.formatted(.dateTime.weekday(.abbreviated).month().day()) } ?? date)
                .fontWeight(isToday ? .semibold : .regular)
            if isToday {
                Text("Today").font(.caption2).foregroundStyle(.tint)
            }
        }
    }
```

Keep whatever the existing `dayHeader` returns around the `Text` — wrap it rather than replacing surrounding modifiers.

- [ ] **Step 3: Add the Settings picker**

In `ios/CarbBook/Settings/SettingsView.swift`, add after the "Dose settings" section:

```swift
                Section("Meal plan") {
                    Picker("Week starts on", selection: Binding(
                        get: { weekStart },
                        set: { day in
                            weekStart = day
                            try? app.save([SyncChange.encode("preference", PreferenceData(id: "week_start", value: day.rawValue))])
                        })) {
                        ForEach(WeekStart.allCases, id: \.self) { day in
                            Text(dayName(day)).tag(day)
                        }
                    }
                    Text("Applies to the plan on every device.").font(.footnote).foregroundStyle(.secondary)
                }
```

with, on the view:

```swift
    @State private var weekStart: WeekStart = .default

    private func dayName(_ day: WeekStart) -> String {
        switch day {
        case .sun: "Sunday"
        case .mon: "Monday"
        case .tue: "Tuesday"
        case .wed: "Wednesday"
        case .thu: "Thursday"
        case .fri: "Friday"
        case .sat: "Saturday"
        }
    }
```

and load the stored value in the view's existing `.onAppear` (add one if there is none):

```swift
            .onAppear { weekStart = (try? app.store.weekStart()) ?? .default }
```

- [ ] **Step 4: Run the Kit and Core suites**

Run: `ios/scripts/swift-test.sh CarbBookCore && ios/scripts/swift-test.sh CarbBookKit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ios/CarbBook/Plan/PlanModel.swift ios/CarbBook/Plan/PlanWeekView.swift ios/CarbBook/Settings/SettingsView.swift
git commit -m "ios: honour the week-start preference and mark today"
```

---

### Task 8: Ship it

**Files:** none changed.

- [ ] **Step 1: Open the PR and let CI compile the app**

```bash
git push -u origin <branch>
gh pr create --title "plan: configurable week start, jump to today" --body "Implements docs/superpowers/specs/2026-09-20-health-and-plan-week-design.md §2."
```

Run: `gh run watch <build-ipa id> --exit-status`
Expected: `build-ipa` and `ios-tests` both pass.

- [ ] **Step 2: Back up the Pi database before the migration**

Run: `ssh pi sudo systemctl start carbbook-backup.service`
Expected: exits 0. Migration 007 adds a table, but the runbook's rule is a backup before every migration.

- [ ] **Step 3: Merge and deploy the server**

```bash
gh pr merge <n> --merge --delete-branch
deploy/deploy.sh
```

Expected: the deploy prints the new tag, and `user_version` advances to 7.

- [ ] **Step 4: Verify the migration landed**

Run: `ssh pi "docker exec carbs-server node -e \"const d=require('better-sqlite3')('/data/carbbook.db');console.log(d.pragma('user_version'), d.prepare('select count(*) c from preference').get())\""`
Expected: `7 { c: 0 }`.

- [ ] **Step 5: Verify on the web app**

Open https://recipes.dxshdw.dev, set Settings › Meal plan › Week starts on to a non-default day, reload, and confirm the plan grid starts on that day and "Today" returns to the current week.

- [ ] **Step 6: Verify on the phone**

Install the release build, open the plan, and confirm it starts on the same day the web app does, that today's header is marked, and that changing the day in iOS Settings moves the web grid after a sync.
