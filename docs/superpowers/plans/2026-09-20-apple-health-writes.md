# Apple Health Writes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Logging a meal on the iPhone writes that meal's carbs, and the insulin actually taken, to Apple Health.

**Architecture:** The rules ("which samples does this log entry produce?") live in `CarbBookKit` as pure Swift with no HealthKit import, so they run in the Linux test suite. A thin `HealthWriter` in the app target converts those values into `HKQuantitySample`s, owns authorization, and remembers which entries it already wrote so a re-save cannot duplicate them. A Health failure is reported, never thrown: the CarbBook log is the record of truth.

**Tech Stack:** Swift 5.9 / iOS 17, HealthKit, GRDB (existing local store), XCTest run on Linux via `ios/scripts/swift-test.sh`, Xcode build on GitHub CI (`build-ipa.yml`).

**Spec:** `docs/superpowers/specs/2026-09-20-health-and-plan-week-design.md` §1.

---

### Task 0: Feasibility gate — prove HealthKit works inside LiveContainer

CarbBook runs as a LiveContainer guest and inherits **LiveContainer's** entitlements, not its own. If the installed LiveContainer was signed without `com.apple.developer.healthkit`, everything below is dead code and the fallback is the Shortcuts bridge in the spec. Prove it before writing the feature.

**Files:**
- Modify: `ios/project.yml` (Info.plist usage string)
- Create (temporary, deleted in Task 6): `ios/CarbBook/Health/HealthProbe.swift`
- Modify (temporary): `ios/CarbBook/Settings/SettingsView.swift`

- [ ] **Step 1: Add the Health usage string to the Info.plist keys**

In `ios/project.yml`, under `targets.CarbBook.settings.base`, next to the existing `INFOPLIST_KEY_NSCameraUsageDescription` line, add:

```yaml
        INFOPLIST_KEY_NSHealthUpdateUsageDescription: "CarbBook adds the carbs you log, and the insulin you record taking, to Apple Health."
```

iOS terminates the app on a HealthKit authorization request with no usage string, so this is required even for the probe.

- [ ] **Step 2: Write the probe**

Create `ios/CarbBook/Health/HealthProbe.swift`:

```swift
import HealthKit

/// Temporary: proves a LiveContainer guest can reach HealthKit at all (spec §1, feasibility gate).
/// Deleted in Task 6 once HealthWriter replaces it.
enum HealthProbe {
    static func run() async -> String {
        guard HKHealthStore.isHealthDataAvailable() else { return "Health data is not available on this device." }
        let store = HKHealthStore()
        let carbs = HKQuantityType(.dietaryCarbohydrates)
        do {
            try await store.requestAuthorization(toShare: [carbs], read: [])
        } catch {
            return "Authorization failed: \(error.localizedDescription)"
        }
        let sample = HKQuantitySample(type: carbs,
                                      quantity: HKQuantity(unit: .gram(), doubleValue: 1),
                                      start: Date(), end: Date())
        do {
            try await store.save(sample)
            return "Wrote a 1 g test sample. Check Health › Browse › Nutrition › Carbohydrates."
        } catch {
            return "Write failed: \(error.localizedDescription)"
        }
    }
}
```

- [ ] **Step 3: Add a temporary Settings row that runs it**

In `ios/CarbBook/Settings/SettingsView.swift`, add a `@State private var probeResult = ""` to the view and this section immediately after the existing `Section("Images")` block:

```swift
                Section("Health probe (temporary)") {
                    Button("Run Health probe") {
                        Task { probeResult = await HealthProbe.run() }
                    }
                    if !probeResult.isEmpty { Text(probeResult).font(.footnote).foregroundStyle(.secondary) }
                }
```

- [ ] **Step 4: Build an .ipa**

Run: `gh workflow run build-ipa.yml --ref <branch>` then `gh run watch <id> --exit-status`
Expected: the `build` job passes and attaches the `CarbBook-ipa` artifact.

- [ ] **Step 5: Sideload and run the probe on the phone**

Install the artifact into LiveContainer, open Settings, tap "Run Health probe".
Expected: the permission sheet appears, then "Wrote a 1 g test sample."

**STOP — this is a decision point.** If the sheet never appears, or the result says authorization or the write failed, HealthKit is unavailable to the guest: stop here, report it, and re-plan against the Shortcuts bridge. Do not continue to Task 1.

- [ ] **Step 6: Commit the probe**

```bash
git add ios/project.yml ios/CarbBook/Health/HealthProbe.swift ios/CarbBook/Settings/SettingsView.swift
git commit -m "ios: probe HealthKit availability under LiveContainer"
```

---

