# Meal Planning (iOS) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring meal planning and carb goals to the CarbBook iPhone app: a Swift mirror of core `goalStatus`/`dayGoal` and the plan types, a GRDB migration and sync coverage for `plan_entry`/`plan_item`, a Plan screen with a week view, cell editor and copy day/week, a Calculator suggestion line with Load/Skip/Dismiss, goal colours in Plan, Calculator and Log, and a release through ipa-hub.

**Architecture:** Three layers, same as the existing app. `ios/CarbBookCore` gets the new pure types (`CarbGoal`, `GoalStatus`, `PlanEntryData`, `PlanItemData`) and the two pure functions (`goalStatus`, `dayGoal`) plus their shared-vector test; it is Foundation-only and tests on Linux. `ios/CarbBookKit` gets schema migration `v3-meal-plan`, `TableCodec` entries, plan read queries and a set of pure, Linux-tested helpers (`PlanDate`, `PlanEditing`, `PlanSuggestion`, `PlanDismissals`, `PlanLogLink`) that hold every decision the Plan and Calculator screens make. `ios/CarbBook` gets a new `Plan` tab plus small edits to Calculator, Log, Settings and `Theme`; SwiftUI cannot be compiled on this machine, so every UI task ends with a CI build checkpoint.

**Tech Stack:** Swift 6 toolchain (Xcode 26.6 on `macos-26`; `swift:6.3.3-noble` in Docker via `ios/scripts/swift-test.sh`), SwiftUI + Observation (iOS 17), GRDB.swift 7.11.1, XCTest, XcodeGen, GitHub Actions (`ios-tests`, `build-ipa`, `release`).

**Spec:** `docs/superpowers/specs/2026-09-16-meal-planning-design.md` (source of truth). Sibling plans: `docs/superpowers/plans/2026-09-16-meal-planning-core-server.md` (TS core + server) and `...-meal-planning-web.md` (web UX this mirrors).

**Branch:** `feat/meal-planning-ios`, cut from `main` **after** the core/server plan has merged.

---

## The contract this plan builds on

Both sibling plans exist and were read while writing this one. The facts below come from them and from `testdata/goal-vectors.json` as it stands on disk (2026-09-16). **Prerequisite: the core/server plan must be merged to `main` before Task 1** — the shared vectors, the `carb_goal` field and the two server tables all come from it. Verify with the command in Task 3 Step 1.

1. **Synced tables** (server migration `004_meal_plan.sql`), with the usual metadata columns (`updated_at`, `updated_by`, `deleted`, `server_seq`):
   - `plan_entry`: `id`, `date` (`YYYY-MM-DD`), `window_name` (1–64 chars), `status` (`planned` | `logged` | `skipped`), `note`, `log_entry_id`
   - `plan_item`: `id`, `plan_entry_id`, `ref_type`, `ref_id`, `amount` (`>= 0`), `unit`, `position`
   Both are appended to the server's `SYNC_TABLES`, after `dose_settings`. The iOS pull is generic (`SyncEngine` applies whatever the server sends), so only `TableCodec.dataColumns` and the local GRDB schema need to learn about them.
2. **`dose_settings.windows[]` gains `carb_goal`**: `{ "min": <number>, "max": <number> }` or `null`. `windows` is already one JSON text column locally, so no local schema change is needed for it. The server canonicalizes window key order before its append-only equality check, so the key order iOS encodes does not matter.
3. **Slot uniqueness** is a server-side partial unique index; a second live entry for the same (date, window) is rejected `duplicate_slot`, which surfaces through the existing `sync_rejection` path in Settings → Sync with no iOS work.
4. **Goals are seeded server-side** as a second `dose_settings` version (`SEED_GOAL_WINDOWS`: Breakfast 30–50, AM Snack 10–30, Lunch 50–80, PM Snack 10–30, Dinner 50–80, HS Snack 10–30). iOS never seeds; it must only *display* goals and *preserve* them when the Settings editor writes a new version (Task 18).
5. **"Log entry deleted → its slot returns to `planned`" is a server rule** (core/server plan Task 13), applied when a `log_entry` with `deleted = 1` is accepted. iOS applies the same change locally as well, so the Plan screen is right while offline; both writes set identical content, so last-write-wins converges either way (Task 12).
6. **`GoalStatus` labels** match the TS `GOAL_STATUS_LABELS` exactly: `none` "no goal", `in` "in goal", `near` "near goal", `off` "off goal", `out` "outside goal".
7. **Dismissal keys** match the web app's: `"<date>|<window>"`, per device, never synced (web uses `localStorage`; iOS uses `UserDefaults`).
8. The app currently has **5 tabs**; Plan becomes the 6th, inserted between Meals and Log.

---

## File structure

**Created**

| File | Responsibility |
| --- | --- |
| `ios/CarbBookCore/Sources/CarbBookCore/Goals.swift` | `CarbGoal`, `GoalStatus`, `goalStatus`, `dayGoal`, `goalText`, and the short screen-reader label. Pure. |
| `ios/CarbBookCore/Sources/CarbBookCore/Plan.swift` | `PlanStatus`, `PlanEntryData`, `PlanItemData` — wire-shaped Codable structs with explicit-null encoding. |
| `ios/CarbBookCore/Tests/CarbBookCoreTests/GoalsTests.swift` | Boundary tests for `goalStatus`/`dayGoal`/`goalText`. |
| `ios/CarbBookCore/Tests/CarbBookCoreTests/PlanTypesTests.swift` | Encoding tests for the two plan structs (explicit JSON nulls). |
| `ios/CarbBookKit/Sources/CarbBookKit/PlanDate.swift` | Local `YYYY-MM-DD` conversions and week arithmetic. |
| `ios/CarbBookKit/Sources/CarbBookKit/PlanEditing.swift` | Slot totals, slot save records, copy day/week with replace/merge/skip. |
| `ios/CarbBookKit/Sources/CarbBookKit/PlanSuggestion.swift` | The Calculator suggestion: which slot applies, the Load lines, and on-device `PlanDismissals` (UserDefaults). |
| `ios/CarbBookKit/Sources/CarbBookKit/PlanLogLink.swift` | Slot ↔ log entry linking: `logged` + `log_entry_id` on logging, unlink on log delete. |
| `ios/CarbBookKit/Tests/CarbBookKitTests/PlanDateTests.swift` | Date/week helpers. |
| `ios/CarbBookKit/Tests/CarbBookKitTests/PlanEditingTests.swift` | Totals, slot records, copy modes. |
| `ios/CarbBookKit/Tests/CarbBookKitTests/PlanSuggestionTests.swift` | Suggestion selection and dismissals. |
| `ios/CarbBookKit/Tests/CarbBookKitTests/PlanLogLinkTests.swift` | Link and unlink records. |
| `ios/CarbBookKit/Tests/CarbBookKitTests/PlanStoreTests.swift` | Migration, queries and sync round-trip for the two tables. |
| `ios/CarbBook/Plan/PlanModel.swift` | `@Observable` week state: load, edit, copy, status changes. |
| `ios/CarbBook/Plan/PlanWeekView.swift` | The Plan tab: week navigation, day list, slot cells, day totals. |
| `ios/CarbBook/Plan/PlanSlotEditorView.swift` | Cell editor: item rows with fraction amounts, reusing `AddItemSheet` and `UnitPicker`. |
| `ios/CarbBook/Plan/PlanCopySheet.swift` | Copy day / copy week destination picker and the replace/merge/skip prompt. |

**Modified**

| File | Change |
| --- | --- |
| `ios/CarbBookCore/Sources/CarbBookCore/Types.swift` | `DoseWindow.carbGoal` + explicit `encode(to:)`. |
| `ios/CarbBookCore/Sources/CarbBookCore/DoseSettingsDraft.swift` | `validateDoseSettings` checks goal bounds. |
| `ios/CarbBookCore/Tests/CarbBookCoreTests/VectorTests.swift` | Runs `goal-vectors.json`. |
| `ios/scripts/sync-testdata.sh` | Copies `goal-vectors.json` into the core test bundle. |
| `ios/CarbBookKit/Sources/CarbBookKit/Schema.swift` | Migration `v3-meal-plan`. |
| `ios/CarbBookKit/Sources/CarbBookKit/TableCodec.swift` | `plan_entry` / `plan_item` data columns. |
| `ios/CarbBookKit/Sources/CarbBookKit/Queries.swift` | Plan read queries. |
| `ios/CarbBook/App/Theme.swift` | `GoalStyle` + `goalStyle(...)` and a `GoalBadge` view. |
| `ios/CarbBook/App/RootView.swift` | Plan tab. |
| `ios/CarbBook/Calculator/CalculatorModel.swift` | Suggestion state, Load/Skip/Dismiss, slot→logged on log. |
| `ios/CarbBook/Calculator/CalculatorView.swift` | Suggestion line and goal colour on the running total. |
| `ios/CarbBook/Log/LogView.swift` | Goal colour per entry and on the day total; unlink slots on delete. |
| `ios/CarbBook/Settings/DoseSettingsEditorView.swift` | Per-window carb goal fields, so a new version keeps the seeded goals. |
| `ios/project.yml` | `MARKETING_VERSION` bump for the release. |

---

## Task 1: `CarbGoal` on dose windows

**Files:**
- Create: `ios/CarbBookCore/Sources/CarbBookCore/Goals.swift`
- Modify: `ios/CarbBookCore/Sources/CarbBookCore/Types.swift:149-163`
- Test: `ios/CarbBookCore/Tests/CarbBookCoreTests/GoalsTests.swift`

- [ ] **Step 1: Create the branch**

```bash
cd ~/Projects/CarbBook && git checkout main && git pull && git checkout -b feat/meal-planning-ios
```

- [ ] **Step 2: Write the failing test**

Create `ios/CarbBookCore/Tests/CarbBookCoreTests/GoalsTests.swift`:

```swift
import Foundation
import XCTest
@testable import CarbBookCore

final class GoalsTests: XCTestCase {
    private func encoded(_ window: DoseWindow) throws -> [String: JSONValue] {
        guard case .object(let fields) = try JSONValue.from(window) else { return [:] }
        return fields
    }

    func testWindowDecodesACarbGoal() throws {
        let json = #"{"name":"Lunch","start":"11:00","ratio_g_per_unit":8,"carb_goal":{"min":50,"max":80}}"#
        let window = try JSONDecoder().decode(DoseWindow.self, from: Data(json.utf8))
        XCTAssertEqual(window.carbGoal, CarbGoal(min: 50, max: 80))
    }

    func testWindowWithoutACarbGoalKeyDecodesAsNoGoal() throws {
        let json = #"{"name":"Lunch","start":"11:00","ratio_g_per_unit":8}"#
        let window = try JSONDecoder().decode(DoseWindow.self, from: Data(json.utf8))
        XCTAssertNil(window.carbGoal)
    }

    func testNoGoalEncodesAsAnExplicitNull() throws {
        let window = DoseWindow(name: "Lunch", start: "11:00", ratioGPerUnit: 8)
        XCTAssertEqual(try encoded(window)["carb_goal"], .null)
    }

    func testGoalEncodesAsMinAndMax() throws {
        let window = DoseWindow(name: "Lunch", start: "11:00", ratioGPerUnit: 8, carbGoal: CarbGoal(min: 50, max: 80))
        XCTAssertEqual(try encoded(window)["carb_goal"], .object(["min": .number(50), "max": .number(80)]))
    }
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd ~/Projects/CarbBook && ios/scripts/swift-test.sh CarbBookCore --filter GoalsTests`
Expected: FAIL — `cannot find 'CarbGoal' in scope`.

- [ ] **Step 4: Add `CarbGoal`**

Create `ios/CarbBookCore/Sources/CarbBookCore/Goals.swift`:

```swift
import Foundation

/// A per-window carb target (spec §2). Both bounds finite, `0 <= min <= max <= DoseLimits.maxCarbsG`.
/// `nil` on a window means "no goal", and is written to the wire as an explicit JSON null.
public struct CarbGoal: Codable, Equatable, Sendable {
    public var min: Double
    public var max: Double

    public init(min: Double, max: Double) {
        self.min = min
        self.max = max
    }

    public var isValid: Bool {
        min.isFinite && max.isFinite && min >= 0 && min <= max && max <= DoseLimits.maxCarbsG
    }
}
```

- [ ] **Step 5: Put the goal on `DoseWindow`**

In `ios/CarbBookCore/Sources/CarbBookCore/Types.swift`, replace the whole `DoseWindow` struct with:

```swift
public struct DoseWindow: Codable, Equatable, Sendable {
    public var name: String
    /// "HH:MM", 24-hour local time
    public var start: String
    public var ratioGPerUnit: Double
    /// Per-window carb target, or nil for no goal. Dose math ignores it (spec §2).
    public var carbGoal: CarbGoal?

    public init(name: String, start: String, ratioGPerUnit: Double, carbGoal: CarbGoal? = nil) {
        self.name = name; self.start = start; self.ratioGPerUnit = ratioGPerUnit; self.carbGoal = carbGoal
    }

    enum CodingKeys: String, CodingKey {
        case name, start
        case ratioGPerUnit = "ratio_g_per_unit"
        case carbGoal = "carb_goal"
    }

    /// Explicit, so "no goal" is sent as JSON `null` rather than omitted: a missing key means "keep
    /// the stored value" on the server, so only an explicit null clears a goal.
    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(name, forKey: .name)
        try container.encode(start, forKey: .start)
        try container.encode(ratioGPerUnit, forKey: .ratioGPerUnit)
        try container.encode(carbGoal, forKey: .carbGoal)
    }
}
```

- [ ] **Step 6: Run the tests**

Run: `cd ~/Projects/CarbBook && ios/scripts/swift-test.sh CarbBookCore --filter GoalsTests`
Expected: PASS — 4 tests, 0 failures.

- [ ] **Step 7: Run the whole core suite (the new field must not break existing vectors)**

Run: `cd ~/Projects/CarbBook && ios/scripts/swift-test.sh CarbBookCore`
Expected: PASS — 0 failures.

- [ ] **Step 8: Commit**

```bash
cd ~/Projects/CarbBook
git add ios/CarbBookCore/Sources/CarbBookCore/Goals.swift ios/CarbBookCore/Sources/CarbBookCore/Types.swift \
  ios/CarbBookCore/Tests/CarbBookCoreTests/GoalsTests.swift
git commit -m "feat(ios-core): carb_goal on dose windows"
```

---

## Task 2: `goalStatus`, `dayGoal` and the display text

**Files:**
- Modify: `ios/CarbBookCore/Sources/CarbBookCore/Goals.swift`
- Test: `ios/CarbBookCore/Tests/CarbBookCoreTests/GoalsTests.swift`

- [ ] **Step 1: Write the failing tests**

Append to `GoalsTests.swift`, inside the class:

```swift
    private let goal = CarbGoal(min: 50, max: 80)

    private func status(_ carbs: Double, complete: Bool = true, _ goal: CarbGoal?) -> GoalStatus {
        goalStatus(CarbResult(carbsG: carbs, complete: complete), goal)
    }

    func testInsideTheGoalIncludingBothEnds() {
        XCTAssertEqual(status(50, goal), .inGoal)
        XCTAssertEqual(status(65, goal), .inGoal)
        XCTAssertEqual(status(80, goal), .inGoal)
    }

    func testNearIsWithinFiveGramsOfEitherEnd() {
        XCTAssertEqual(status(45, goal), .near)
        XCTAssertEqual(status(85, goal), .near)
        XCTAssertEqual(status(44.9, goal), .off)
        XCTAssertEqual(status(85.1, goal), .off)
    }

    func testOffIsWithinTenGramsAndOutIsBeyond() {
        XCTAssertEqual(status(40, goal), .off)
        XCTAssertEqual(status(90, goal), .off)
        XCTAssertEqual(status(39.9, goal), .out)
        XCTAssertEqual(status(90.1, goal), .out)
    }

    func testNoGoalAndIncompleteCarbsHaveNoStatus() {
        XCTAssertEqual(status(65, nil), .none)
        XCTAssertEqual(status(65, complete: false, goal), .none)
        XCTAssertEqual(status(.nan, goal), .none)
    }

    func testDayGoalSumsOnlyWindowsThatHaveOne() {
        let windows = [
            DoseWindow(name: "Breakfast", start: "05:00", ratioGPerUnit: 8, carbGoal: CarbGoal(min: 30, max: 50)),
            DoseWindow(name: "AM Snack", start: "09:00", ratioGPerUnit: 10),
            DoseWindow(name: "Lunch", start: "11:00", ratioGPerUnit: 8, carbGoal: CarbGoal(min: 50, max: 80)),
        ]
        XCTAssertEqual(dayGoal(windows), CarbGoal(min: 80, max: 130))
    }

    func testDayGoalIsNilWhenNoWindowHasAGoal() {
        XCTAssertNil(dayGoal([DoseWindow(name: "Lunch", start: "11:00", ratioGPerUnit: 8)]))
        XCTAssertNil(dayGoal([]))
    }

    func testGoalTextShowsTheNumbersNotJustAColour() {
        XCTAssertEqual(goalText(CarbResult(carbsG: 68, complete: true), goal), "68 g · goal 50–80")
        XCTAssertEqual(goalText(CarbResult(carbsG: 68, complete: true), nil), "68 g")
        XCTAssertEqual(goalText(CarbResult(carbsG: 0, complete: false), goal), "missing data · goal 50–80")
    }

    func testEveryStatusHasAShortScreenReaderLabel() {
        XCTAssertEqual(GoalStatus.inGoal.label, "in goal")
        XCTAssertEqual(GoalStatus.near.label, "near goal")
        XCTAssertEqual(GoalStatus.off.label, "off goal")
        XCTAssertEqual(GoalStatus.out.label, "outside goal")
        XCTAssertEqual(GoalStatus.none.label, "no goal")
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/Projects/CarbBook && ios/scripts/swift-test.sh CarbBookCore --filter GoalsTests`
Expected: FAIL — `cannot find 'goalStatus' in scope`.