### Task 1: `HealthSample` and the rules that build it

**Files:**
- Create: `ios/CarbBookKit/Sources/CarbBookKit/HealthSamples.swift`
- Test: `ios/CarbBookKit/Tests/CarbBookKitTests/HealthSamplesTests.swift`

- [ ] **Step 1: Write the failing test**

Create `ios/CarbBookKit/Tests/CarbBookKitTests/HealthSamplesTests.swift`:

```swift
import CarbBookCore
@testable import CarbBookKit
import XCTest

final class HealthSamplesTests: XCTestCase {
    private func entry(carbs: Double, taken: Double?, id: String = "e1", at: Int64 = 1_700_000_000_000) -> LogEntryData {
        LogEntryData(id: id, eatenAt: at, windowName: "Lunch", bgMgdl: nil, bgSource: "none", bgTrend: nil,
                     totalCarbsG: carbs, suggestedUnits: 6, takenUnits: taken, settingsVersionId: nil, notes: nil)
    }

    func testCarbsAndBolus() {
        let samples = healthSamples(for: entry(carbs: 48, taken: 6))
        XCTAssertEqual(samples, [
            HealthSample(kind: .carbohydrates, value: 48, at: 1_700_000_000_000, externalId: "e1"),
            HealthSample(kind: .insulinBolus, value: 6, at: 1_700_000_000_000, externalId: "e1"),
        ])
    }

    /// A blank taken dose writes carbs and no insulin: the estimate is never written, because Health
    /// must not record insulin that may not have been injected (spec §1).
    func testBlankTakenDoseWritesCarbsOnly() {
        XCTAssertEqual(healthSamples(for: entry(carbs: 30, taken: nil)).map(\.kind), [.carbohydrates])
    }

    /// A correction-only entry: insulin with no food.
    func testCorrectionOnlyWritesBolusOnly() {
        XCTAssertEqual(healthSamples(for: entry(carbs: 0, taken: 2)).map(\.kind), [.insulinBolus])
    }

    func testZeroesWriteNothing() {
        XCTAssertEqual(healthSamples(for: entry(carbs: 0, taken: 0)), [])
        XCTAssertEqual(healthSamples(for: entry(carbs: 0, taken: nil)), [])
    }

    /// Non-finite or negative numbers are data corruption, not a zero: they must never reach Health.
    func testNonFiniteAndNegativeValuesAreDropped() {
        XCTAssertEqual(healthSamples(for: entry(carbs: .nan, taken: 4)).map(\.kind), [.insulinBolus])
        XCTAssertEqual(healthSamples(for: entry(carbs: 20, taken: .infinity)).map(\.kind), [.carbohydrates])
        XCTAssertEqual(healthSamples(for: entry(carbs: -5, taken: -1)), [])
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `ios/scripts/swift-test.sh CarbBookKit --filter HealthSamplesTests`
Expected: FAIL — "cannot find 'healthSamples' in scope".

- [ ] **Step 3: Write the implementation**

Create `ios/CarbBookKit/Sources/CarbBookKit/HealthSamples.swift`:

```swift
import CarbBookCore
import Foundation

/// One Apple Health sample a log entry produces. Deliberately free of HealthKit types: this file
/// compiles and is tested on Linux, and the app's HealthWriter does the HKQuantitySample conversion.
public struct HealthSample: Equatable, Sendable {
    public enum Kind: Equatable, Sendable {
        /// Dietary carbohydrates, grams.
        case carbohydrates
        /// Insulin delivery, international units, reason = bolus.
        case insulinBolus
    }
    public var kind: Kind
    public var value: Double
    /// Milliseconds since the epoch; the sample's start and end are both this instant.
    public var at: Int64
    /// The log entry's id, carried into HKMetadataKeyExternalUUID.
    public var externalId: String

    public init(kind: Kind, value: Double, at: Int64, externalId: String) {
        self.kind = kind; self.value = value; self.at = at; self.externalId = externalId
    }
}