- [ ] **Step 3: Implement**

Append to `ios/CarbBookCore/Sources/CarbBookCore/Goals.swift`:

```swift
/// Colour feedback for carbs against a goal (spec §3). Raw values match the TS core and the
/// shared vectors; `inGoal` is spelled out because `in` is a Swift keyword.
public enum GoalStatus: String, Codable, Equatable, Sendable {
    case none
    case inGoal = "in"
    case near
    case off
    case out

    /// Short screen-reader label; the visible text always carries the numbers as well. Same
    /// wording as the TS core's `GOAL_STATUS_LABELS`, so both apps read the same aloud.
    public var label: String {
        switch self {
        case .none: "no goal"
        case .inGoal: "in goal"
        case .near: "near goal"
        case .off: "off goal"
        case .out: "outside goal"
        }
    }
}

/// `d` is the distance outside the goal band; 0 inside it. d == 0 → in, d <= 5 → near,
/// d <= 10 → off, else out. No goal, incomplete carbs or a non-finite total → none.
public func goalStatus(_ carbs: CarbResult, _ goal: CarbGoal?) -> GoalStatus {
    guard let goal, goal.isValid, carbs.complete, carbs.carbsG.isFinite else { return .none }
    let value = carbs.carbsG
    if value >= goal.min && value <= goal.max { return .inGoal }
    let d = Swift.min(abs(value - goal.min), abs(value - goal.max))
    if d <= 5 { return .near }
    if d <= 10 { return .off }
    return .out
}

/// A day's goal: the sum of that day's window goals. Windows without a goal contribute nothing to
/// either side; nil when no window in the day has a goal (spec §3).
public func dayGoal(_ windows: [DoseWindow]) -> CarbGoal? {
    let goals = windows.compactMap(\.carbGoal).filter(\.isValid)
    guard !goals.isEmpty else { return nil }
    return CarbGoal(min: goals.reduce(0) { $0 + $1.min }, max: goals.reduce(0) { $0 + $1.max })
}

/// "68 g · goal 50–80" — the numbers always show, so colour is never the only signal (spec §3).
public func goalText(_ carbs: CarbResult, _ goal: CarbGoal?) -> String {
    let amount = carbs.complete && carbs.carbsG.isFinite ? "\(formatCarbs(carbs.carbsG)) g" : "missing data"
    guard let goal, goal.isValid else { return amount }
    return "\(amount) · goal \(formatCarbs(goal.min))–\(formatCarbs(goal.max))"
}

/// Locale-independent carb formatting for goal text: at most one decimal, no trailing ".0".
func formatCarbs(_ value: Double) -> String {
    guard value.isFinite else { return "—" }
    var text = String(format: "%.1f", value)
    if text.hasSuffix(".0") { text.removeLast(2) }
    return text
}
```

- [ ] **Step 4: Run the tests**

Run: `cd ~/Projects/CarbBook && ios/scripts/swift-test.sh CarbBookCore --filter GoalsTests`
Expected: PASS — 12 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/CarbBook
git add ios/CarbBookCore/Sources/CarbBookCore/Goals.swift ios/CarbBookCore/Tests/CarbBookCoreTests/GoalsTests.swift
git commit -m "feat(ios-core): goalStatus, dayGoal and goal text"
```

---

## Task 3: Run the shared `goal-vectors.json`

**Files:**
- Modify: `ios/scripts/sync-testdata.sh:28-33`
- Modify: `ios/CarbBookCore/Tests/CarbBookCoreTests/VectorTests.swift`
- Modify: `.github/workflows/ios-tests.yml:26-30`

- [ ] **Step 1: Confirm the shared vectors exist**

Run: `cd ~/Projects/CarbBook && git pull && python3 -c "import json;print(list(json.load(open('testdata/goal-vectors.json')).keys()))"`
Expected: `['tolerance', 'status_cases', 'day_cases', 'day_status_cases', 'valid_cases']`. If the file is missing, stop — the core/server plan has not merged yet. If the keys differ, adapt only the `GoalVectors` struct below, never the vectors.

- [ ] **Step 2: Teach `sync-testdata.sh` about the file**

The core/server plan edits this script too. Check whether it is already done:

Run: `cd ~/Projects/CarbBook && grep -n "goal-vectors" ios/scripts/sync-testdata.sh`
Expected: the core loop reads `for name in units-vectors.json dose-vectors.json goal-vectors.json; do`. If `goal-vectors.json` is missing from that line, add it there (the core loop, not the kit loop).

- [ ] **Step 3: Run the sync script and verify `--check` now covers the new file**

```bash
cd ~/Projects/CarbBook
ios/scripts/sync-testdata.sh
ls ios/CarbBookCore/Tests/CarbBookCoreTests/Resources/
ios/scripts/sync-testdata.sh --check
```
Expected: `Resources/` lists `dose-vectors.json`, `goal-vectors.json`, `units-vectors.json`; `--check` prints `testdata vectors in sync` and exits 0.

- [ ] **Step 4: Write the failing vector test**

In `ios/CarbBookCore/Tests/CarbBookCoreTests/VectorTests.swift`, add this struct after `DoseVectors` and this test after `testDoseVectors`:

```swift
    struct GoalVectors: Decodable {
        struct StatusCase: Decodable {
            let name: String
            let carbs: Double
            let complete: Bool?
            let goal: CarbGoal?
            let expect: GoalStatus
        }
        struct DayCase: Decodable {
            let name: String
            let windows: [DoseWindow]
            let expect: CarbGoal?
        }
        struct DayStatusCase: Decodable {
            let name: String
            let carbs: Double
            let complete: Bool?
            let day_goal: CarbGoal?
            let expect: GoalStatus
        }
        struct ValidCase: Decodable {
            let name: String
            let goal: CarbGoal?
            let expect: Bool
        }
        let tolerance: Double
        let status_cases: [StatusCase]
        let day_cases: [DayCase]
        let day_status_cases: [DayStatusCase]
        let valid_cases: [ValidCase]
    }

    func testGoalVectors() throws {
        let g = try load("goal-vectors", as: GoalVectors.self)
        XCTAssertFalse(g.status_cases.isEmpty)
        XCTAssertFalse(g.day_cases.isEmpty)
        XCTAssertFalse(g.day_status_cases.isEmpty)
        XCTAssertFalse(g.valid_cases.isEmpty)
        for c in g.status_cases {
            let result = goalStatus(CarbResult(carbsG: c.carbs, complete: c.complete ?? true), c.goal)
            XCTAssertEqual(result, c.expect, "goal status: \(c.name)")
        }
        for c in g.day_cases {
            let result = dayGoal(c.windows)
            guard let expected = c.expect else {
                XCTAssertNil(result, "day goal: \(c.name)")
                continue
            }
            let actual = try XCTUnwrap(result, "day goal: \(c.name)")
            XCTAssertEqual(actual.min, expected.min, accuracy: g.tolerance, "day goal min: \(c.name)")
            XCTAssertEqual(actual.max, expected.max, accuracy: g.tolerance, "day goal max: \(c.name)")
        }
        for c in g.day_status_cases {
            let result = goalStatus(CarbResult(carbsG: c.carbs, complete: c.complete ?? true), c.day_goal)
            XCTAssertEqual(result, c.expect, "day status: \(c.name)")
        }
        for c in g.valid_cases {
            XCTAssertEqual(c.goal?.isValid ?? false, c.expect, "goal validity: \(c.name)")
        }
    }