/// The samples a saved log entry should add to Apple Health (spec §1).
///
/// Only the *taken* dose is ever written: the suggested estimate is a recommendation, and Health
/// must not record insulin that may not have been injected. Zero, missing, negative and non-finite
/// values produce no sample rather than a zero one — a zero carb sample is a lie about the meal,
/// and a NaN would be rejected by HealthKit anyway.
public func healthSamples(for entry: LogEntryData) -> [HealthSample] {
    var samples: [HealthSample] = []
    if entry.totalCarbsG.isFinite, entry.totalCarbsG > 0 {
        samples.append(HealthSample(kind: .carbohydrates, value: entry.totalCarbsG, at: entry.eatenAt, externalId: entry.id))
    }
    if let taken = entry.takenUnits, taken.isFinite, taken > 0 {
        samples.append(HealthSample(kind: .insulinBolus, value: taken, at: entry.eatenAt, externalId: entry.id))
    }
    return samples
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `ios/scripts/swift-test.sh CarbBookKit --filter HealthSamplesTests`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add ios/CarbBookKit/Sources/CarbBookKit/HealthSamples.swift ios/CarbBookKit/Tests/CarbBookKitTests/HealthSamplesTests.swift
git commit -m "kit: derive Apple Health samples from a log entry"
```

---

### Task 2: The written-entry ledger

Stops a re-saved entry from writing its samples twice. Pure logic over a string set so it is testable; the app supplies `UserDefaults` as the backing store.

**Files:**
- Create: `ios/CarbBookKit/Sources/CarbBookKit/HealthLedger.swift`
- Test: `ios/CarbBookKit/Tests/CarbBookKitTests/HealthLedgerTests.swift`

- [ ] **Step 1: Write the failing test**

Create `ios/CarbBookKit/Tests/CarbBookKitTests/HealthLedgerTests.swift`:

```swift
@testable import CarbBookKit
import XCTest

final class HealthLedgerTests: XCTestCase {
    func testRecordsAndRecognisesWrittenEntries() {
        var stored: [String] = []
        let ledger = HealthLedger(load: { stored }, store: { stored = $0 })
        XCTAssertFalse(ledger.wasWritten("e1"))
        ledger.markWritten("e1")
        XCTAssertTrue(ledger.wasWritten("e1"))
        XCTAssertFalse(ledger.wasWritten("e2"))
    }

    /// The ledger is unbounded otherwise: one id per logged meal, forever. Oldest ids fall off,
    /// because an entry old enough to be evicted is long past being re-saved.
    func testKeepsAtMostFiveHundredIdsNewestLast() {
        var stored: [String] = []
        let ledger = HealthLedger(load: { stored }, store: { stored = $0 })
        for index in 0..<520 { ledger.markWritten("e\(index)") }
        XCTAssertEqual(stored.count, 500)
        XCTAssertEqual(stored.first, "e20")
        XCTAssertEqual(stored.last, "e519")
        XCTAssertFalse(ledger.wasWritten("e0"))
        XCTAssertTrue(ledger.wasWritten("e519"))
    }

    func testMarkingTwiceDoesNotDuplicate() {
        var stored: [String] = []
        let ledger = HealthLedger(load: { stored }, store: { stored = $0 })
        ledger.markWritten("e1")
        ledger.markWritten("e1")
        XCTAssertEqual(stored, ["e1"])
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `ios/scripts/swift-test.sh CarbBookKit --filter HealthLedgerTests`
Expected: FAIL — "cannot find 'HealthLedger' in scope".

- [ ] **Step 3: Write the implementation**

Create `ios/CarbBookKit/Sources/CarbBookKit/HealthLedger.swift`:

```swift
import Foundation

/// Remembers which log entries have already been written to Apple Health, so re-saving an entry
/// cannot duplicate its samples (spec §1, "write once at save time").
///
/// Backed by an injected load/store pair rather than UserDefaults directly, so the rules are
/// testable on Linux. Order is oldest-first; the cap keeps the list from growing without bound.
public struct HealthLedger {
    public static let limit = 500

    private let load: () -> [String]
    private let store: ([String]) -> Void

    public init(load: @escaping () -> [String], store: @escaping ([String]) -> Void) {
        self.load = load
        self.store = store
    }

    public func wasWritten(_ id: String) -> Bool { load().contains(id) }

    public func markWritten(_ id: String) {
        var ids = load()
        guard !ids.contains(id) else { return }
        ids.append(id)
        if ids.count > Self.limit { ids.removeFirst(ids.count - Self.limit) }
        store(ids)
    }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `ios/scripts/swift-test.sh CarbBookKit --filter HealthLedgerTests`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add ios/CarbBookKit/Sources/CarbBookKit/HealthLedger.swift ios/CarbBookKit/Tests/CarbBookKitTests/HealthLedgerTests.swift
git commit -m "kit: remember which entries already reached Apple Health"
```

---

### Task 3: `HealthWriter` — the HealthKit adapter

**Files:**
- Create: `ios/CarbBook/Health/HealthWriter.swift`

No test: this file is the untestable boundary (HealthKit is unavailable on Linux and needs a device). It holds no rules — every decision is in Tasks 1 and 2. It is verified on-device in Task 6.

- [ ] **Step 1: Write the writer**

Create `ios/CarbBook/Health/HealthWriter.swift`:

```swift
import CarbBookCore
import CarbBookKit
import Foundation
import HealthKit

/// Writes a saved log entry's carbs and taken insulin to Apple Health (spec §1).
///
/// Everything here is mechanism: which samples exist is `healthSamples(for:)`, and whether an entry
/// was already written is `HealthLedger`. A failure is recorded in `lastStatus` and never thrown to
/// the caller — the CarbBook log is the record of truth, and a Health problem must not fail a save.
@MainActor
@Observable
final class HealthWriter {
    /// The Settings switch. Off by default: writing to Health is opt-in.
    private(set) var enabled: Bool
    /// One line describing the last attempt, shown under the Settings switch.
    private(set) var lastStatus: String?

    private let store = HKHealthStore()
    private let defaults: UserDefaults
    private let ledger: HealthLedger

    private static let enabledKey = "health.writeEnabled"
    private static let ledgerKey = "health.writtenEntryIds"
    private static let statusKey = "health.lastStatus"

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        enabled = defaults.bool(forKey: Self.enabledKey)
        lastStatus = defaults.string(forKey: Self.statusKey)
        ledger = HealthLedger(
            load: { defaults.stringArray(forKey: Self.ledgerKey) ?? [] },
            store: { defaults.set($0, forKey: Self.ledgerKey) })
    }

    var isAvailable: Bool { HKHealthStore.isHealthDataAvailable() }

    private var types: Set<HKSampleType> { [HKQuantityType(.dietaryCarbohydrates), HKQuantityType(.insulinDelivery)] }

    /// Turning the switch on asks for authorization first; a refusal leaves the switch off, so the
    /// UI never claims to be writing when it cannot.
    func setEnabled(_ on: Bool) async {
        guard on else {
            enabled = false
            defaults.set(false, forKey: Self.enabledKey)
            return
        }
        guard isAvailable else {
            record("Apple Health is not available on this device.")
            return
        }
        do {
            try await store.requestAuthorization(toShare: types, read: [])
            enabled = true
            defaults.set(true, forKey: Self.enabledKey)
            record("Health writing is on. New entries will be added as you log them.")
        } catch {
            record("Health permission was not granted: \(error.localizedDescription)")
        }
    }

    /// Called after a log entry is saved. Silent and cheap when the feature is off.
    func write(_ entry: LogEntryData) async {
        guard enabled, isAvailable else { return }
        guard !ledger.wasWritten(entry.id) else { return }
        let samples = healthSamples(for: entry).map(hkSample)
        guard !samples.isEmpty else { return }
        do {
            try await store.save(samples)
            ledger.markWritten(entry.id)
            record("Last write: \(describe(samples.count)) at \(Date().formatted(date: .omitted, time: .shortened)).")
        } catch {
            record("Last write failed: \(error.localizedDescription)")
        }
    }

    private func hkSample(_ sample: HealthSample) -> HKQuantitySample {
        let at = Date(timeIntervalSince1970: Double(sample.at) / 1000)
        var metadata: [String: Any] = [HKMetadataKeyExternalUUID: sample.externalId]
        let type: HKQuantityType
        let quantity: HKQuantity
        switch sample.kind {
        case .carbohydrates:
            type = HKQuantityType(.dietaryCarbohydrates)
            quantity = HKQuantity(unit: .gram(), doubleValue: sample.value)
        case .insulinBolus:
            type = HKQuantityType(.insulinDelivery)
            quantity = HKQuantity(unit: .internationalUnit(), doubleValue: sample.value)
            metadata[HKMetadataKeyInsulinDeliveryReason] = HKInsulinDeliveryReason.bolus.rawValue
        }
        return HKQuantitySample(type: type, quantity: quantity, start: at, end: at, metadata: metadata)
    }

    private func describe(_ count: Int) -> String { count == 1 ? "1 sample" : "\(count) samples" }

    private func record(_ status: String) {
        lastStatus = status
        defaults.set(status, forKey: Self.statusKey)
    }
}
```

- [ ] **Step 2: Hold the writer on `AppModel`**

In `ios/CarbBook/App/AppModel.swift`, add a stored property next to the other services:

```swift
    let health = HealthWriter()
```

- [ ] **Step 3: Commit**

```bash
git add ios/CarbBook/Health/HealthWriter.swift ios/CarbBook/App/AppModel.swift
git commit -m "ios: add the HealthKit writer behind an off-by-default switch"
```

---

### Task 4: Write on log, and the Settings switch

**Files:**
- Modify: `ios/CarbBook/Calculator/CalculatorModel.swift:245-280` (`logIt`)
- Modify: `ios/CarbBook/Settings/SettingsView.swift`

- [ ] **Step 1: Hand the saved entry to the writer**

In `CalculatorModel.logIt`, immediately after the existing `try app.save(changes)` line and before the `message = "Logged …"` line, add:

```swift
        // Apple Health (spec §1): fire-and-forget, after the save has succeeded. A Health failure
        // must never fail or delay the log itself, so this is not awaited and cannot throw.
        let savedEntry = records.entry
        Task { await app.health.write(savedEntry) }
```

- [ ] **Step 2: Add the Settings section**

In `ios/CarbBook/Settings/SettingsView.swift`, replace the temporary `Section("Health probe (temporary)")` block added in Task 0 with:

```swift
                Section("Apple Health") {
                    Toggle("Write to Apple Health", isOn: Binding(
                        get: { app.health.enabled },
                        set: { on in Task { await app.health.setEnabled(on) } }))
                    .disabled(!app.health.isAvailable)
                    Text(app.health.isAvailable
                         ? "Carbs and the insulin you record taking are added when you log a meal on this iPhone."
                         : "Apple Health is not available on this device.")
                        .font(.footnote).foregroundStyle(.secondary)
                    if let status = app.health.lastStatus {
                        Text(status).font(.footnote).foregroundStyle(.secondary)
                    }
                }
```

- [ ] **Step 3: Delete the probe**

```bash
git rm ios/CarbBook/Health/HealthProbe.swift
```

Also remove the `@State private var probeResult = ""` line added to `SettingsView` in Task 0.

- [ ] **Step 4: Run the Kit suite to confirm nothing regressed**

Run: `ios/scripts/swift-test.sh CarbBookKit`
Expected: PASS, all tests (237 before this plan, +8 from Tasks 1–2).

- [ ] **Step 5: Commit**

```bash
git add ios/CarbBook/Calculator/CalculatorModel.swift ios/CarbBook/Settings/SettingsView.swift
git commit -m "ios: write a logged meal to Apple Health, with a Settings switch"
```

---

### Task 5: Compile the app target

**Files:** none changed; this is the macOS build that Linux tests cannot do.

- [ ] **Step 1: Open the PR so `build-ipa` runs**

```bash
git push -u origin <branch>
gh pr create --title "ios: write logged meals to Apple Health" --body "Implements docs/superpowers/specs/2026-09-20-health-and-plan-week-design.md §1."
```

- [ ] **Step 2: Watch the build**

Run: `gh run list --branch <branch> --limit 3` then `gh run watch <build-ipa id> --exit-status`
Expected: `build` completes successfully. SwiftUI and HealthKit errors surface only here — a passing Linux suite proves nothing about the app target.

---

### Task 6: On-device verification

**Files:** none.

- [ ] **Step 1: Install the built .ipa into LiveContainer**

- [ ] **Step 2: Turn the switch on**

Settings › Apple Health › "Write to Apple Health".
Expected: the Health permission sheet lists Carbohydrates and Insulin Delivery; after allowing, the status line reads "Health writing is on."

- [ ] **Step 3: Log a real meal with a taken dose**

Expected: Health › Browse › Nutrition › Carbohydrates shows the grams at the meal's time, and Health › Browse › Body › Insulin Delivery shows the units, marked as a bolus.

- [ ] **Step 4: Check the no-insulin case**

Log an entry leaving "Taken (units)" blank.
Expected: carbs appear in Health; no insulin sample is added.

- [ ] **Step 5: Check the no-duplicate rule**

Open the entry from step 3 in the log and save it again.
Expected: Health still shows exactly one carb sample and one insulin sample for that meal.

- [ ] **Step 6: Report the results**

Report what appeared in Health for each step. If step 3 shows nothing while the status line claims success, stop and investigate before shipping — a silent no-op is the failure mode this feature is most likely to have.


---

## Status

Tasks 1-4 done 2026-09-23 on `main`, 250 CarbBookKit tests green.

Task 0 (the LiveContainer feasibility gate) was **never run and is now moot**: CarbBook is sideloaded
as itself rather than as a LiveContainer guest, so it carries its own entitlements. The probe branch
`feat/apple-health-writes` and the hub's throwaway "CarbBook (Health probe)" app are both obsolete.
`ios/CarbBook.entitlements` + `CODE_SIGN_ENTITLEMENTS` replace that gate: the App ID used to sign
must have the HealthKit capability, which a free Apple ID cannot grant.

Task 5 (app-target compile) is `release.yml` on the push. Task 6 (on-device verification) is still
open and needs the phone — the failure mode to watch for is a status line claiming success while
Health shows nothing.