```

`day_cases` are compared field by field with the file's `tolerance` rather than with `==`, because a summed goal is floating-point arithmetic.

- [ ] **Step 5: Run it**

Run: `cd ~/Projects/CarbBook && ios/scripts/swift-test.sh CarbBookCore --filter VectorTests`
Expected: PASS — 3 tests (`testUnitsVectors`, `testDoseVectors`, `testGoalVectors`), 0 failures. A failure here is a real mismatch between this Swift mirror and the TS core: fix `goalStatus`/`dayGoal`, never the vectors.

- [ ] **Step 6: Keep CI honest**

`.github/workflows/ios-tests.yml` already runs `ios/scripts/sync-testdata.sh --check` in the `testdata-copies` job and already triggers on `testdata/**`, so the new file is covered by Step 2 alone. Confirm nothing else is needed:

Run: `cd ~/Projects/CarbBook && grep -n "testdata" .github/workflows/ios-tests.yml`
Expected: the `push`/`pull_request` path filters both list `testdata/**`, and `testdata-copies` runs `ios/scripts/sync-testdata.sh --check`.

- [ ] **Step 7: Commit**

```bash
cd ~/Projects/CarbBook
git add ios/scripts/sync-testdata.sh ios/CarbBookCore/Tests/CarbBookCoreTests/VectorTests.swift \
  ios/CarbBookCore/Tests/CarbBookCoreTests/Resources/goal-vectors.json
git commit -m "test(ios-core): run the shared goal vectors"
```

---

## Task 4: Goal bounds in `validateDoseSettings`

**Files:**
- Modify: `ios/CarbBookCore/Sources/CarbBookCore/DoseSettingsDraft.swift:12-19`
- Test: `ios/CarbBookCore/Tests/CarbBookCoreTests/DoseSettingsDraftTests.swift`

- [ ] **Step 1: Write the failing test**

Append to `ios/CarbBookCore/Tests/CarbBookCoreTests/DoseSettingsDraftTests.swift`, inside the class:

```swift
    private func settingsWithGoal(_ goal: CarbGoal?) -> DoseSettingsData {
        DoseSettingsData(
            id: "s1", effectiveFrom: 0,
            windows: [DoseWindow(name: "Lunch", start: "11:00", ratioGPerUnit: 8, carbGoal: goal)],
            correction: CorrectionRule(threshold: 200, step: 50, unitsPerStep: 1, mode: "started"),
            rounding: RoundingRule(increment: 1, roundDownBelowBg: nil))
    }

    func testAValidCarbGoalIsAccepted() {
        XCTAssertNil(validateDoseSettings(settingsWithGoal(CarbGoal(min: 50, max: 80))))
        XCTAssertNil(validateDoseSettings(settingsWithGoal(nil)))
        XCTAssertNil(validateDoseSettings(settingsWithGoal(CarbGoal(min: 0, max: 0))))
    }

    func testCarbGoalBoundsAreChecked() {
        XCTAssertEqual(validateDoseSettings(settingsWithGoal(CarbGoal(min: 80, max: 50))),
                       "window \"Lunch\" needs carb_goal 0 <= min <= max <= 2000")
        XCTAssertEqual(validateDoseSettings(settingsWithGoal(CarbGoal(min: -1, max: 50))),
                       "window \"Lunch\" needs carb_goal 0 <= min <= max <= 2000")
        XCTAssertEqual(validateDoseSettings(settingsWithGoal(CarbGoal(min: 0, max: 2001))),
                       "window \"Lunch\" needs carb_goal 0 <= min <= max <= 2000")
        XCTAssertEqual(validateDoseSettings(settingsWithGoal(CarbGoal(min: .nan, max: 50))),
                       "window \"Lunch\" needs carb_goal 0 <= min <= max <= 2000")
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/Projects/CarbBook && ios/scripts/swift-test.sh CarbBookCore --filter DoseSettingsDraftTests`
Expected: FAIL — `testCarbGoalBoundsAreChecked` gets `nil` instead of the message.

- [ ] **Step 3: Implement**

In `ios/CarbBookCore/Sources/CarbBookCore/DoseSettingsDraft.swift`, inside the `for window in s.windows` loop, after the `ratio_g_per_unit` check, add:

```swift
        if let goal = window.carbGoal, !goal.isValid {
            return "window \"\(window.name)\" needs carb_goal 0 <= min <= max <= \(Int(DoseLimits.maxCarbsG))"
        }
```

- [ ] **Step 4: Run the tests**

Run: `cd ~/Projects/CarbBook && ios/scripts/swift-test.sh CarbBookCore`
Expected: PASS — 0 failures.

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/CarbBook
git add ios/CarbBookCore/Sources/CarbBookCore/DoseSettingsDraft.swift \
  ios/CarbBookCore/Tests/CarbBookCoreTests/DoseSettingsDraftTests.swift
git commit -m "feat(ios-core): validate carb goal bounds"
```

---

## Task 5: `PlanEntryData` and `PlanItemData`

**Files:**
- Create: `ios/CarbBookCore/Sources/CarbBookCore/Plan.swift`
- Test: `ios/CarbBookCore/Tests/CarbBookCoreTests/PlanTypesTests.swift`

- [ ] **Step 1: Write the failing test**

Create `ios/CarbBookCore/Tests/CarbBookCoreTests/PlanTypesTests.swift`:

```swift
import Foundation
import XCTest
@testable import CarbBookCore

final class PlanTypesTests: XCTestCase {
    private func fields<T: Encodable>(_ value: T) throws -> [String: JSONValue] {
        guard case .object(let fields) = try JSONValue.from(value) else { return [:] }
        return fields
    }

    func testPlanEntryEncodesWireColumnNames() throws {
        let entry = PlanEntryData(id: "p1", date: "2026-09-16", windowName: "Lunch", status: .planned,
                                  note: "leftovers", logEntryId: nil)
        let record = try fields(entry)
        XCTAssertEqual(record["date"], .string("2026-09-16"))
        XCTAssertEqual(record["window_name"], .string("Lunch"))
        XCTAssertEqual(record["status"], .string("planned"))
        XCTAssertEqual(record["note"], .string("leftovers"))
    }

    func testPlanEntryNullablesAreExplicitNulls() throws {
        let entry = PlanEntryData(id: "p1", date: "2026-09-16", windowName: "Lunch", status: .planned,
                                  note: nil, logEntryId: nil)
        let record = try fields(entry)
        XCTAssertEqual(record["note"], .null)
        XCTAssertEqual(record["log_entry_id"], .null)
    }

    func testPlanEntryDecodesFromAWireRecord() throws {
        let json = #"{"id":"p1","date":"2026-09-16","window_name":"Lunch","status":"logged","note":null,"log_entry_id":"l9"}"#
        let entry = try JSONDecoder().decode(PlanEntryData.self, from: Data(json.utf8))
        XCTAssertEqual(entry.status, .logged)
        XCTAssertEqual(entry.logEntryId, "l9")
        XCTAssertNil(entry.note)
    }

    func testPlanItemEncodesLikeALogItemWithoutSnapshots() throws {
        let item = PlanItemData(id: "i1", planEntryId: "p1", refType: .food, refId: "f1", amount: 0.5,
                                unit: "cup", position: 2)
        let record = try fields(item)
        XCTAssertEqual(record["plan_entry_id"], .string("p1"))
        XCTAssertEqual(record["ref_type"], .string("food"))
        XCTAssertEqual(record["amount"], .number(0.5))
        XCTAssertEqual(record["position"], .number(2))
        XCTAssertNil(record["display_name"])
        XCTAssertNil(record["carbs_g"])
    }

    func testPlanStatusRawValues() {
        XCTAssertEqual(PlanStatus.planned.rawValue, "planned")
        XCTAssertEqual(PlanStatus.logged.rawValue, "logged")
        XCTAssertEqual(PlanStatus.skipped.rawValue, "skipped")
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/Projects/CarbBook && ios/scripts/swift-test.sh CarbBookCore --filter PlanTypesTests`
Expected: FAIL — `cannot find 'PlanEntryData' in scope`.

- [ ] **Step 3: Implement**

Create `ios/CarbBookCore/Sources/CarbBookCore/Plan.swift`:

```swift
import Foundation

/// Meal-plan slot status (spec §2).
public enum PlanStatus: String, Codable, Equatable, Sendable {
    case planned, logged, skipped
}

/// One planned slot: at most one non-deleted row per (date, window_name); a second is rejected
/// by the server as `duplicate_slot`.
public struct PlanEntryData: Codable, Equatable, Sendable {
    public var id: Id
    /// "YYYY-MM-DD", local date.
    public var date: String
    /// Matches a dose-settings window name.
    public var windowName: String
    public var status: PlanStatus
    public var note: String?
    /// Set when this slot was logged from the Calculator.
    public var logEntryId: Id?
    public var deleted: Int?

    public init(id: Id, date: String, windowName: String, status: PlanStatus, note: String? = nil,
                logEntryId: Id? = nil, deleted: Int? = nil) {
        self.id = id; self.date = date; self.windowName = windowName; self.status = status
        self.note = note; self.logEntryId = logEntryId; self.deleted = deleted
    }

    enum CodingKeys: String, CodingKey {
        case id, date, status, note, deleted
        case windowName = "window_name"
        case logEntryId = "log_entry_id"
    }

    /// Explicit, so clearing a note or a log link is sent as JSON `null` rather than omitted (the
    /// server reads a missing key as "keep the stored value").
    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(date, forKey: .date)
        try container.encode(windowName, forKey: .windowName)
        try container.encode(status, forKey: .status)
        try container.encode(note, forKey: .note)
        try container.encode(logEntryId, forKey: .logEntryId)
        try container.encodeIfPresent(deleted, forKey: .deleted)
    }
}

/// One row inside a planned slot: the same shape as `log_item` minus the snapshot fields
/// (`display_name`, `carbs_g`). Plans never snapshot; carbs are computed live with `itemCarbs`.
public struct PlanItemData: Codable, Equatable, Sendable {
    public var id: Id
    public var planEntryId: Id
    public var refType: RefType
    public var refId: Id
    public var amount: Double
    public var unit: String
    public var position: Int
    public var deleted: Int?

    public init(id: Id, planEntryId: Id, refType: RefType, refId: Id, amount: Double, unit: String,
                position: Int, deleted: Int? = nil) {
        self.id = id; self.planEntryId = planEntryId; self.refType = refType; self.refId = refId
        self.amount = amount; self.unit = unit; self.position = position; self.deleted = deleted
    }

    enum CodingKeys: String, CodingKey {
        case id, amount, unit, position, deleted
        case planEntryId = "plan_entry_id"
        case refType = "ref_type"
        case refId = "ref_id"
    }
}
```

- [ ] **Step 4: Run the tests**

Run: `cd ~/Projects/CarbBook && ios/scripts/swift-test.sh CarbBookCore --filter PlanTypesTests`
Expected: PASS — 5 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/CarbBook
git add ios/CarbBookCore/Sources/CarbBookCore/Plan.swift ios/CarbBookCore/Tests/CarbBookCoreTests/PlanTypesTests.swift
git commit -m "feat(ios-core): plan_entry and plan_item types"
```

---

## Task 6: GRDB migration `v3-meal-plan` and the table codec

**Files:**
- Modify: `ios/CarbBookKit/Sources/CarbBookKit/Schema.swift:8-17`
- Modify: `ios/CarbBookKit/Sources/CarbBookKit/TableCodec.swift:7-18`
- Test: `ios/CarbBookKit/Tests/CarbBookKitTests/PlanStoreTests.swift`

- [ ] **Step 1: Write the failing test**

Create `ios/CarbBookKit/Tests/CarbBookKitTests/PlanStoreTests.swift`:

```swift
import CarbBookCore
@testable import CarbBookKit
import Foundation
import GRDB
import XCTest

final class PlanStoreTests: XCTestCase {
    func testMigrationCreatesBothPlanTables() throws {
        let store = try LocalStore(path: nil, now: { 1_000 })
        try store.dbQueue.read { db in
            XCTAssertTrue(try db.tableExists("plan_entry"))
            XCTAssertTrue(try db.tableExists("plan_item"))
        }
    }

    func testPlanEntryRoundTripsThroughTheStore() throws {
        let store = try LocalStore(path: nil, now: { 1_000 })
        let entry = PlanEntryData(id: "p1", date: "2026-09-16", windowName: "Lunch", status: .planned,
                                  note: nil, logEntryId: nil)
        let saved = try store.save("plan_entry", entry)
        XCTAssertEqual(saved.record["note"], .null)
        XCTAssertEqual(saved.record["log_entry_id"], .null)
        XCTAssertEqual(saved.record["status"], .string("planned"))
        let rows: [PlanEntryData] = try store.records("plan_entry")
        XCTAssertEqual(rows, [PlanEntryData(id: "p1", date: "2026-09-16", windowName: "Lunch", status: .planned,
                                            note: nil, logEntryId: nil, deleted: 0)])
    }

    func testPlanItemRoundTripsWithAnIntegerPosition() throws {
        let store = try LocalStore(path: nil, now: { 1_000 })
        try store.save("plan_item", PlanItemData(id: "i1", planEntryId: "p1", refType: .food, refId: "f1",
                                                 amount: 0.5, unit: "cup", position: 3))
        let rows: [PlanItemData] = try store.records("plan_item")
        XCTAssertEqual(rows.first?.position, 3)
        XCTAssertEqual(rows.first?.amount, 0.5)
        XCTAssertEqual(rows.first?.refType, .food)
    }

    func testAPlanItemWhoseParentIsMissingIsStillStored() throws {
        // No foreign keys between synced tables: a child may sync before its parent.
        let store = try LocalStore(path: nil, now: { 1_000 })
        try store.save("plan_item", PlanItemData(id: "i1", planEntryId: "nope", refType: .meal, refId: "m1",
                                                 amount: 1, unit: Units.serving, position: 0))
        XCTAssertEqual((try store.records("plan_item") as [PlanItemData]).count, 1)
    }

    func testExistingDatabasesMigrateWithoutLosingRows() throws {
        let directory = try temporaryDirectory()
        let path = directory.appendingPathComponent("carbbook.sqlite").path
        let queue = try DatabaseQueue(path: path)
        var oldMigrator = DatabaseMigrator()
        oldMigrator.registerMigration("v1") { db in try db.execute(sql: Schema.v1) }
        oldMigrator.registerMigration("v2-any-unit-foods") { db in try db.execute(sql: Schema.v2AnyUnitFoods) }
        try oldMigrator.migrate(queue)
        try queue.write { db in
            try db.execute(sql: """
            INSERT INTO food (id, name, source, carbs_per_100g, updated_at, updated_by, deleted)
            VALUES ('f1', 'Rice', 'custom', 28.2, 1, 'dev', 0)
            """)
        }
        // Closing the queue before reopening the same file through LocalStore.
        try queue.close()
        let store = try LocalStore(path: path, now: { 2_000 })
        XCTAssertEqual(try store.catalog().food("f1")?.name, "Rice")
        try store.dbQueue.read { db in XCTAssertTrue(try db.tableExists("plan_entry")) }
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/Projects/CarbBook && ios/scripts/swift-test.sh CarbBookKit --filter PlanStoreTests`
Expected: FAIL — `testMigrationCreatesBothPlanTables` fails on `plan_entry` not existing, and the round-trip tests throw `CodecError.unknownTable("plan_entry")`.

- [ ] **Step 3: Add the migration**

In `ios/CarbBookKit/Sources/CarbBookKit/Schema.swift`, register a third migration inside `migrator` (after the `v2-any-unit-foods` registration, before `return migrator`):

```swift
        migrator.registerMigration("v3-meal-plan") { db in
            try db.execute(sql: v3MealPlan)
        }
```

and add the SQL as a new static property after `v2AnyUnitFoods`:

```swift
    /// Meal planning (spec §2). Mirrors server migration 004 minus the CHECKs the server enforces:
    /// the local database stores whatever the server sends, and a row the server would reject comes
    /// back as a `sync_rejection` instead of failing an INSERT here. No foreign keys, like every other
    /// synced table, and every reference column is nullable-safe (`note`, `log_entry_id`).
    /// No pull-cursor reset: these tables are new, so their rows arrive on the next ordinary pull.
    static let v3MealPlan = """
    CREATE TABLE plan_entry (
      id TEXT PRIMARY KEY, date TEXT NOT NULL, window_name TEXT NOT NULL, status TEXT NOT NULL,
      note TEXT, log_entry_id TEXT,
      updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, server_seq INTEGER
    );
    CREATE INDEX plan_entry_date ON plan_entry (date);
    CREATE INDEX plan_entry_log_entry ON plan_entry (log_entry_id);
    CREATE TABLE plan_item (
      id TEXT PRIMARY KEY, plan_entry_id TEXT NOT NULL, ref_type TEXT NOT NULL, ref_id TEXT NOT NULL,
      amount REAL NOT NULL, unit TEXT NOT NULL, position INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, server_seq INTEGER
    );
    CREATE INDEX plan_item_entry ON plan_item (plan_entry_id);
    CREATE INDEX plan_item_ref ON plan_item (ref_id);
    """
```

- [ ] **Step 4: Teach `TableCodec` the two tables**

In `ios/CarbBookKit/Sources/CarbBookKit/TableCodec.swift`, add two entries at the end of `dataColumns` (after `"dose_settings"`):

```swift
        "plan_entry": ["date", "window_name", "status", "note", "log_entry_id"],
        "plan_item": ["plan_entry_id", "ref_type", "ref_id", "amount", "unit", "position"],
```

`position` is already in `integerColumns`, and neither table has a JSON column, so nothing else changes.

- [ ] **Step 5: Run the tests**

Run: `cd ~/Projects/CarbBook && ios/scripts/swift-test.sh CarbBookKit --filter PlanStoreTests`
Expected: PASS — 5 tests, 0 failures.

- [ ] **Step 6: Run the whole kit suite**

Run: `cd ~/Projects/CarbBook && ios/scripts/swift-test.sh CarbBookKit`
Expected: PASS — 0 failures.

- [ ] **Step 7: Commit**

```bash
cd ~/Projects/CarbBook
git add ios/CarbBookKit/Sources/CarbBookKit/Schema.swift ios/CarbBookKit/Sources/CarbBookKit/TableCodec.swift \
  ios/CarbBookKit/Tests/CarbBookKitTests/PlanStoreTests.swift
git commit -m "feat(ios-kit): plan_entry and plan_item tables"
```

---

## Task 7: Plan rows survive a full sync round trip

**Files:**
- Test: `ios/CarbBookKit/Tests/CarbBookKitTests/PlanStoreTests.swift`

No production code is expected in this task: push and pull are generic. The test proves the new columns — including the explicit nulls — survive a push, a rejection restore and a pull. If it fails, the fix belongs in `TableCodec`, not in the sync engine.

- [ ] **Step 1: Write the failing test**

Append to `PlanStoreTests.swift`, inside the class:

```swift
    func testPlanRowsPushAndPullThroughTheServer() async throws {
        let server = FakeServer()
        let deviceA = try LocalStore(path: nil, now: { 1_000 })
        let deviceB = try LocalStore(path: nil, now: { 1_000 })
        try deviceA.save("plan_entry", PlanEntryData(id: "p1", date: "2026-09-16", windowName: "Lunch",
                                                     status: .planned, note: "leftovers", logEntryId: nil))
        try deviceA.save("plan_item", PlanItemData(id: "i1", planEntryId: "p1", refType: .food, refId: "f1",
                                                   amount: 2, unit: "p:x", position: 0))
        _ = try await SyncEngine(store: deviceA, transport: server).sync()
        _ = try await SyncEngine(store: deviceB, transport: server).sync()

        let entries: [PlanEntryData] = try deviceB.records("plan_entry")
        XCTAssertEqual(entries.count, 1)
        XCTAssertEqual(entries.first?.note, "leftovers")
        XCTAssertNil(entries.first?.logEntryId)
        let items: [PlanItemData] = try deviceB.records("plan_item")
        XCTAssertEqual(items.first?.unit, "p:x")
        XCTAssertEqual(items.first?.position, 0)
    }

    func testClearingANoteIsPushedAsAnExplicitNull() async throws {
        let server = FakeServer()
        let clock = TestClock(1_000)
        let store = try LocalStore(path: nil, now: clock.now)
        try store.save("plan_entry", PlanEntryData(id: "p1", date: "2026-09-16", windowName: "Lunch",
                                                   status: .planned, note: "leftovers", logEntryId: nil))
        _ = try await SyncEngine(store: store, transport: server).sync()
        clock.ms = 2_000
        try store.save("plan_entry", PlanEntryData(id: "p1", date: "2026-09-16", windowName: "Lunch",
                                                   status: .skipped, note: nil, logEntryId: nil))
        let pending = try await store.pendingChanges(limit: 10)
        XCTAssertEqual(pending.count, 1)
        XCTAssertEqual(pending[0].record["note"], .null)
        XCTAssertEqual(pending[0].record["status"], .string("skipped"))
    }
```

- [ ] **Step 2: Run the tests**

Run: `cd ~/Projects/CarbBook && ios/scripts/swift-test.sh CarbBookKit --filter PlanStoreTests`
Expected: PASS — 7 tests, 0 failures. If `testPlanRowsPushAndPullThroughTheServer` fails with `unknownTable`, a `dataColumns` entry from Task 6 Step 4 is missing or misspelled.

- [ ] **Step 3: Commit**

```bash
cd ~/Projects/CarbBook
git add ios/CarbBookKit/Tests/CarbBookKitTests/PlanStoreTests.swift
git commit -m "test(ios-kit): plan rows round-trip through sync"
```

---

## Task 8: `PlanDate` — local dates and weeks

**Files:**
- Create: `ios/CarbBookKit/Sources/CarbBookKit/PlanDate.swift`
- Test: `ios/CarbBookKit/Tests/CarbBookKitTests/PlanDateTests.swift`

- [ ] **Step 1: Write the failing test**

Create `ios/CarbBookKit/Tests/CarbBookKitTests/PlanDateTests.swift`:

```swift
@testable import CarbBookKit
import Foundation
import XCTest

final class PlanDateTests: XCTestCase {
    /// A fixed calendar so the tests do not depend on the machine's locale or time zone.
    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/Chicago")!
        calendar.firstWeekday = 1 // Sunday, matching the web Plan grid
        return calendar
    }

    private func date(_ text: String) -> Date {
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.timeZone = calendar.timeZone
        formatter.dateFormat = "yyyy-MM-dd HH:mm"
        return formatter.date(from: text)!
    }

    func testStringUsesTheLocalCalendarDate() {
        XCTAssertEqual(PlanDate.string(date("2026-09-16 23:30"), calendar: calendar), "2026-09-16")
        XCTAssertEqual(PlanDate.string(date("2026-09-17 00:05"), calendar: calendar), "2026-09-17")
    }

    func testDateParsesBackToNoonSoDstNeverShiftsTheDay() {
        let parsed = PlanDate.date("2026-03-08", calendar: calendar)
        XCTAssertNotNil(parsed)
        XCTAssertEqual(PlanDate.string(parsed!, calendar: calendar), "2026-03-08")
        XCTAssertEqual(calendar.component(.hour, from: parsed!), 12)
    }

    func testDateRejectsMalformedText() {
        XCTAssertNil(PlanDate.date("2026-9-8", calendar: calendar))
        XCTAssertNil(PlanDate.date("not a date", calendar: calendar))
        XCTAssertNil(PlanDate.date("", calendar: calendar))
    }

    func testWeekReturnsSevenDatesStartingOnTheCalendarsFirstWeekday() {
        let week = PlanDate.week(containing: "2026-09-16", calendar: calendar)
        XCTAssertEqual(week.count, 7)
        XCTAssertEqual(week.first, "2026-09-13") // Sunday
        XCTAssertEqual(week.last, "2026-09-19")
        XCTAssertTrue(week.contains("2026-09-16"))
    }

    func testShiftMovesByWholeDays() {
        XCTAssertEqual(PlanDate.shift("2026-09-16", byDays: 1, calendar: calendar), "2026-09-17")
        XCTAssertEqual(PlanDate.shift("2026-09-16", byDays: -1, calendar: calendar), "2026-09-15")
        XCTAssertEqual(PlanDate.shift("2026-09-16", byDays: 7, calendar: calendar), "2026-09-23")
        XCTAssertEqual(PlanDate.shift("2026-12-31", byDays: 1, calendar: calendar), "2027-01-01")
    }

    func testSlotKeyMatchesTheWebAppsFormat() {
        XCTAssertEqual(PlanDate.slotKey(date: "2026-09-16", windowName: "Lunch"), "2026-09-16|Lunch")
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/Projects/CarbBook && ios/scripts/swift-test.sh CarbBookKit --filter PlanDateTests`
Expected: FAIL — `cannot find 'PlanDate' in scope`.

- [ ] **Step 3: Implement**

Create `ios/CarbBookKit/Sources/CarbBookKit/PlanDate.swift`:

```swift
import Foundation

/// `plan_entry.date` is a local calendar date, not an instant: "2026-09-16" means that day wherever
/// the user is. Every conversion goes through here so no screen invents its own formatter.
public enum PlanDate {
    /// The local calendar date of an instant, as "YYYY-MM-DD".
    public static func string(_ date: Date, calendar: Calendar = .current) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }

    /// "YYYY-MM-DD" → local noon on that day. Noon, not midnight, so a DST transition can never
    /// push the value onto the previous or next day when it is formatted back.
    public static func date(_ text: String, calendar: Calendar = .current) -> Date? {
        let parts = text.split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count == 3, parts[0].count == 4, parts[1].count == 2, parts[2].count == 2,
              let year = Int(parts[0]), let month = Int(parts[1]), let day = Int(parts[2]),
              (1...12).contains(month), (1...31).contains(day) else { return nil }
        var components = DateComponents()
        components.year = year
        components.month = month
        components.day = day
        components.hour = 12
        guard let made = calendar.date(from: components), string(made, calendar: calendar) == text else { return nil }
        return made
    }

    /// The seven dates of the week containing `text`, starting on the calendar's first weekday.
    /// An unparseable date yields an empty week rather than a crash.
    public static func week(containing text: String, calendar: Calendar = .current) -> [String] {
        guard let day = date(text, calendar: calendar) else { return [] }
        let weekday = calendar.component(.weekday, from: day)
        let offset = (weekday - calendar.firstWeekday + 7) % 7
        guard let start = calendar.date(byAdding: .day, value: -offset, to: day) else { return [] }
        return (0..<7).compactMap { index in
            calendar.date(byAdding: .day, value: index, to: start).map { string($0, calendar: calendar) }
        }
    }

    /// `text` moved by whole days; returns `text` unchanged when it cannot be parsed.
    public static func shift(_ text: String, byDays days: Int, calendar: Calendar = .current) -> String {
        guard let day = date(text, calendar: calendar),
              let moved = calendar.date(byAdding: .day, value: days, to: day) else { return text }
        return string(moved, calendar: calendar)
    }

    /// The per-device dismissal key, same format as the web app's: "<date>|<window>".
    public static func slotKey(date: String, windowName: String) -> String { "\(date)|\(windowName)" }
}
```

- [ ] **Step 4: Run the tests**

Run: `cd ~/Projects/CarbBook && ios/scripts/swift-test.sh CarbBookKit --filter PlanDateTests`
Expected: PASS — 6 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/CarbBook
git add ios/CarbBookKit/Sources/CarbBookKit/PlanDate.swift ios/CarbBookKit/Tests/CarbBookKitTests/PlanDateTests.swift
git commit -m "feat(ios-kit): PlanDate local date and week helpers"
```

---

## Task 9: Plan read queries

**Files:**
- Modify: `ios/CarbBookKit/Sources/CarbBookKit/Queries.swift`
- Test: `ios/CarbBookKit/Tests/CarbBookKitTests/PlanStoreTests.swift`

- [ ] **Step 1: Write the failing test**

Append to `PlanStoreTests.swift`, inside the class:

```swift
    private func seedWeek(_ store: LocalStore) throws {
        try store.save("plan_entry", PlanEntryData(id: "p1", date: "2026-09-14", windowName: "Lunch", status: .planned))
        try store.save("plan_entry", PlanEntryData(id: "p2", date: "2026-09-16", windowName: "Lunch", status: .planned))
        try store.save("plan_entry", PlanEntryData(id: "p3", date: "2026-09-16", windowName: "Dinner", status: .skipped))
        try store.save("plan_entry", PlanEntryData(id: "p4", date: "2026-09-25", windowName: "Lunch", status: .planned))
        try store.save("plan_item", PlanItemData(id: "i2", planEntryId: "p2", refType: .food, refId: "f1",
                                                 amount: 1, unit: "g", position: 1))
        try store.save("plan_item", PlanItemData(id: "i1", planEntryId: "p2", refType: .food, refId: "f2",
                                                 amount: 2, unit: "g", position: 0))
    }

    func testPlanEntriesReadsAnInclusiveDateRange() throws {
        let store = try LocalStore(path: nil, now: { 1_000 })
        try seedWeek(store)
        let entries = try store.planEntries(from: "2026-09-13", to: "2026-09-19")
        XCTAssertEqual(entries.map(\.id), ["p1", "p3", "p2"])
    }

    func testPlanEntriesSkipsDeletedRows() throws {
        let store = try LocalStore(path: nil, now: { 1_000 })
        try seedWeek(store)
        try store.softDelete("plan_entry", id: "p2")
        XCTAssertEqual(try store.planEntries(from: "2026-09-13", to: "2026-09-19").map(\.id), ["p1", "p3"])
    }

    func testPlanItemsAreGroupedByEntryAndOrderedByPosition() throws {
        let store = try LocalStore(path: nil, now: { 1_000 })
        try seedWeek(store)
        let grouped = try store.planItems(entryIds: ["p1", "p2"])
        XCTAssertEqual(grouped["p2"]?.map(\.id), ["i1", "i2"])
        XCTAssertNil(grouped["p1"])
    }

    func testPlanEntryForASlot() throws {
        let store = try LocalStore(path: nil, now: { 1_000 })
        try seedWeek(store)
        XCTAssertEqual(try store.planEntry(date: "2026-09-16", windowName: "Lunch")?.id, "p2")
        XCTAssertNil(try store.planEntry(date: "2026-09-16", windowName: "Breakfast"))
    }

    func testPlanEntriesLinkedToALogEntry() throws {
        let store = try LocalStore(path: nil, now: { 1_000 })
        try store.save("plan_entry", PlanEntryData(id: "p9", date: "2026-09-16", windowName: "Lunch",
                                                   status: .logged, note: nil, logEntryId: "l1"))
        XCTAssertEqual(try store.planEntries(logEntryId: "l1").map(\.id), ["p9"])
        XCTAssertTrue(try store.planEntries(logEntryId: "l2").isEmpty)
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/Projects/CarbBook && ios/scripts/swift-test.sh CarbBookKit --filter PlanStoreTests`
Expected: FAIL — `value of type 'LocalStore' has no member 'planEntries'`.

- [ ] **Step 3: Implement**

Append to the `extension LocalStore` in `ios/CarbBookKit/Sources/CarbBookKit/Queries.swift`, before the closing brace:

```swift
    /// Plan slots with `from <= date <= to` (both "YYYY-MM-DD"), ordered by date then window name.
    /// String comparison is correct for this format and needs no date parsing in SQL.
    public func planEntries(from: String, to: String) throws -> [PlanEntryData] {
        try records("plan_entry", "WHERE deleted = 0 AND date >= ? AND date <= ? ORDER BY date, window_name", [from, to])
    }

    /// The live slot for one (date, window), or nil. The server enforces at most one; if a duplicate
    /// ever reaches this device, the most recently updated one wins here.
    public func planEntry(date: String, windowName: String) throws -> PlanEntryData? {
        try records("plan_entry",
                    "WHERE deleted = 0 AND date = ? AND window_name = ? ORDER BY updated_at DESC, id DESC LIMIT 1",
                    [date, windowName]).first
    }

    /// Live slots pointing at a log entry (usually 0 or 1).
    public func planEntries(logEntryId: Id) throws -> [PlanEntryData] {
        try records("plan_entry", "WHERE deleted = 0 AND log_entry_id = ? ORDER BY date, window_name", [logEntryId])
    }

    /// Items of the given slots, grouped by `plan_entry_id` and ordered by `position`. Slots with no
    /// items have no key in the result.
    public func planItems(entryIds: [Id]) throws -> [Id: [PlanItemData]] {
        guard !entryIds.isEmpty else { return [:] }
        let placeholders = entryIds.map { _ in "?" }.joined(separator: ", ")
        let items: [PlanItemData] = try records(
            "plan_item",
            "WHERE deleted = 0 AND plan_entry_id IN (\(placeholders)) ORDER BY position, rowid",
            StatementArguments(entryIds))
        return Dictionary(grouping: items, by: \.planEntryId)
    }
```

- [ ] **Step 4: Run the tests**

Run: `cd ~/Projects/CarbBook && ios/scripts/swift-test.sh CarbBookKit --filter PlanStoreTests`
Expected: PASS — 12 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/CarbBook
git add ios/CarbBookKit/Sources/CarbBookKit/Queries.swift ios/CarbBookKit/Tests/CarbBookKitTests/PlanStoreTests.swift
git commit -m "feat(ios-kit): plan read queries"
```

---

## Task 10: `PlanEditing` — slot totals and slot save records

**Files:**
- Create: `ios/CarbBookKit/Sources/CarbBookKit/PlanEditing.swift`
- Test: `ios/CarbBookKit/Tests/CarbBookKitTests/PlanEditingTests.swift`

- [ ] **Step 1: Write the failing test**

Create `ios/CarbBookKit/Tests/CarbBookKitTests/PlanEditingTests.swift`:

```swift
import CarbBookCore
@testable import CarbBookKit
import Foundation
import XCTest

final class PlanEditingTests: XCTestCase {
    /// Rice: 28.2 g carbs per 100 g. Bread: no carb data at all, so it is incomplete.
    let catalog = InMemoryCatalog(
        foods: [
            FoodData(id: "rice", name: "Rice", source: "custom", carbsPer100g: 28.2),
            FoodData(id: "bread", name: "Mystery bread", source: "custom", carbsPer100g: nil),
        ],
        portions: [], meals: [], mealItems: [])

    /// Deterministic ids so the expected records can be written out in full.
    func idFactory() -> () -> Id {
        var counter = 0
        return { counter += 1; return "new\(counter)" }
    }

    func testSlotCarbsSumTheItems() {
        let items = [
            PlanItemData(id: "i1", planEntryId: "p1", refType: .food, refId: "rice", amount: 100, unit: "g", position: 0),
            PlanItemData(id: "i2", planEntryId: "p1", refType: .food, refId: "rice", amount: 50, unit: "g", position: 1),
        ]
        let total = PlanEditing.carbs(items, catalog: catalog)
        XCTAssertTrue(total.complete)
        XCTAssertEqual(total.carbsG, 42.3, accuracy: 0.001)
    }

    func testAnItemWithoutCarbDataMakesTheSlotIncomplete() {
        let items = [
            PlanItemData(id: "i1", planEntryId: "p1", refType: .food, refId: "rice", amount: 100, unit: "g", position: 0),
            PlanItemData(id: "i2", planEntryId: "p1", refType: .food, refId: "bread", amount: 50, unit: "g", position: 1),
        ]
        XCTAssertFalse(PlanEditing.carbs(items, catalog: catalog).complete)
    }

    func testAnEmptySlotIsCompleteAndZero() {
        XCTAssertEqual(PlanEditing.carbs([], catalog: catalog), CarbResult(carbsG: 0, complete: true))
    }

    func testSaveChangesCreateAnEntryAndRenumberItsItems() throws {
        let newId = idFactory()
        let draft = PlanEditing.Draft(
            date: "2026-09-16", windowName: "Lunch", note: "  ",
            items: [
                PlanEditing.DraftItem(id: nil, refType: .food, refId: "rice", amount: 0.5, unit: "cup"),
                PlanEditing.DraftItem(id: nil, refType: .meal, refId: "m1", amount: 1, unit: Units.serving),
            ])
        let changes = try PlanEditing.saveChanges(draft: draft, existing: nil, existingItems: [], newId: newId)
        XCTAssertEqual(changes.map(\.table), ["plan_entry", "plan_item", "plan_item"])
        XCTAssertEqual(changes[0].record["status"], .string("planned"))
        XCTAssertEqual(changes[0].record["note"], .null, "blank note is stored as null, not as spaces")
        XCTAssertEqual(changes[1].record["plan_entry_id"], .string("new1"))
        XCTAssertEqual(changes[1].record["position"], .number(0))
        XCTAssertEqual(changes[2].record["position"], .number(1))
    }

    func testSaveChangesKeepStatusAndLinkOfAnExistingSlot() throws {
        let existing = PlanEntryData(id: "p1", date: "2026-09-16", windowName: "Lunch", status: .logged,
                                     note: "old", logEntryId: "l1")
        let draft = PlanEditing.Draft(date: "2026-09-16", windowName: "Lunch", note: "new",
                                      items: [PlanEditing.DraftItem(id: "i1", refType: .food, refId: "rice",
                                                                    amount: 100, unit: "g")])
        let changes = try PlanEditing.saveChanges(draft: draft, existing: existing,
                                                  existingItems: [
                                                      PlanItemData(id: "i1", planEntryId: "p1", refType: .food,
                                                                   refId: "rice", amount: 50, unit: "g", position: 0)],
                                                  newId: idFactory())
        XCTAssertEqual(changes[0].record["id"], .string("p1"))
        XCTAssertEqual(changes[0].record["status"], .string("logged"))
        XCTAssertEqual(changes[0].record["log_entry_id"], .string("l1"))
        XCTAssertEqual(changes[0].record["note"], .string("new"))
        XCTAssertEqual(changes[1].record["id"], .string("i1"), "an edited row keeps its id")
        XCTAssertEqual(changes[1].record["amount"], .number(100))
    }

    func testRemovedItemsAreSoftDeleted() throws {
        let existing = PlanEntryData(id: "p1", date: "2026-09-16", windowName: "Lunch", status: .planned)
        let draft = PlanEditing.Draft(date: "2026-09-16", windowName: "Lunch", note: nil, items: [])
        let changes = try PlanEditing.saveChanges(
            draft: draft, existing: existing,
            existingItems: [PlanItemData(id: "i1", planEntryId: "p1", refType: .food, refId: "rice",
                                         amount: 50, unit: "g", position: 0)],
            newId: idFactory())
        XCTAssertEqual(changes.count, 2)
        XCTAssertEqual(changes[1].record["id"], .string("i1"))
        XCTAssertEqual(changes[1].record["deleted"], .number(1))
    }

    func testAnInvalidAmountRefusesToSave() {
        let draft = PlanEditing.Draft(date: "2026-09-16", windowName: "Lunch", note: nil,
                                      items: [PlanEditing.DraftItem(id: nil, refType: .food, refId: "rice",
                                                                    amount: .nan, unit: "g")])
        XCTAssertThrowsError(try PlanEditing.saveChanges(draft: draft, existing: nil, existingItems: [],
                                                         newId: idFactory())) { error in
            XCTAssertEqual(error as? PlanEditing.EditError, .invalidAmount)
        }
    }

    func testDeleteChangesSoftDeleteTheSlotAndItsItems() {
        let changes = PlanEditing.deleteChanges(
            entry: PlanEntryData(id: "p1", date: "2026-09-16", windowName: "Lunch", status: .planned),
            items: [PlanItemData(id: "i1", planEntryId: "p1", refType: .food, refId: "rice",
                                 amount: 50, unit: "g", position: 0)])
        XCTAssertEqual(changes.map(\.table), ["plan_entry", "plan_item"])
        XCTAssertTrue(changes.allSatisfy { $0.record["deleted"] == .number(1) })
    }

    func testStatusChangeKeepsEverythingElse() {
        let entry = PlanEntryData(id: "p1", date: "2026-09-16", windowName: "Lunch", status: .planned, note: "x")
        let change = PlanEditing.statusChange(entry, to: .skipped)
        XCTAssertEqual(change.record["status"], .string("skipped"))
        XCTAssertEqual(change.record["note"], .string("x"))
        XCTAssertEqual(change.record["log_entry_id"], .null)
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/Projects/CarbBook && ios/scripts/swift-test.sh CarbBookKit --filter PlanEditingTests`
Expected: FAIL — `cannot find 'PlanEditing' in scope`.

- [ ] **Step 3: Implement**

Create `ios/CarbBookKit/Sources/CarbBookKit/PlanEditing.swift`:

```swift
import CarbBookCore
import Foundation

/// Every decision the Plan screen makes about a slot, kept out of SwiftUI so it is unit tested on
/// Linux. Plans never snapshot carbs: totals are computed live with core `itemCarbs`/`sumCarbs`,
/// so an item whose food has not synced yet simply reads as incomplete ("missing data").
public enum PlanEditing {
    public enum EditError: Error, Equatable {
        case invalidAmount

        public var message: String { "\(AmountInput.invalidMessage). Fix it before saving." }
    }

    /// One editable row in the slot editor. `id` is nil for a row the user just added.
    public struct DraftItem: Equatable, Sendable, Identifiable {
        public var id: Id?
        public var refType: RefType
        public var refId: Id
        public var amount: Double
        public var unit: String

        public init(id: Id?, refType: RefType, refId: Id, amount: Double, unit: String) {
            self.id = id; self.refType = refType; self.refId = refId; self.amount = amount; self.unit = unit
        }
    }

    public struct Draft: Equatable, Sendable {
        public var date: String
        public var windowName: String
        public var note: String?
        public var items: [DraftItem]

        public init(date: String, windowName: String, note: String?, items: [DraftItem]) {
            self.date = date; self.windowName = windowName; self.note = note; self.items = items
        }
    }

    /// Live carbs for a slot. An empty slot is complete and zero, so an untouched day reads "0 g"
    /// rather than "missing data".
    public static func carbs(_ items: [PlanItemData], catalog: Catalog) -> CarbResult {
        sumCarbs(items.map { itemCarbs(catalog, $0.refType, $0.refId, $0.amount, $0.unit) })
    }

    /// Records for saving a slot: the entry, every kept item renumbered from 0, and a soft delete for
    /// every previously stored item the draft no longer contains. A new slot starts `planned`; an
    /// existing slot keeps its status and `log_entry_id` (editing a logged slot must not unlink it).
    public static func saveChanges(draft: Draft, existing: PlanEntryData?, existingItems: [PlanItemData],
                                   newId: () -> Id) throws -> [SyncChange] {
        guard draft.items.allSatisfy({ $0.amount.isFinite && $0.amount >= 0 }) else { throw EditError.invalidAmount }
        let trimmedNote = draft.note?.trimmingCharacters(in: .whitespacesAndNewlines)
        let entry = PlanEntryData(
            id: existing?.id ?? newId(),
            date: draft.date,
            windowName: draft.windowName,
            status: existing?.status ?? .planned,
            note: (trimmedNote?.isEmpty ?? true) ? nil : trimmedNote,
            logEntryId: existing?.logEntryId)
        var changes = [try SyncChange.encode("plan_entry", entry)]
        var kept = Set<Id>()
        for (position, item) in draft.items.enumerated() {
            let id = item.id ?? newId()
            if item.id != nil { kept.insert(id) }
            changes.append(try SyncChange.encode("plan_item", PlanItemData(
                id: id, planEntryId: entry.id, refType: item.refType, refId: item.refId,
                amount: item.amount, unit: item.unit, position: position)))
        }
        for removed in existingItems where !kept.contains(removed.id) {
            var record = removed
            record.deleted = 1
            changes.append(try SyncChange.encode("plan_item", record))
        }
        return changes
    }

    /// Soft deletes for a slot and all of its items (the Plan screen's "Clear slot").
    public static func deleteChanges(entry: PlanEntryData, items: [PlanItemData]) -> [SyncChange] {
        var deletedEntry = entry
        deletedEntry.deleted = 1
        var changes = [(try? SyncChange.encode("plan_entry", deletedEntry))].compactMap { $0 }
        for item in items {
            var deletedItem = item
            deletedItem.deleted = 1
            if let change = try? SyncChange.encode("plan_item", deletedItem) { changes.append(change) }
        }
        return changes
    }

    /// Status-only change (Skip on the Calculator, Skip/Plan again on the Plan screen).
    public static func statusChange(_ entry: PlanEntryData, to status: PlanStatus) -> SyncChange {
        var updated = entry
        updated.status = status
        return (try? SyncChange.encode("plan_entry", updated))
            ?? SyncChange(table: "plan_entry", record: ["id": .string(entry.id)])
    }
}
```

- [ ] **Step 4: Run the tests**

Run: `cd ~/Projects/CarbBook && ios/scripts/swift-test.sh CarbBookKit --filter PlanEditingTests`
Expected: PASS — 9 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/CarbBook
git add ios/CarbBookKit/Sources/CarbBookKit/PlanEditing.swift ios/CarbBookKit/Tests/CarbBookKitTests/PlanEditingTests.swift
git commit -m "feat(ios-kit): plan slot totals and save records"
```

---

## Task 11: Copy day and copy week with replace / merge / skip

**Files:**
- Modify: `ios/CarbBookKit/Sources/CarbBookKit/PlanEditing.swift`
- Test: `ios/CarbBookKit/Tests/CarbBookKitTests/PlanEditingTests.swift`

- [ ] **Step 1: Write the failing test**

Append to `PlanEditingTests.swift`, inside the class:

```swift
    private func item(_ id: String, _ entry: String, _ refId: String, _ position: Int) -> PlanItemData {
        PlanItemData(id: id, planEntryId: entry, refType: .food, refId: refId, amount: 1, unit: "g", position: position)
    }

    /// Source: Lunch on the 16th with one item. Target: Lunch on the 17th already has an item.
    private func copyFixture() -> (source: [PlanEntryData], target: [PlanEntryData], items: [Id: [PlanItemData]]) {
        let source = [PlanEntryData(id: "s1", date: "2026-09-16", windowName: "Lunch", status: .logged,
                                    note: "src", logEntryId: "l1")]
        let target = [PlanEntryData(id: "t1", date: "2026-09-17", windowName: "Lunch", status: .planned)]
        let items: [Id: [PlanItemData]] = ["s1": [item("si1", "s1", "rice", 0)], "t1": [item("ti1", "t1", "bread", 0)]]
        return (source, target, items)
    }

    func testCopySkipLeavesAnOccupiedSlotAlone() throws {
        let f = copyFixture()
        let changes = try PlanEditing.copyChanges(
            sourceEntries: f.source, targetEntries: f.target, itemsByEntry: f.items,
            dayOffsets: ["2026-09-16": "2026-09-17"], mode: .skip, newId: idFactory())
        XCTAssertTrue(changes.isEmpty)
    }

    func testCopyMergeAppendsItemsAfterTheExistingOnes() throws {
        let f = copyFixture()
        let changes = try PlanEditing.copyChanges(
            sourceEntries: f.source, targetEntries: f.target, itemsByEntry: f.items,
            dayOffsets: ["2026-09-16": "2026-09-17"], mode: .merge, newId: idFactory())
        XCTAssertEqual(changes.map(\.table), ["plan_item"])
        XCTAssertEqual(changes[0].record["plan_entry_id"], .string("t1"))
        XCTAssertEqual(changes[0].record["ref_id"], .string("rice"))
        XCTAssertEqual(changes[0].record["position"], .number(1), "appended after the existing item")
        XCTAssertEqual(changes[0].record["id"], .string("new1"), "a copied item is always a new row")
    }

    func testCopyReplaceDeletesTheTargetItemsAndCopiesTheSourceOnes() throws {
        let f = copyFixture()
        let changes = try PlanEditing.copyChanges(
            sourceEntries: f.source, targetEntries: f.target, itemsByEntry: f.items,
            dayOffsets: ["2026-09-16": "2026-09-17"], mode: .replace, newId: idFactory())
        XCTAssertEqual(changes.map(\.table), ["plan_item", "plan_entry", "plan_item"])
        XCTAssertEqual(changes[0].record["id"], .string("ti1"))
        XCTAssertEqual(changes[0].record["deleted"], .number(1))
        XCTAssertEqual(changes[1].record["id"], .string("t1"))
        XCTAssertEqual(changes[1].record["status"], .string("planned"), "a replaced slot starts planned again")
        XCTAssertEqual(changes[1].record["log_entry_id"], .null)
        XCTAssertEqual(changes[2].record["ref_id"], .string("rice"))
        XCTAssertEqual(changes[2].record["position"], .number(0))
    }

    func testCopyIntoAnEmptySlotAlwaysCreatesAPlannedSlot() throws {
        let f = copyFixture()
        let changes = try PlanEditing.copyChanges(
            sourceEntries: f.source, targetEntries: [], itemsByEntry: f.items,
            dayOffsets: ["2026-09-16": "2026-09-18"], mode: .skip, newId: idFactory())
        XCTAssertEqual(changes.map(\.table), ["plan_entry", "plan_item"])
        XCTAssertEqual(changes[0].record["date"], .string("2026-09-18"))
        XCTAssertEqual(changes[0].record["window_name"], .string("Lunch"))
        XCTAssertEqual(changes[0].record["status"], .string("planned"))
        XCTAssertEqual(changes[0].record["note"], .string("src"), "the note travels with the slot")
        XCTAssertEqual(changes[0].record["log_entry_id"], .null, "a copy is never linked to the source's log entry")
    }

    func testCopyAWholeWeekMapsEveryDay() throws {
        let source = [
            PlanEntryData(id: "s1", date: "2026-09-14", windowName: "Lunch", status: .planned),
            PlanEntryData(id: "s2", date: "2026-09-16", windowName: "Dinner", status: .planned),
        ]
        let offsets = Dictionary(uniqueKeysWithValues: PlanDate.week(containing: "2026-09-16")
            .map { ($0, PlanDate.shift($0, byDays: 7)) })
        let changes = try PlanEditing.copyChanges(
            sourceEntries: source, targetEntries: [], itemsByEntry: [:], dayOffsets: offsets,
            mode: .skip, newId: idFactory())
        XCTAssertEqual(changes.count, 2)
        XCTAssertEqual(changes[0].record["date"], .string("2026-09-21"))
        XCTAssertEqual(changes[1].record["date"], .string("2026-09-23"))
    }

    func testOccupiedTargetsAreReported() {
        let f = copyFixture()
        let occupied = PlanEditing.occupiedTargets(
            sourceEntries: f.source, targetEntries: f.target, dayOffsets: ["2026-09-16": "2026-09-17"])
        XCTAssertEqual(occupied, ["2026-09-17|Lunch"])
        XCTAssertTrue(PlanEditing.occupiedTargets(sourceEntries: f.source, targetEntries: [],
                                                  dayOffsets: ["2026-09-16": "2026-09-17"]).isEmpty)
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/Projects/CarbBook && ios/scripts/swift-test.sh CarbBookKit --filter PlanEditingTests`
Expected: FAIL — `type 'PlanEditing' has no member 'copyChanges'`.

- [ ] **Step 3: Implement**

Append to `ios/CarbBookKit/Sources/CarbBookKit/PlanEditing.swift`, inside `enum PlanEditing`:

```swift
    /// What to do when the destination slot already has a live entry (spec §4).
    public enum CopyMode: String, Equatable, Sendable, CaseIterable {
        /// Clear the destination's items and use the source's.
        case replace
        /// Append the source's items after the destination's.
        case merge
        /// Leave the destination untouched.
        case skip

        public var label: String {
            switch self {
            case .replace: "Replace"
            case .merge: "Merge"
            case .skip: "Skip"
            }
        }
    }

    /// Destination slot keys ("<date>|<window>") that already hold a live entry, so the screen can
    /// ask replace / merge / skip only when it actually matters.
    public static func occupiedTargets(sourceEntries: [PlanEntryData], targetEntries: [PlanEntryData],
                                       dayOffsets: [String: String]) -> [String] {
        let existing = Set(targetEntries.map { PlanDate.slotKey(date: $0.date, windowName: $0.windowName) })
        let wanted = sourceEntries.compactMap { entry -> String? in
            guard let target = dayOffsets[entry.date] else { return nil }
            return PlanDate.slotKey(date: target, windowName: entry.windowName)
        }
        return wanted.filter { existing.contains($0) }.sorted()
    }

    /// Records for copying `sourceEntries` onto the days named by `dayOffsets` (source date → target
    /// date; one pair for a day copy, seven for a week). A copy is never linked to the source's log
    /// entry and always lands as `planned`: it is a plan, not a record of something eaten.
    public static func copyChanges(sourceEntries: [PlanEntryData], targetEntries: [PlanEntryData],
                                   itemsByEntry: [Id: [PlanItemData]], dayOffsets: [String: String],
                                   mode: CopyMode, newId: () -> Id) throws -> [SyncChange] {
        var targetsByKey: [String: PlanEntryData] = [:]
        for entry in targetEntries { targetsByKey[PlanDate.slotKey(date: entry.date, windowName: entry.windowName)] = entry }
        var changes: [SyncChange] = []
        for source in sourceEntries.sorted(by: { ($0.date, $0.windowName) < ($1.date, $1.windowName) }) {
            guard let targetDate = dayOffsets[source.date] else { continue }
            let sourceItems = itemsByEntry[source.id] ?? []
            let key = PlanDate.slotKey(date: targetDate, windowName: source.windowName)
            let existing = targetsByKey[key]
            if existing != nil && mode == .skip { continue }

            var startPosition = 0
            let entryId: Id
            if let existing {
                entryId = existing.id
                let existingItems = itemsByEntry[existing.id] ?? []
                if mode == .replace {
                    for item in existingItems {
                        var deletedItem = item
                        deletedItem.deleted = 1
                        changes.append(try SyncChange.encode("plan_item", deletedItem))
                    }
                    // A replaced slot goes back to planned and loses any link to a logged entry.
                    var reset = existing
                    reset.status = .planned
                    reset.logEntryId = nil
                    reset.note = source.note
                    changes.append(try SyncChange.encode("plan_entry", reset))
                } else {
                    startPosition = (existingItems.map(\.position).max() ?? -1) + 1
                }
            } else {
                entryId = newId()
                changes.append(try SyncChange.encode("plan_entry", PlanEntryData(
                    id: entryId, date: targetDate, windowName: source.windowName, status: .planned,
                    note: source.note, logEntryId: nil)))
            }
            for (offset, item) in sourceItems.enumerated() {
                changes.append(try SyncChange.encode("plan_item", PlanItemData(
                    id: newId(), planEntryId: entryId, refType: item.refType, refId: item.refId,
                    amount: item.amount, unit: item.unit, position: startPosition + offset)))
            }
        }
        return changes
    }
```

- [ ] **Step 4: Run the tests**

Run: `cd ~/Projects/CarbBook && ios/scripts/swift-test.sh CarbBookKit --filter PlanEditingTests`
Expected: PASS — 15 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/CarbBook
git add ios/CarbBookKit/Sources/CarbBookKit/PlanEditing.swift ios/CarbBookKit/Tests/CarbBookKitTests/PlanEditingTests.swift
git commit -m "feat(ios-kit): copy day and week with replace, merge and skip"
```

---

## Task 12: `PlanLogLink` — slot ↔ log entry

**Files:**
- Create: `ios/CarbBookKit/Sources/CarbBookKit/PlanLogLink.swift`
- Test: `ios/CarbBookKit/Tests/CarbBookKitTests/PlanLogLinkTests.swift`

- [ ] **Step 1: Write the failing test**

Create `ios/CarbBookKit/Tests/CarbBookKitTests/PlanLogLinkTests.swift`:

```swift
import CarbBookCore
@testable import CarbBookKit
import Foundation
import XCTest

final class PlanLogLinkTests: XCTestCase {
    func testLoggingFromALoadedSlotMarksItLoggedAndStoresTheLink() throws {
        let entry = PlanEntryData(id: "p1", date: "2026-09-16", windowName: "Lunch", status: .planned, note: "x")
        let change = try XCTUnwrap(PlanLogLink.loggedChange(entry, logEntryId: "l1"))
        XCTAssertEqual(change.table, "plan_entry")
        XCTAssertEqual(change.record["status"], .string("logged"))
        XCTAssertEqual(change.record["log_entry_id"], .string("l1"))
        XCTAssertEqual(change.record["note"], .string("x"))
    }

    func testDeletingALogEntryReturnsItsSlotsToPlannedAndClearsTheLink() throws {
        let entries = [PlanEntryData(id: "p1", date: "2026-09-16", windowName: "Lunch", status: .logged,
                                     note: nil, logEntryId: "l1")]
        let changes = try PlanLogLink.unlinkChanges(entries, logEntryId: "l1")
        XCTAssertEqual(changes.count, 1)
        XCTAssertEqual(changes[0].record["status"], .string("planned"))
        XCTAssertEqual(changes[0].record["log_entry_id"], .null)
    }

    func testUnlinkIgnoresSlotsPointingSomewhereElse() throws {
        let entries = [PlanEntryData(id: "p1", date: "2026-09-16", windowName: "Lunch", status: .logged,
                                     note: nil, logEntryId: "l2")]
        XCTAssertTrue(try PlanLogLink.unlinkChanges(entries, logEntryId: "l1").isEmpty)
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/Projects/CarbBook && ios/scripts/swift-test.sh CarbBookKit --filter PlanLogLinkTests`
Expected: FAIL — `cannot find 'PlanLogLink' in scope`.

- [ ] **Step 3: Implement**

Create `ios/CarbBookKit/Sources/CarbBookKit/PlanLogLink.swift`:

```swift
import CarbBookCore
import Foundation

/// Links between a planned slot and the log entry it produced (spec §5).
///
/// The server also reverts a slot when the log entry it points at is soft-deleted (that is where the
/// rule lives, so devices that never held the slot still converge). The client writes the same change
/// as well, so the Plan screen is correct immediately and while offline: both writes set exactly the
/// same fields, so whichever wins last-write-wins produces the same row.
public enum PlanLogLink {
    /// The slot a "Log it" came from, moved to `logged` with its `log_entry_id`.
    public static func loggedChange(_ entry: PlanEntryData?, logEntryId: Id) -> SyncChange? {
        guard var updated = entry else { return nil }
        updated.status = .logged
        updated.logEntryId = logEntryId
        return try? SyncChange.encode("plan_entry", updated)
    }

    /// Slots pointing at a deleted log entry, returned to `planned` with the link cleared.
    public static func unlinkChanges(_ entries: [PlanEntryData], logEntryId: Id) throws -> [SyncChange] {
        try entries.filter { $0.logEntryId == logEntryId }.map { entry in
            var updated = entry
            updated.status = .planned
            updated.logEntryId = nil
            return try SyncChange.encode("plan_entry", updated)
        }
    }
}
```

- [ ] **Step 4: Run the tests**

Run: `cd ~/Projects/CarbBook && ios/scripts/swift-test.sh CarbBookKit --filter PlanLogLinkTests`
Expected: PASS — 3 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/CarbBook
git add ios/CarbBookKit/Sources/CarbBookKit/PlanLogLink.swift ios/CarbBookKit/Tests/CarbBookKitTests/PlanLogLinkTests.swift
git commit -m "feat(ios-kit): plan slot to log entry linking"
```

---

## Task 13: `PlanSuggestion` and per-device dismissals

**Files:**
- Create: `ios/CarbBookKit/Sources/CarbBookKit/PlanSuggestion.swift`
- Test: `ios/CarbBookKit/Tests/CarbBookKitTests/PlanSuggestionTests.swift`

- [ ] **Step 1: Write the failing test**

Create `ios/CarbBookKit/Tests/CarbBookKitTests/PlanSuggestionTests.swift`:

```swift
import CarbBookCore
@testable import CarbBookKit
import Foundation
import XCTest

final class PlanSuggestionTests: XCTestCase {
    let catalog = InMemoryCatalog(
        foods: [FoodData(id: "rice", name: "Rice", source: "custom", carbsPer100g: 28.2)],
        portions: [], meals: [], mealItems: [])

    private func slot(_ status: PlanStatus) -> PlanEntryData {
        PlanEntryData(id: "p1", date: "2026-09-16", windowName: "Lunch", status: status)
    }

    private var items: [PlanItemData] {
        [PlanItemData(id: "i1", planEntryId: "p1", refType: .food, refId: "rice", amount: 100, unit: "g", position: 0)]
    }

    func testAPlannedSlotIsSuggested() {
        let suggestion = PlanSuggestion.make(entry: slot(.planned), items: items, catalog: catalog, dismissed: [])
        XCTAssertNotNil(suggestion)
        XCTAssertEqual(suggestion?.entryId, "p1")
        XCTAssertEqual(suggestion?.carbs.carbsG ?? 0, 28.2, accuracy: 0.001)
        XCTAssertEqual(suggestion?.itemNames, ["Rice"])
    }

    func testLoggedSkippedEmptyAndDismissedSlotsAreNotSuggested() {
        XCTAssertNil(PlanSuggestion.make(entry: slot(.logged), items: items, catalog: catalog, dismissed: []))
        XCTAssertNil(PlanSuggestion.make(entry: slot(.skipped), items: items, catalog: catalog, dismissed: []))
        XCTAssertNil(PlanSuggestion.make(entry: slot(.planned), items: [], catalog: catalog, dismissed: []))
        XCTAssertNil(PlanSuggestion.make(entry: nil, items: [], catalog: catalog, dismissed: []))
        XCTAssertNil(PlanSuggestion.make(entry: slot(.planned), items: items, catalog: catalog,
                                         dismissed: ["2026-09-16|Lunch"]))
    }

    func testAnItemWhoseFoodHasNotSyncedYetStillSuggestsWithMissingData() {
        let unknown = [PlanItemData(id: "i1", planEntryId: "p1", refType: .food, refId: "ghost",
                                    amount: 1, unit: "g", position: 0)]
        let suggestion = PlanSuggestion.make(entry: slot(.planned), items: unknown, catalog: catalog, dismissed: [])
        XCTAssertEqual(suggestion?.itemNames, ["Unknown item"])
        XCTAssertEqual(suggestion?.carbs.complete, false)
    }

    func testLoadProducesEditableCalculatorLines() {
        let suggestion = PlanSuggestion.make(entry: slot(.planned), items: items, catalog: catalog, dismissed: [])
        let lines = PlanSuggestion.lines(for: items, catalog: catalog, newLineId: { "line1" })
        XCTAssertEqual(suggestion?.entryId, "p1")
        XCTAssertEqual(lines, [CalculatorLine(id: "line1", refType: .food, refId: "rice",
                                              displayName: "Rice", amount: 100, unit: "g")])
    }

    func testDismissalsPersistPerDeviceAndAreKeyedByDateAndWindow() throws {
        let name = "plan-suggestion-tests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        XCTAssertTrue(PlanDismissals.load(from: defaults).isEmpty)
        PlanDismissals.dismiss(date: "2026-09-16", windowName: "Lunch", in: defaults)
        XCTAssertEqual(PlanDismissals.load(from: defaults), ["2026-09-16|Lunch"])
        PlanDismissals.dismiss(date: "2026-09-16", windowName: "Dinner", in: defaults)
        XCTAssertEqual(PlanDismissals.load(from: defaults), ["2026-09-16|Lunch", "2026-09-16|Dinner"])
    }

    func testCorruptDismissalStorageIsTreatedAsEmpty() throws {
        let name = "plan-suggestion-tests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        defaults.set("not a list", forKey: PlanDismissals.key)
        XCTAssertTrue(PlanDismissals.load(from: defaults).isEmpty)
        PlanDismissals.dismiss(date: "2026-09-16", windowName: "Lunch", in: defaults)
        XCTAssertEqual(PlanDismissals.load(from: defaults), ["2026-09-16|Lunch"])
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/Projects/CarbBook && ios/scripts/swift-test.sh CarbBookKit --filter PlanSuggestionTests`
Expected: FAIL — `cannot find 'PlanSuggestion' in scope`.

- [ ] **Step 3: Implement**

Create `ios/CarbBookKit/Sources/CarbBookKit/PlanSuggestion.swift`:

```swift
import CarbBookCore
import Foundation

/// The Calculator's "Planned: … — Load / Skip / Dismiss" line (spec §5).
public struct PlanSuggestion: Equatable, Sendable {
    public var entryId: Id
    public var date: String
    public var windowName: String
    /// Display names of the slot's items, in order; an item whose food has not synced yet reads
    /// "Unknown item" rather than hiding the suggestion.
    public var itemNames: [String]
    public var carbs: CarbResult

    public var slotKey: String { PlanDate.slotKey(date: date, windowName: windowName) }

    /// "Planned: Rice, Salad — 42 g" (or "… — missing data").
    public var text: String {
        let amount = carbs.complete ? "\(formatCarbs(carbs.carbsG)) g" : "missing data"
        return "Planned: \(itemNames.joined(separator: ", ")) — \(amount)"
    }

    /// The suggestion for a slot, or nil when there is nothing to offer: no slot, no items, a slot
    /// already logged or skipped, or one dismissed on this device.
    public static func make(entry: PlanEntryData?, items: [PlanItemData], catalog: Catalog,
                            dismissed: Set<String>) -> PlanSuggestion? {
        guard let entry, entry.status == .planned, entry.deleted != 1, !items.isEmpty else { return nil }
        let key = PlanDate.slotKey(date: entry.date, windowName: entry.windowName)
        guard !dismissed.contains(key) else { return nil }
        return PlanSuggestion(
            entryId: entry.id, date: entry.date, windowName: entry.windowName,
            itemNames: items.map { displayName($0, catalog: catalog) },
            carbs: PlanEditing.carbs(items, catalog: catalog))
    }

    /// Calculator rows for "Load": plain editable lines, removable like any other row.
    public static func lines(for items: [PlanItemData], catalog: Catalog, newLineId: () -> String) -> [CalculatorLine] {
        items.map { item in
            CalculatorLine(id: newLineId(), refType: item.refType, refId: item.refId,
                           displayName: displayName(item, catalog: catalog), amount: item.amount, unit: item.unit)
        }
    }

    private static func displayName(_ item: PlanItemData, catalog: Catalog) -> String {
        switch item.refType {
        case .food: catalog.food(item.refId)?.name ?? "Unknown item"
        case .meal: catalog.meal(item.refId)?.name ?? "Unknown item"
        }
    }
}

/// Suggestions the user dismissed on *this device only* — never synced (spec §5). Same key format
/// as the web app's localStorage set, so the two are easy to reason about together.
public enum PlanDismissals {
    public static let key = "plan.dismissedSlots"

    public static func load(from defaults: UserDefaults = .standard) -> Set<String> {
        Set(defaults.array(forKey: key) as? [String] ?? [])
    }

    public static func dismiss(date: String, windowName: String, in defaults: UserDefaults = .standard) {
        var current = load(from: defaults)
        current.insert(PlanDate.slotKey(date: date, windowName: windowName))
        defaults.set(Array(current).sorted(), forKey: key)
    }

    /// Used when a slot is re-planned or edited, so a dismissal never hides a changed slot forever.
    public static func clear(date: String, windowName: String, in defaults: UserDefaults = .standard) {
        var current = load(from: defaults)
        current.remove(PlanDate.slotKey(date: date, windowName: windowName))
        defaults.set(Array(current).sorted(), forKey: key)
    }
}
```

`formatCarbs` is `internal` in CarbBookCore (Task 2), so add `public` to it there and re-run the core suite:

In `ios/CarbBookCore/Sources/CarbBookCore/Goals.swift`, change `func formatCarbs(` to `public func formatCarbs(`.

- [ ] **Step 4: Run the tests**

```bash
cd ~/Projects/CarbBook
ios/scripts/swift-test.sh CarbBookCore
ios/scripts/swift-test.sh CarbBookKit --filter PlanSuggestionTests
```
Expected: the core suite passes, then 6 `PlanSuggestionTests` pass, 0 failures.

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/CarbBook
git add ios/CarbBookCore/Sources/CarbBookCore/Goals.swift ios/CarbBookKit/Sources/CarbBookKit/PlanSuggestion.swift \
  ios/CarbBookKit/Tests/CarbBookKitTests/PlanSuggestionTests.swift
git commit -m "feat(ios-kit): Calculator plan suggestion and per-device dismissals"
```

---

## Task 14: Kit checkpoint — full suite and CI

**Files:** none (verification only)

- [ ] **Step 1: Run both packages**

```bash
cd ~/Projects/CarbBook
ios/scripts/sync-testdata.sh --check
ios/scripts/swift-test.sh CarbBookCore
ios/scripts/swift-test.sh CarbBookKit
```
Expected: `testdata vectors in sync`, then both suites report `0 failures`.

- [ ] **Step 2: Push and watch `ios-tests`**

Run: `cd ~/Projects/CarbBook && git push -u origin feat/meal-planning-ios && gh run watch "$(gh run list --workflow ios-tests.yml --branch feat/meal-planning-ios --limit 1 --json databaseId -q '.[0].databaseId')" --exit-status`
Expected: jobs `testdata-copies`, `core-linux` and `kit-linux` all succeed. (`core-macos` is skipped on a feature-branch push; `build-ipa` runs on the pull request in Task 20.)

---

## Task 15: Goal colours in the design system

**Files:**
- Modify: `ios/CarbBook/App/Theme.swift`

SwiftUI does not compile on this machine; this task ends at a commit and is compiled by CI in Task 16.

- [ ] **Step 1: Add `GoalStyle` and `GoalBadge`**

Append to `ios/CarbBook/App/Theme.swift`:

```swift
/// Goal feedback for a carb total. Colour is never the only signal: `text` always carries the
/// numbers ("68 g · goal 50–80") and `accessibilityLabel` adds the status in words (spec §3).
struct GoalStyle {
    var status: GoalStatus
    var text: String
    var color: Color
    var accessibilityLabel: String
}

/// `nil` goal or incomplete carbs still produce a style — `status` is then `.none` and the colour is
/// the ordinary secondary text colour, so callers never branch on "is there a goal".
func goalStyle(_ carbs: CarbResult, _ goal: CarbGoal?) -> GoalStyle {
    let status = goalStatus(carbs, goal)
    let text = goalText(carbs, goal)
    return GoalStyle(status: status, text: text, color: goalColor(status),
                     accessibilityLabel: status == .none ? text : "\(text), \(status.label)")
}

/// in → green, near → yellow, off → orange, out → red, none → secondary (spec §3).
func goalColor(_ status: GoalStatus) -> Color {
    switch status {
    case .none: .secondary
    case .inGoal: .green
    case .near: .yellow
    case .off: .orange
    case .out: .red
    }
}

/// One line of goal feedback: the numbers in the goal colour, with the spoken status attached.
struct GoalBadge: View {
    let style: GoalStyle
    var font: Font = .callout

    var body: some View {
        Text(style.text)
            .font(font)
            .monospacedDigit()
            .foregroundStyle(style.color)
            .accessibilityLabel(style.accessibilityLabel)
    }
}
```

- [ ] **Step 2: Commit**

```bash
cd ~/Projects/CarbBook
git add ios/CarbBook/App/Theme.swift
git commit -m "feat(ios): goal colour styling with text and accessibility labels"
```

---

## Task 16: The Plan tab — week view

**Files:**
- Create: `ios/CarbBook/Plan/PlanModel.swift`
- Create: `ios/CarbBook/Plan/PlanWeekView.swift`
- Modify: `ios/CarbBook/App/RootView.swift:7-20`

- [ ] **Step 1: Write `PlanModel`**

Create `ios/CarbBook/Plan/PlanModel.swift`:

```swift
import CarbBookCore
import CarbBookKit
import Foundation
import Observation

/// One cell of the Plan grid: a window on a day, with whatever is planned in it.
struct PlanSlot: Identifiable {
    var date: String
    var window: DoseWindow
    var entry: PlanEntryData?
    var items: [PlanItemData]
    var carbs: CarbResult

    var id: String { PlanDate.slotKey(date: date, windowName: window.name) }
    var isEmpty: Bool { items.isEmpty }
}

@Observable
@MainActor
final class PlanModel {
    /// Any date inside the displayed week.
    var anchor: String = PlanDate.string(Date())
    private(set) var week: [String] = []
    private(set) var windows: [DoseWindow] = []
    private(set) var slots: [String: PlanSlot] = [:]
    private(set) var catalog = InMemoryCatalog()
    var message: String?

    /// Windows of the dose-settings version in effect now; an empty list means the user has no dose
    /// settings yet, and the Plan screen says so instead of showing an empty grid.
    private func loadWindows(_ app: AppModel) throws -> [DoseWindow] {
        let versions = try app.store.doseSettingsVersions()
        let usable = eligibleDoseSettingsVersions(versions, rejectedIds: try app.store.rejectedDoseSettingsIds())
        return activeSettings(usable, nowMs())?.windows ?? []
    }

    func load(_ app: AppModel) {
        do {
            week = PlanDate.week(containing: anchor)
            windows = try loadWindows(app)
            catalog = try app.store.catalog()
            let entries = try app.store.planEntries(from: week.first ?? anchor, to: week.last ?? anchor)
            let itemsByEntry = try app.store.planItems(entryIds: entries.map(\.id))
            var built: [String: PlanSlot] = [:]
            for date in week {
                for window in windows {
                    let entry = entries.first { $0.date == date && $0.windowName == window.name }
                    let items = entry.flatMap { itemsByEntry[$0.id] } ?? []
                    built[PlanDate.slotKey(date: date, windowName: window.name)] = PlanSlot(
                        date: date, window: window, entry: entry, items: items,
                        carbs: PlanEditing.carbs(items, catalog: catalog))
                }
            }
            slots = built
        } catch {
            message = "Could not read the plan: \(error)"
        }
    }

    func slot(date: String, window: DoseWindow) -> PlanSlot {
        slots[PlanDate.slotKey(date: date, windowName: window.name)]
            ?? PlanSlot(date: date, window: window, entry: nil, items: [], carbs: CarbResult(carbsG: 0, complete: true))
    }

    /// Carbs planned for a whole day, against that day's summed window goals.
    func dayCarbs(_ date: String) -> CarbResult {
        sumCarbs(windows.map { slot(date: date, window: $0).carbs })
    }

    func dayGoalFor(_ date: String) -> CarbGoal? { dayGoal(windows) }

    func showWeek(offsetBy weeks: Int, _ app: AppModel) {
        anchor = PlanDate.shift(anchor, byDays: weeks * 7)
        load(app)
    }

    func showToday(_ app: AppModel) {
        anchor = PlanDate.string(Date())
        load(app)
    }

    func save(draft: PlanEditing.Draft, slot: PlanSlot, _ app: AppModel) {
        do {
            let changes = try PlanEditing.saveChanges(draft: draft, existing: slot.entry,
                                                      existingItems: slot.items, newId: app.store.newId)
            try app.save(changes)
            // An edited slot is worth offering again even if it was dismissed on this device.
            PlanDismissals.clear(date: slot.date, windowName: slot.window.name)
            load(app)
        } catch let error as PlanEditing.EditError {
            message = error.message
        } catch {
            message = "Could not save the slot: \(error)"
        }
    }

    func clear(slot: PlanSlot, _ app: AppModel) {
        guard let entry = slot.entry else { return }
        do {
            try app.save(PlanEditing.deleteChanges(entry: entry, items: slot.items))
            load(app)
        } catch {
            message = "Could not clear the slot: \(error)"
        }
    }

    func setStatus(_ status: PlanStatus, slot: PlanSlot, _ app: AppModel) {
        guard let entry = slot.entry else { return }
        do {
            try app.save([PlanEditing.statusChange(entry, to: status)])
            load(app)
        } catch {
            message = "Could not update the slot: \(error)"
        }
    }
}
```

- [ ] **Step 2: Write the week view**

Create `ios/CarbBook/Plan/PlanWeekView.swift`:

```swift
import CarbBookCore
import CarbBookKit
import SwiftUI

/// Phone layout of the spec §4 week grid: days as sections, that day's windows stacked inside.
struct PlanWeekView: View {
    @Environment(AppModel.self) private var app
    @State private var model = PlanModel()
    @State private var editing: PlanSlot?

    var body: some View {
        NavigationStack {
            List {
                if model.windows.isEmpty {
                    Section {
                        Text("Add dose settings with meal windows before planning.").foregroundStyle(.secondary)
                    }
                }
                ForEach(model.week, id: \.self) { date in
                    Section {
                        ForEach(model.windows, id: \.name) { window in
                            slotRow(model.slot(date: date, window: window))
                        }
                    } header: {
                        dayHeader(date)
                    }
                }
            }
            .navigationTitle("Plan")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { model.showWeek(offsetBy: -1, app) } label: { Image(systemName: "chevron.left") }
                        .accessibilityLabel("Previous week")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { model.showWeek(offsetBy: 1, app) } label: { Image(systemName: "chevron.right") }
                        .accessibilityLabel("Next week")
                }
                ToolbarItem(placement: .bottomBar) { Button("Today") { model.showToday(app) } }
            }
            .sheet(item: $editing) { slot in
                PlanSlotEditorView(slot: slot) { draft in model.save(draft: draft, slot: slot, app) }
            }
            .alert(model.message ?? "", isPresented: Binding(get: { model.message != nil },
                                                             set: { if !$0 { model.message = nil } })) {
                Button("OK", role: .cancel) {}
            }
            .onAppear { model.load(app) }
            .onChange(of: app.revision) { model.load(app) }
        }
    }

    private func dayHeader(_ date: String) -> some View {
        let total = model.dayCarbs(date)
        let style = goalStyle(total, model.dayGoalFor(date))
        return HStack {
            Text(PlanDate.date(date).map { $0.formatted(.dateTime.weekday(.abbreviated).month().day()) } ?? date)
            Spacer()
            GoalBadge(style: style, font: .caption)
        }
    }

    private func slotRow(_ slot: PlanSlot) -> some View {
        Button {
            editing = slot
        } label: {
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(slot.window.name).foregroundStyle(.primary)
                    if let status = slot.entry?.status, status != .planned {
                        Text(status.rawValue)
                            .font(.caption2)
                            .padding(.horizontal, 6).padding(.vertical, 2)
                            .background(Theme.fieldBackground)
                            .clipShape(Capsule())
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    if slot.isEmpty {
                        Image(systemName: "plus").foregroundStyle(.secondary).accessibilityLabel("Plan \(slot.window.name)")
                    } else {
                        GoalBadge(style: goalStyle(slot.carbs, slot.window.carbGoal), font: .callout)
                    }
                }
                if !slot.isEmpty {
                    Text(itemsText(slot)).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
            }
        }
        .swipeActions(edge: .trailing) {
            if slot.entry != nil {
                Button("Clear", role: .destructive) { model.clear(slot: slot, app) }
                Button(slot.entry?.status == .skipped ? "Plan" : "Skip") {
                    model.setStatus(slot.entry?.status == .skipped ? .planned : .skipped, slot: slot, app)
                }
            }
        }
    }

    private func itemsText(_ slot: PlanSlot) -> String {
        slot.items.map { item in
            switch item.refType {
            case .food: model.catalog.food(item.refId)?.name ?? "Unknown item"
            case .meal: model.catalog.meal(item.refId)?.name ?? "Unknown item"
            }
        }.joined(separator: ", ")
    }
}
```

- [ ] **Step 3: Add the tab**

In `ios/CarbBook/App/RootView.swift`, insert between the `MealsView` and `LogView` entries:

```swift
            PlanWeekView()
                .tabItem { Label("Plan", systemImage: "calendar") }
```

- [ ] **Step 4: Commit**

```bash
cd ~/Projects/CarbBook
git add ios/CarbBook/Plan ios/CarbBook/App/RootView.swift
git commit -m "feat(ios): Plan tab with the week view and goal colours"
```

- [ ] **Step 5: Push without a CI build**

Run: `cd ~/Projects/CarbBook && git push`
Expected: pushed. Do **not** start a `build-ipa` run yet: `PlanWeekView` references `PlanSlotEditorView`, which Task 17 creates, so the app target cannot compile until that task is done. The first UI build checkpoint is Task 17 Step 3.

---

## Task 17: The slot editor

**Files:**
- Create: `ios/CarbBook/Plan/PlanSlotEditorView.swift`

- [ ] **Step 1: Write the editor**

Create `ios/CarbBook/Plan/PlanSlotEditorView.swift`:

```swift
import CarbBookCore
import CarbBookKit
import SwiftUI

/// Edits one plan slot with the same item picker as the Calculator (`AddItemSheet`), the same strict
/// fraction-capable amount parsing (`AmountInput`, so "2/3" works) and the same `UnitPicker`.
struct PlanSlotEditorView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let slot: PlanSlot
    let onSave: (PlanEditing.Draft) -> Void

    @State private var items: [PlanEditing.DraftItem] = []
    @State private var note = ""
    @State private var showAdd = false
    @State private var error: String?
    @State private var loaded = false

    private var catalog: InMemoryCatalog { (try? app.store.catalog()) ?? InMemoryCatalog() }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    ForEach($items) { $item in
                        PlanItemRow(item: $item, name: displayName(item), units: units(for: item),
                                    portions: catalog.portions(item.refId),
                                    carbs: itemCarbs(catalog, item.refType, item.refId, item.amount, item.unit))
                    }
                    .onDelete { items.remove(atOffsets: $0) }
                    Button { showAdd = true } label: { Label("Add food or meal", systemImage: "plus.circle") }
                        .buttonStyle(.borderless)
                } header: {
                    Text("Items")
                } footer: {
                    GoalBadge(style: goalStyle(total, slot.window.carbGoal))
                }
                Section("Note") {
                    TextField("Optional note", text: $note, axis: .vertical)
                }
                if let error { Section { Text(error).foregroundStyle(.red) } }
            }
            .navigationTitle("\(slot.window.name) · \(slot.date)")
            .navigationBarTitleDisplayMode(.inline)
            .sheet(isPresented: $showAdd) {
                AddItemSheet { hit in add(hit) }
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Save") { save() } }
            }
            .onAppear(perform: load)
        }
    }

    private var total: CarbResult {
        sumCarbs(items.map { itemCarbs(catalog, $0.refType, $0.refId, $0.amount, $0.unit) })
    }

    /// Plans never snapshot a display name, so it is resolved live from the catalog.
    private func displayName(_ item: PlanEditing.DraftItem) -> String {
        switch item.refType {
        case .food: catalog.food(item.refId)?.name ?? "Unknown item"
        case .meal: catalog.meal(item.refId)?.name ?? "Unknown item"
        }
    }

    private func units(for item: PlanEditing.DraftItem) -> [String] {
        switch item.refType {
        case .food: catalog.food(item.refId).map { foodUnits($0, catalog.portions(item.refId)) } ?? [item.unit]
        case .meal: catalog.meal(item.refId).map { mealUnits($0) } ?? [item.unit]
        }
    }

    private func load() {
        guard !loaded else { return }
        loaded = true
        items = slot.items.map {
            PlanEditing.DraftItem(id: $0.id, refType: $0.refType, refId: $0.refId, amount: $0.amount, unit: $0.unit)
        }
        note = slot.entry?.note ?? ""
    }

    /// USDA hits are copied into the synced food table first, exactly as the Calculator does.
    private func add(_ hit: SearchHit) {
        do {
            switch hit.kind {
            case .meal:
                items.append(PlanEditing.DraftItem(id: nil, refType: .meal, refId: hit.id, amount: 1, unit: Units.serving))
            case .food:
                appendFood(id: hit.id)
            case .usda:
                guard let fdcId = hit.usdaFdcId, let usda = app.usda else { return }
                let id = try app.store.adoptUsdaFood(fdcId: fdcId, library: usda)
                app.revision += 1
                appendFood(id: id)
            }
        } catch {
            self.error = "Could not add \(hit.name): \(error)"
        }
    }

    private func appendFood(id: Id) {
        let initial = catalog.food(id).map { defaultFoodAmountAndUnit($0, catalog.portions(id)) } ?? (amount: 100, unit: "g")
        items.append(PlanEditing.DraftItem(id: nil, refType: .food, refId: id, amount: initial.amount, unit: initial.unit))
    }

    private func save() {
        guard !items.contains(where: { !$0.amount.isFinite || $0.amount < 0 }) else {
            error = PlanEditing.EditError.invalidAmount.message
            return
        }
        onSave(PlanEditing.Draft(date: slot.date, windowName: slot.window.name, note: note, items: items))
        dismiss()
    }
}

/// One editable plan row. Amount text is parsed strictly with `AmountInput` (fractions allowed),
/// so empty or malformed text becomes NaN and blocks the save instead of silently keeping a number
/// the field no longer shows.
struct PlanItemRow: View {
    @Binding var item: PlanEditing.DraftItem
    let name: String
    let units: [String]
    let portions: [PortionData]
    let carbs: CarbResult
    @State private var amountText: String

    init(item: Binding<PlanEditing.DraftItem>, name: String, units: [String], portions: [PortionData], carbs: CarbResult) {
        _item = item
        self.name = name
        self.units = units
        self.portions = portions
        self.carbs = carbs
        _amountText = State(initialValue: AmountInput.text(for: item.wrappedValue.amount))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(name).lineLimit(2)
                Spacer()
                Text(carbs.complete ? "\(formatNumber(carbs.carbsG))g" : "missing data")
                    .foregroundStyle(carbs.complete ? Color.primary : Color.orange)
                    .monospacedDigit()
            }
            HStack {
                TextField("e.g. 2/3", text: $amountText)
                    .keyboardType(.numbersAndPunctuation)
                    .padding(6)
                    .background(Theme.fieldBackground)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .frame(maxWidth: 110)
                    .onChange(of: amountText) { _, text in item.amount = AmountInput.modelAmount(text) }
                UnitPicker(unit: $item.unit, units: units, portions: portions)
            }
            if AmountInput.isInvalid(amountText) {
                Text(AmountInput.invalidMessage).font(.caption).foregroundStyle(.red)
            }
        }
    }
}
```

- [ ] **Step 2: Commit**

```bash
cd ~/Projects/CarbBook
git add ios/CarbBook/Plan/PlanSlotEditorView.swift
git commit -m "feat(ios): plan slot editor reusing the item picker"
```

- [ ] **Step 3: CI build checkpoint**

Run: `cd ~/Projects/CarbBook && git push && gh workflow run build-ipa.yml --ref feat/meal-planning-ios && sleep 15 && gh run watch "$(gh run list --workflow build-ipa.yml --branch feat/meal-planning-ios --limit 1 --json databaseId -q '.[0].databaseId')" --exit-status`
Expected: the `build` job succeeds (macOS package tests pass, the log contains `** BUILD SUCCEEDED **`, artifact `CarbBook-ipa` uploaded). This UI code was never compiled while the plan was written (no Xcode on Linux): if Swift reports errors, fix them in the files from Tasks 15–17 without changing behaviour, commit, and re-run.

---

## Task 18: Copy day and copy week from the Plan screen

**Files:**
- Create: `ios/CarbBook/Plan/PlanCopySheet.swift`
- Modify: `ios/CarbBook/Plan/PlanModel.swift`
- Modify: `ios/CarbBook/Plan/PlanWeekView.swift`

- [ ] **Step 1: Add the copy actions to `PlanModel`**

Append to `PlanModel`, before the closing brace:

```swift
    /// What the user is copying: one day, or the whole displayed week onto the next one.
    enum CopyScope: Equatable {
        case day(String)
        case week
    }

    /// Source date → target date for a scope. A day copy has one pair; a week copy maps each of the
    /// seven displayed days onto the same weekday `weeks` later.
    func dayOffsets(for scope: CopyScope, target: String, weeks: Int = 1) -> [String: String] {
        switch scope {
        case .day(let date): [date: target]
        case .week: Dictionary(uniqueKeysWithValues: week.map { ($0, PlanDate.shift($0, byDays: weeks * 7)) })
        }
    }

    /// Destination slots that already hold an entry, so the sheet only asks replace/merge/skip when
    /// there is actually a clash.
    func occupied(_ offsets: [String: String], _ app: AppModel) -> [String] {
        let sources = sourceEntries(offsets)
        let targetDates = offsets.values.sorted()
        guard let first = targetDates.first, let last = targetDates.last else { return [] }
        let targets = (try? app.store.planEntries(from: first, to: last)) ?? []
        return PlanEditing.occupiedTargets(sourceEntries: sources, targetEntries: targets, dayOffsets: offsets)
    }

    func copy(_ offsets: [String: String], mode: PlanEditing.CopyMode, _ app: AppModel) {
        do {
            let sources = sourceEntries(offsets)
            guard !sources.isEmpty else {
                message = "There is nothing planned to copy."
                return
            }
            let targetDates = offsets.values.sorted()
            let targets = try app.store.planEntries(from: targetDates.first ?? anchor, to: targetDates.last ?? anchor)
            var itemsByEntry = try app.store.planItems(entryIds: sources.map(\.id))
            for (key, value) in try app.store.planItems(entryIds: targets.map(\.id)) { itemsByEntry[key] = value }
            let changes = try PlanEditing.copyChanges(
                sourceEntries: sources, targetEntries: targets, itemsByEntry: itemsByEntry,
                dayOffsets: offsets, mode: mode, newId: app.store.newId)
            guard !changes.isEmpty else {
                message = "Nothing was copied: every destination already had a plan."
                return
            }
            try app.save(changes)
            load(app)
            message = "Copied \(changes.filter { $0.table == "plan_entry" }.count) slot(s)."
        } catch {
            message = "Could not copy: \(error)"
        }
    }

    private func sourceEntries(_ offsets: [String: String]) -> [PlanEntryData] {
        offsets.keys.sorted().flatMap { date in
            windows.compactMap { slot(date: date, window: $0).entry }.filter { $0.date == date }
        }
    }
```

- [ ] **Step 2: Write the copy sheet**

Create `ios/CarbBook/Plan/PlanCopySheet.swift`:

```swift
import CarbBookCore
import CarbBookKit
import SwiftUI

/// Copy a day to a date, or the displayed week to the next one (spec §4). When any destination slot
/// already has a plan, the user picks replace / merge / skip before anything is written.
struct PlanCopySheet: View {
    @Environment(\.dismiss) private var dismiss
    let scope: PlanModel.CopyScope
    /// Destination keys that already hold a plan, for the chosen target.
    let occupied: ([String: String]) -> [String]
    let offsets: (String) -> [String: String]
    let onCopy: ([String: String], PlanEditing.CopyMode) -> Void

    @State private var target = Date()
    @State private var mode: PlanEditing.CopyMode = .skip

    private var currentOffsets: [String: String] { offsets(PlanDate.string(target)) }
    private var clashes: [String] { occupied(currentOffsets) }

    var body: some View {
        NavigationStack {
            Form {
                switch scope {
                case .day:
                    Section("Copy to") { DatePicker("Date", selection: $target, displayedComponents: .date) }
                case .week:
                    Section { Text("Copies this week onto next week, day by day.") }
                }
                if clashes.isEmpty {
                    Section { Text("Nothing is planned in the destination yet.").foregroundStyle(.secondary) }
                } else {
                    Section {
                        Picker("When a slot already has a plan", selection: $mode) {
                            ForEach(PlanEditing.CopyMode.allCases, id: \.self) { Text($0.label).tag($0) }
                        }
                        .pickerStyle(.segmented)
                    } footer: {
                        Text("\(clashes.count) destination slot(s) already planned: "
                             + "Replace overwrites their items, Merge appends, Skip leaves them alone.")
                    }
                }
            }
            .navigationTitle(scope == .week ? "Copy week" : "Copy day")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Copy") {
                        onCopy(currentOffsets, mode)
                        dismiss()
                    }
                }
            }
        }
    }
}
```

- [ ] **Step 3: Wire the actions into `PlanWeekView`**

Add these state properties to `PlanWeekView`:

```swift
    @State private var copyScope: PlanModel.CopyScope?
```

Make the scope presentable by adding this to `PlanCopySheet.swift`:

```swift
extension PlanModel.CopyScope: Identifiable {
    var id: String {
        switch self {
        case .day(let date): "day-\(date)"
        case .week: "week"
        }
    }
}
```

Add a "Copy day" button to each day section header and a "Copy week" toolbar item. In `PlanWeekView.dayHeader(_:)`, replace the `HStack { … }` body with:

```swift
        return HStack {
            Text(PlanDate.date(date).map { $0.formatted(.dateTime.weekday(.abbreviated).month().day()) } ?? date)
            Spacer()
            GoalBadge(style: style, font: .caption)
            Button { copyScope = .day(date) } label: { Image(systemName: "doc.on.doc") }
                .buttonStyle(.borderless)
                .accessibilityLabel("Copy \(date) to another day")
        }
```

In the `.toolbar` block, add:

```swift
                ToolbarItem(placement: .bottomBar) { Button("Copy week") { copyScope = .week } }
```

and after the existing `.sheet(item: $editing)`, add:

```swift
            .sheet(item: $copyScope) { scope in
                PlanCopySheet(
                    scope: scope,
                    occupied: { model.occupied($0, app) },
                    offsets: { target in model.dayOffsets(for: scope, target: target) },
                    onCopy: { offsets, mode in model.copy(offsets, mode: mode, app) })
            }
```

- [ ] **Step 4: Commit**

```bash
cd ~/Projects/CarbBook
git add ios/CarbBook/Plan
git commit -m "feat(ios): copy day and week from the Plan screen"
```

- [ ] **Step 5: CI build checkpoint**

Run: `cd ~/Projects/CarbBook && git push && gh workflow run build-ipa.yml --ref feat/meal-planning-ios && sleep 15 && gh run watch "$(gh run list --workflow build-ipa.yml --branch feat/meal-planning-ios --limit 1 --json databaseId -q '.[0].databaseId')" --exit-status`
Expected: the `build` job succeeds (`** BUILD SUCCEEDED **`). Fix any Swift error in this task's files without changing behaviour, commit, and re-run.

---

## Task 19: Calculator suggestion — Load, Skip, Dismiss, and logging from a slot

**Files:**
- Modify: `ios/CarbBook/Calculator/CalculatorModel.swift`
- Modify: `ios/CarbBook/Calculator/CalculatorView.swift`

- [ ] **Step 1: Add suggestion state to `CalculatorModel`**

Add these properties after `private(set) var rejectedSettingsIds: Set<Id> = []`:

```swift
    /// The planned slot offered for the current date + window, or nil (spec §5).
    private(set) var suggestion: PlanSuggestion?
    /// The slot whose items were loaded in this session; "Log it" marks it `logged`.
    private(set) var loadedSlotId: Id?
```

Add these methods before `func logIt(_ app: AppModel) throws {`:

```swift
    /// The window the estimate is using (or the override), which decides which slot to offer.
    private var suggestedWindowName: String? {
        windowOverride ?? result?.estimate?.window?.name
    }

    /// Re-reads the planned slot for the current date + window. Called from `reload` and after every
    /// recompute, because changing the time or the window changes which slot applies.
    func refreshSuggestion(_ app: AppModel) {
        guard let windowName = suggestedWindowName else {
            if suggestion != nil { suggestion = nil }
            return
        }
        let date = PlanDate.string(eatenAt)
        do {
            let entry = try app.store.planEntry(date: date, windowName: windowName)
            var items: [PlanItemData] = []
            if let entry { items = try app.store.planItems(entryIds: [entry.id])[entry.id] ?? [] }
            let next = PlanSuggestion.make(entry: entry, items: items, catalog: catalog,
                                           dismissed: PlanDismissals.load())
            // Assigning an unchanged value would re-trigger the view update that called this.
            if next != suggestion { suggestion = next }
        } catch {
            if suggestion != nil { suggestion = nil }
        }
    }

    /// Load: appends the slot's items as ordinary editable rows and remembers the slot.
    func loadSuggestion(_ app: AppModel) {
        guard let suggestion else { return }
        do {
            let items = (try app.store.planItems(entryIds: [suggestion.entryId])[suggestion.entryId]) ?? []
            lines.append(contentsOf: PlanSuggestion.lines(for: items, catalog: catalog,
                                                          newLineId: { UUID().uuidString }))
            loadedSlotId = suggestion.entryId
            self.suggestion = nil
            recompute(app)
        } catch {
            message = "Could not load the planned meal: \(error)"
        }
    }

    /// Skip: sets the slot to `skipped` (synced).
    func skipSuggestion(_ app: AppModel) {
        guard let suggestion,
              let entry = try? app.store.planEntry(date: suggestion.date, windowName: suggestion.windowName) else { return }
        do {
            try app.save([PlanEditing.statusChange(entry, to: .skipped)])
            self.suggestion = nil
        } catch {
            message = "Could not skip the planned meal: \(error)"
        }
    }

    /// Dismiss: hides the suggestion for this slot on this device only. Never synced.
    func dismissSuggestion(_ app: AppModel) {
        guard let suggestion else { return }
        PlanDismissals.dismiss(date: suggestion.date, windowName: suggestion.windowName)
        self.suggestion = nil
    }
```

- [ ] **Step 2: Refresh the suggestion when the inputs change, and mark the slot on logging**

At the end of `reload(_:)`, after `recompute(app)`, add:

```swift
        refreshSuggestion(app)
```

At the end of `recompute(_:)`, after the `takenField.applyEstimate` branches, add:

```swift
        refreshSuggestion(app)
```

In `logIt(_:)`, replace the single `try app.save(...)` line with:

```swift
        var changes = [try SyncChange.encode("log_entry", records.entry)]
            + (try records.items.map { try SyncChange.encode("log_item", $0) })
        // Logging while a slot is loaded marks that slot logged and stores the link (spec §5).
        // Logging without loading changes nothing about the plan.
        if let loadedSlotId, let entry = (try? app.store.records("plan_entry", "WHERE deleted = 0 AND id = ?",
                                                                 [loadedSlotId]) as [PlanEntryData])?.first,
           let linked = PlanLogLink.loggedChange(entry, logEntryId: records.entry.id) {
            changes.append(linked)
        }
        try app.save(changes)
```

and add `loadedSlotId = nil` to the reset block, right after `lines = []`.

- [ ] **Step 3: Show the suggestion line and colour the running total**

In `ios/CarbBook/Calculator/CalculatorView.swift`, replace `itemsSection` with:

```swift
    private var itemsSection: some View {
        Section {
            if let suggestion = model.suggestion {
                VStack(alignment: .leading, spacing: 6) {
                    Text(suggestion.text).font(.callout)
                    HStack {
                        Button("Load") { model.loadSuggestion(app) }
                        Spacer()
                        Button("Skip") { model.skipSuggestion(app) }
                        Spacer()
                        Button("Dismiss") { model.dismissSuggestion(app) }
                    }
                    .buttonStyle(.borderless)
                }
                .accessibilityElement(children: .contain)
            }
            ForEach($model.lines) { $line in
                LineRow(line: $line, units: model.units(for: line), portions: model.catalog.portions(line.refId),
                        carbs: model.carbs(for: line))
            }
            .onDelete { model.lines.remove(atOffsets: $0) }
            HStack {
                Button { showAdd = true } label: { Label("Add food or meal", systemImage: "plus.circle") }
                Spacer()
                Button { showScanner = true } label: { Label("Scan", systemImage: "barcode.viewfinder") }
            }
            .buttonStyle(.borderless)
        } header: {
            Text("Items")
        } footer: {
            if let total = model.result?.total, !model.lines.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    // Goal feedback for the current window's total (spec §3).
                    GoalBadge(style: goalStyle(total, model.currentWindowGoal), font: .footnote)
                    if !total.complete {
                        Text("Incomplete: some items are missing carb data.").foregroundStyle(.orange)
                    }
                }
            }
        }
    }
```

Add to `CalculatorModel`, next to `activeSettings`:

```swift
    /// The carb goal of the window the estimate is using, if it has one.
    var currentWindowGoal: CarbGoal? {
        guard let name = windowOverride ?? result?.estimate?.window?.name else { return nil }
        return activeSettings?.windows.first { $0.name == name }?.carbGoal
    }
```

- [ ] **Step 4: Commit**

```bash
cd ~/Projects/CarbBook
git add ios/CarbBook/Calculator
git commit -m "feat(ios): Calculator plan suggestion with Load, Skip and Dismiss"
```

- [ ] **Step 5: CI build checkpoint**

Run: `cd ~/Projects/CarbBook && git push && gh workflow run build-ipa.yml --ref feat/meal-planning-ios && sleep 15 && gh run watch "$(gh run list --workflow build-ipa.yml --branch feat/meal-planning-ios --limit 1 --json databaseId -q '.[0].databaseId')" --exit-status`
Expected: the `build` job succeeds (`** BUILD SUCCEEDED **`). If `refreshSuggestion` causes an `@Observable` update loop (the screen redraws forever), the cause is assigning `suggestion` when it did not change — the `if next != suggestion` guard above is what prevents it; keep it.

---

## Task 20: Goal colours in the Log, slot unlinking, and goals in dose settings

**Files:**
- Modify: `ios/CarbBook/Log/LogView.swift`
- Modify: `ios/CarbBook/Settings/DoseSettingsEditorView.swift`

- [ ] **Step 1: Colour Log entries and the day total against their goals**

In `ios/CarbBook/Log/LogView.swift`, add these properties and helpers to the struct:

```swift
    @State private var windows: [DoseWindow] = []

    /// The goal of the window an entry was logged in, if that window still has one.
    private func goal(for entry: LogEntryData) -> CarbGoal? {
        guard let name = entry.windowName else { return nil }
        return windows.first { $0.name == name }?.carbGoal
    }
```

In `load()`, after the `entries = …` line, add:

```swift
        let versions = (try? app.store.doseSettingsVersions()) ?? []
        let usable = eligibleDoseSettingsVersions(versions, rejectedIds: (try? app.store.rejectedDoseSettingsIds()) ?? [])
        windows = activeSettings(usable, ms(day))?.windows ?? []
```

In the first `Section`, replace the `LabeledContent("Carbs", …)` line with:

```swift
                    HStack {
                        Text("Carbs")
                        Spacer()
                        GoalBadge(style: goalStyle(
                            CarbResult(carbsG: entries.reduce(0) { $0 + $1.totalCarbsG }, complete: true),
                            dayGoal(windows)))
                    }
```

In `row(_:)`, replace `Text("\(formatNumber(entry.totalCarbsG))g").monospacedDigit()` with:

```swift
                GoalBadge(style: goalStyle(CarbResult(carbsG: entry.totalCarbsG, complete: true), goal(for: entry)),
                          font: .body)
```

- [ ] **Step 2: Return a slot to `planned` when its log entry is deleted**

In `LogView.delete(_:)`, add the unlink before the entry is deleted, so the Plan screen is right immediately and offline (the server applies the same rule when the delete is pushed):

```swift
    private func delete(_ offsets: IndexSet) {
        for index in offsets {
            let entry = entries[index]
            for item in (try? app.store.logItems(entryId: entry.id)) ?? [] {
                try? app.delete("log_item", id: item.id)
            }
            // Slots pointing at this entry go back to planned with the link cleared (spec §5).
            if let linked = try? app.store.planEntries(logEntryId: entry.id),
               let changes = try? PlanLogLink.unlinkChanges(linked, logEntryId: entry.id), !changes.isEmpty {
                try? app.save(changes)
            }
            try? app.delete("log_entry", id: entry.id)
        }
    }
```

- [ ] **Step 3: Keep and edit carb goals in the dose settings editor**

The editor rebuilds every window from its draft, so without this a saved version would silently drop the seeded goals.

In `ios/CarbBook/Settings/DoseSettingsEditorView.swift`, extend `WindowDraft`:

```swift
    private struct WindowDraft: Identifiable {
        let id = UUID()
        var name: String
        var start: Date
        var ratio: String
        var goalEnabled: Bool
        var goalMin: String
        var goalMax: String
    }
```

In `load()`, build the draft with the goal fields:

```swift
        windows = base.windows.map { window in
            let minutes = (try? parseHHMM(window.start)) ?? 0
            let start = Calendar.current.date(byAdding: .minute, value: minutes, to: Calendar.current.startOfDay(for: Date()))!
            return WindowDraft(name: window.name, start: start, ratio: NumberParsing.editText(window.ratioGPerUnit),
                               goalEnabled: window.carbGoal != nil,
                               goalMin: NumberParsing.editText(window.carbGoal?.min),
                               goalMax: NumberParsing.editText(window.carbGoal?.max))
        }
```

and in the `guard let base else` branch:

```swift
            windows = [WindowDraft(name: "All day", start: Calendar.current.startOfDay(for: Date()), ratio: "10",
                                   goalEnabled: false, goalMin: "", goalMax: "")]
```

In the "Add window" button:

```swift
                Button("Add window") {
                    windows.append(WindowDraft(name: "", start: Calendar.current.startOfDay(for: Date()), ratio: "10",
                                               goalEnabled: false, goalMin: "", goalMax: ""))
                }
```

Inside the window `VStack`, after the ratio field:

```swift
                        Toggle("Carb goal", isOn: $window.goalEnabled)
                        if window.goalEnabled {
                            NumberField(label: "Goal min", text: $window.goalMin, unit: "g")
                            NumberField(label: "Goal max", text: $window.goalMax, unit: "g")
                        }
```

In `save()`, build each window with its goal (a malformed field becomes NaN, which `validateDoseSettings` rejects with the message from Task 4 instead of silently saving 0):

```swift
            windows: windows.map { draft in
                DoseWindow(name: draft.name.trimmingCharacters(in: .whitespaces), start: hhmm(draft.start),
                           ratioGPerUnit: DoseSettingsInput.decimal(draft.ratio),
                           carbGoal: draft.goalEnabled
                               ? CarbGoal(min: DoseSettingsInput.decimal(draft.goalMin),
                                          max: DoseSettingsInput.decimal(draft.goalMax))
                               : nil)
            },
```

Extend the windows section footer so the rule is visible:

```swift
                Text("Each window runs until the next one starts; the last wraps past midnight. Ratio must be > 0 and at most \(formatNumber(DoseLimits.maxRatioGPerUnit, digits: 0)) g/u. A carb goal needs 0 ≤ min ≤ max ≤ \(formatNumber(DoseLimits.maxCarbsG, digits: 0)) g.")
```

- [ ] **Step 4: Commit**

```bash
cd ~/Projects/CarbBook
git add ios/CarbBook/Log/LogView.swift ios/CarbBook/Settings/DoseSettingsEditorView.swift
git commit -m "feat(ios): goal colours in the Log, slot unlinking and carb goals in dose settings"
```

- [ ] **Step 5: CI build checkpoint**

Run: `cd ~/Projects/CarbBook && git push && gh workflow run build-ipa.yml --ref feat/meal-planning-ios && sleep 15 && gh run watch "$(gh run list --workflow build-ipa.yml --branch feat/meal-planning-ios --limit 1 --json databaseId -q '.[0].databaseId')" --exit-status`
Expected: the `build` job succeeds (`** BUILD SUCCEEDED **`). Fix any Swift error in this task's files without changing behaviour, commit, and re-run.

---

## Task 21: Release through ipa-hub

**Files:**
- Modify: `ios/project.yml:37`

- [ ] **Step 1: Final local verification**

```bash
cd ~/Projects/CarbBook
ios/scripts/sync-testdata.sh --check
ios/scripts/swift-test.sh CarbBookCore
ios/scripts/swift-test.sh CarbBookKit
```
Expected: `testdata vectors in sync` and `0 failures` from both suites.

- [ ] **Step 2: Bump the marketing version**

In `ios/project.yml`, change `MARKETING_VERSION: "0.1.0"` to:

```yaml
        MARKETING_VERSION: "0.2.0"
```

The build number is the workflow run number, set by `release.yml`; nothing else needs editing.

- [ ] **Step 3: Commit and open the pull request**

```bash
cd ~/Projects/CarbBook
git add ios/project.yml
git commit -m "chore(ios): bump marketing version to 0.2.0 for meal planning"
git push
gh pr create --fill --title "iOS meal planning and carb goals" \
  --body "Plan screen, Calculator suggestion, goal colours, plan_entry/plan_item sync. Implements docs/superpowers/plans/2026-09-16-meal-planning-ios.md."
```

- [ ] **Step 4: Watch both workflows on the pull request**

```bash
cd ~/Projects/CarbBook
gh pr checks --watch --fail-fast
```
Expected: `ios-tests` (`testdata-copies`, `core-linux`, `kit-linux`, `core-macos`) and `build-ipa` (`build`) all pass.

- [ ] **Step 5: Merge and watch the release**

```bash
cd ~/Projects/CarbBook
gh pr merge --squash --delete-branch
sleep 20
gh run watch "$(gh run list --workflow release.yml --branch main --limit 1 --json databaseId -q '.[0].databaseId')" --exit-status
```
Expected: the `release` job succeeds and publishes tag `v0.2.0-build<N>` with `CarbBook-0.2.0-build<N>.ipa` attached.

- [ ] **Step 6: Confirm ipa-hub picked it up**

```bash
~/Projects/ipa-hub/.venv/bin/ipa-sync --config ~/Projects/ipa-hub/apps.yaml
curl -s https://ipa.dxshdw.dev/source.json | python3 -m json.tool | grep -i -A2 carbbook | head -20
```
Expected: the feed lists version `0.2.0` for CarbBook. (`ipa-sync` also runs on its own timer; running it by hand only makes the update immediate.)

- [ ] **Step 7: Device smoke test (only possible on the phone)**

Install the new build in LiveContainer from `https://ipa.dxshdw.dev/source.json`, then walk the spec §7 iOS scenario:

1. Plan tab → tap Lunch on today → add a food with the amount `2/3` → Save. The cell shows the items, the carb total in its goal colour and no status chip.
2. Swipe the day's header copy button → copy today to tomorrow → tomorrow's Lunch shows the same items.
3. Repeat the copy with a plan already in tomorrow's Lunch → the sheet offers Replace / Merge / Skip → Merge appends.
4. Calculator at a time inside the Lunch window → "Planned: … — Load / Skip / Dismiss" appears → Load appends editable rows → edit one amount → Log it. Plan shows Lunch as `logged`.
5. Log tab → delete that entry → Plan shows Lunch back at `planned`.
6. Plan a Dinner slot, then Skip it from the Calculator → Plan shows `skipped`; on a second device (or the web app) it is skipped too.
7. Plan another slot and Dismiss it in the Calculator → the line is gone on this phone, still offered in the web app.
8. Turn on Airplane Mode, plan a slot, load it, log it, then go back online → everything syncs with no rejections in Settings → Sync.

Expected: every step behaves as described. Anything that fails here is a bug to fix on a follow-up branch; do not edit `main` directly.

---

## Notes for the implementer

- **Only the device can verify**: VoiceOver actually reading the goal labels, the swipe actions and sheets feeling right on a phone, `UserDefaults` dismissals surviving app restarts inside LiveContainer, and the Airplane-Mode sync walk-through. Everything else is covered by the Linux/macOS test suites and the CI builds.
- **Never compute carbs or doses in a view.** Every number on these screens comes from `CarbBookCore` (`itemCarbs`, `sumCarbs`, `goalStatus`, `dayGoal`, `evaluateCalculator`) or from `PlanEditing`.
- **Fractions belong in amount fields only.** `PlanItemRow` uses `AmountInput`/`NumberParsing.parseAmount`; the goal min/max fields in dose settings are decimal-only (`DoseSettingsInput.decimal`), like every other settings field.
