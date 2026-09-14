# CarbBook iOS Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `ios/CarbBookCore`, a Foundation-only Swift package that mirrors `packages/core` exactly (units, carbs, dose estimate, `formatBreakdown`, LWW sync) and adds the pure client logic the iOS app needs (sync engine, calculator, log recalculation, dose-settings validation, USDA/Open Food Facts record builders), validated by XCTest running the same `testdata/*.json` vectors as Vitest.

**Architecture:** One SwiftPM library with no dependencies. Types mirror `types.ts` with the §3 column names as coding keys, so the same structs decode test vectors and sync records. JavaScript semantics the TS core leans on (`toFixed` tie rounding, `String(number)`, UTF-16 string ordering) are reproduced in `JS` helpers so outputs match byte for byte. The sync engine talks to two protocols (`SyncStore`, `SyncTransport`); the app plan implements them with GRDB and URLSession, while tests here use in-memory actors. Because nothing imports Apple-only frameworks, `swift test` runs on Linux (Docker on this machine, a container job in CI) and on the macOS runner.

**Tech Stack:** Swift tools 6.0 (verified with Swift 6.3.3 on Linux; CI macOS uses Xcode 26.6), XCTest, Foundation. Docker image `swift:6.3.3-noble` for local runs.

**Spec:** `docs/superpowers/specs/2026-09-13-carbbook-design.md` §3 (types), §4 (core logic), §5 (sync rules), §6 (USDA copy, barcode), §8 (calculator/log/settings behaviour), §10 (shared vectors). **TS source mirrored:** `packages/core/src/{units,carbs,dose,sync,types}.ts` including the uncommitted `activeSettings` deleted-row fix on `feat/server`. **Wire contract:** `docs/superpowers/plans/2026-09-14-carbbook-server-data.md` ("Wire formats"). **Second plan:** `docs/superpowers/plans/2026-09-14-carbbook-ios-app.md` (GRDB store, API client, USDA bundle, screens, CI/release), which depends on this one.

**Branch:** `feat/ios`, branched from `feat/server` once the core `activeSettings` fix is committed (the Swift port and the vectors must match that tree).

---

## Verified facts this plan relies on (2026-09-14)

- **No Swift toolchain on this machine** (`which swift` → not found). Docker 29.7.2 is installed. Every file in this plan was written out and run in `swift:6.3.3-noble` (x86_64 Linux): **57 tests, 0 failures**, no warnings. Output format: `Executed 57 tests, with 0 failures (0 unexpected) in 0.69 (0.69) seconds`.
- In Docker, run as the calling user with `HOME=/tmp` and a separate `--scratch-path`; running as root leaves a root-owned `.build` that later non-root runs cannot write (`attempt to write a readonly database`). `ios/scripts/swift-test.sh` does this.
- GitHub runner images: `macos-latest` = `macos-26` (arm64), default **Xcode 26.6**, iOS SDK 26.5 (simulators 26.0–26.5); Xcode 26.0.1–26.6 installed. `swift:6.3.3-noble` exists on Docker Hub.
- Latest releases: **GRDB.swift v7.11.1** (2026-06-18, `swift-tools-version:6.1`, iOS 13+, defines `SQLITE_ENABLE_FTS5`); **XcodeGen 2.46.0** (2026-07-16). Used by the app plan.
- JS semantics reproduced: `Number.prototype.toFixed` picks the larger candidate on exact binary ties (`(2.5).toFixed(0)` = `"3"`, `(0.125).toFixed(2)` = `"0.13"`) while printf rounds ties to even; JS string `<`/`>` compare UTF-16 code units while Swift compares Unicode scalars (`"\u{FF61}" > "\u{1F600}"` in JS, `<` in Swift). Tests pin both.
- `SingleValueDecodingContainer.decodeNil()` is non-throwing (a `try` triggers a warning).
- Contract updates from `feat/server` review (2026-09-14): `activeSettings` skips `deleted === 1` rows; `/api/bg` readings more than 2 min in the future or more than 15 min old are not auto-used; dose settings are append-only (owner creates new versions, never edits/deletes); cookie mutations need `Content-Type: application/json` (the app sends JSON bodies anyway).

## Decisions and open questions for the owner

1. **Deployment target iOS 17.0** (VisionKit `DataScannerViewController` needs 16.0; the app plan uses the Observation `@Observable` macro, which needs 17.0). Confirm the phone running LiveContainer is on iOS 17 or later.
2. Enum-like columns (`source`, `kind`, `mode`, `bg_source`) are `String` in Swift, not enums, so bad stored values produce the TS core's refusals/incomplete results instead of decode failures. `ref_type` is an enum because the server rejects anything else.
3. `DoseInput.minutes` is `Int`, so TS's "non-integer minutes → `invalid_input`" case is enforced by the type and has no Swift test.
4. Two unreachable-through-`estimateDose` differences: `pickWindow` sorts an unparseable start as 00:00 instead of throwing, and `correctionUnits` returns 0 for an unknown mode (TS returns `undefined`). `estimateDose` refuses both first with `invalid_settings`.
5. **Pull merge rule:** a pulled record overwrites the local row unless the local row has an unpushed change that beats it under LWW (then the local change is kept and pushed next time). Exact version matches clear the pending mark.
6. **Rejected pushes** (`invalid`/`forbidden`/`cycle`/`unknown_table`) are stored for Settings → Sync and removed from the pending queue; the local row is kept. A later edit re-queues it. Alternative: revert the row on the next pull. Confirm.
7. **Log recalculation** refreshes item names and carbs from the current catalog, the entry total, and `suggested_units` using the entry's own settings version and window (falling back to the version active at `eaten_at`). `taken_units`, BG and time are never changed.
8. **Create food from label** refuses carbs greater than the serving weight (core treats `carbs_per_100g > 100` as invalid).
9. Refusal messages (`DoseRefusal.message`) are iOS-only wording; reason codes match TS. The web plan may want the same strings.
10. SwiftPM resources must live inside the package, so the vectors are **copied** into the test bundle by `ios/scripts/sync-testdata.sh`; CI's `testdata-copies` job fails if they drift from `testdata/`.
11. The repo is private: GitHub bills macOS runner minutes at a multiple of Linux minutes against the included quota (10x under the pricing published through 2025; verify the current rate). That is why Linux runs every push and macOS runs on main/PRs only.

---

## File structure

```
ios/.gitignore                                        .build*, generated .xcodeproj, build/
ios/docker/Dockerfile                                 swift:6.3.3-noble + libsqlite3-dev
ios/scripts/swift-test.sh                             swift test natively or in Docker
ios/scripts/sync-testdata.sh                          copy/check shared vectors into the test bundle
.github/workflows/ios-tests.yml                       testdata check, Linux + macOS swift test
ios/CarbBookCore/Package.swift                        library CarbBookCore, test target with Resources
ios/CarbBookCore/Sources/CarbBookCore/
  CarbBookCore.swift                                  version marker
  JSCompat.swift                                      JS string order, toFixed, String(number)
  JSONValue.swift                                     Codable JSON value for sync records
  Types.swift                                         FoodData … DoseSettingsData, LogEntryData, LogItemData
  Units.swift                                         units.ts
  Carbs.swift                                         carbs.ts (Catalog, InMemoryCatalog, itemCarbs, cycles)
  Dose.swift                                          parseHHMM, pickWindow, correction, rounding, activeSettings, recent dose
  Estimate.swift                                      estimateDose + validation, refusals, formatBreakdown
  Sync.swift                                          isNewer, shouldApplyPulled, push/pull wire types
  UUIDv7.swift                                        time-ordered ids
  SyncEngine.swift                                    SyncStore/SyncTransport protocols, push-then-pull engine
  Search.swift                                        toFtsQuery, barcodeCandidates
  FoodBuilders.swift                                  label math, USDA copy, OFF draft → records
  Calculator.swift                                    calculator evaluation, BG freshness, log/meal record builders
  DoseSettingsDraft.swift                             server-equivalent dose settings validation, new version
  LogRecalc.swift                                     "Recalculate from current meal"
ios/CarbBookCore/Tests/CarbBookCoreTests/
  Resources/{units,dose}-vectors.json                 copies of testdata/
  *Tests.swift                                        one file per task
```

## Running tests

All run commands use `ios/scripts/swift-test.sh CarbBookCore [--filter <TestClass>]` from `~/Projects/CarbBook`. On this machine it builds the Docker image once (about 1 GB pull) and runs in a container; on a Mac with Xcode it runs `swift test` directly. CI runs the same package with plain `swift test`. The first failing run of each task fails at **compile time** (the symbol does not exist yet), which is the expected RED state for Swift.

---

### Task 1: Package scaffold, test runner and CI

**Files:**
- Create: `ios/.gitignore`, `ios/docker/Dockerfile`, `ios/scripts/swift-test.sh`, `ios/scripts/sync-testdata.sh`
- Create: `ios/CarbBookCore/Package.swift`, `ios/CarbBookCore/Sources/CarbBookCore/CarbBookCore.swift`
- Create: `.github/workflows/ios-tests.yml`
- Test: `ios/CarbBookCore/Tests/CarbBookCoreTests/SmokeTests.swift`

- [ ] **Step 1: Add the tooling files**

`ios/.gitignore`:
```gitignore
.build/
.build-linux/
*.xcodeproj/
build/
DerivedData/
```

`ios/docker/Dockerfile`:
```dockerfile
# Linux Swift toolchain for running package tests on machines without Xcode.
# libsqlite3-dev is for CarbBookKit (GRDB); CarbBookCore needs nothing beyond the base image.
FROM swift:6.3.3-noble
RUN apt-get update \
 && apt-get install -y --no-install-recommends libsqlite3-dev \
 && rm -rf /var/lib/apt/lists/*
```

`ios/scripts/swift-test.sh`:
```bash
#!/usr/bin/env bash
# Runs `swift test` for one package under ios/: natively when a Swift toolchain is on PATH,
# otherwise inside Docker (image built from ios/docker/Dockerfile on first use).
#
# Usage: ios/scripts/swift-test.sh <CarbBookCore|CarbBookKit> [swift test args...]
set -euo pipefail
ios="$(cd "$(dirname "$0")/.." && pwd)"
pkg="${1:?usage: swift-test.sh <package> [args...]}"
shift
if command -v swift >/dev/null 2>&1; then
  cd "$ios/$pkg"
  exec swift test "$@"
fi
image="${CARBBOOK_SWIFT_IMAGE:-carbbook-swift:6.3.3}"
if ! docker image inspect "$image" >/dev/null 2>&1; then
  docker build -q -t "$image" "$ios/docker" >/dev/null
fi
# Run as the calling user so .build-linux stays writable; HOME=/tmp gives SwiftPM a cache dir.
exec docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$ios:/ios" -w "/ios/$pkg" "$image" \
  swift test --scratch-path "/ios/$pkg/.build-linux" "$@"
```

`ios/scripts/sync-testdata.sh`:
```bash
#!/usr/bin/env bash
# SwiftPM test resources must live inside the package, so the shared vectors in testdata/ are
# copied into the CarbBookCore test bundle. `--check` fails (for CI) if the copies drifted.
#
# Usage: ios/scripts/sync-testdata.sh [--check]
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
dest="$root/ios/CarbBookCore/Tests/CarbBookCoreTests/Resources"
mkdir -p "$dest"
for name in units-vectors.json dose-vectors.json; do
  if [[ "${1:-}" == "--check" ]]; then
    if ! cmp -s "$root/testdata/$name" "$dest/$name"; then
      echo "error: $dest/$name differs from testdata/$name; run ios/scripts/sync-testdata.sh" >&2
      exit 1
    fi
  else
    cp "$root/testdata/$name" "$dest/$name"
  fi
done
echo "testdata vectors in sync"
```

Run: `cd ~/Projects/CarbBook && chmod +x ios/scripts/*.sh && ios/scripts/sync-testdata.sh && ios/scripts/sync-testdata.sh --check`
Expected: `testdata vectors in sync` printed twice; `ios/CarbBookCore/Tests/CarbBookCoreTests/Resources/` holds both JSON files.

- [ ] **Step 2: Write the package manifest and the failing smoke test**

`ios/CarbBookCore/Package.swift`:
```swift
// swift-tools-version: 6.0
import PackageDescription

// Pure CarbBook logic. Foundation only, so `swift test` runs on macOS and Linux alike.
let package = Package(
    name: "CarbBookCore",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "CarbBookCore", targets: ["CarbBookCore"]),
    ],
    targets: [
        .target(name: "CarbBookCore"),
        .testTarget(
            name: "CarbBookCoreTests",
            dependencies: ["CarbBookCore"],
            resources: [.copy("Resources")]
        ),
    ]
)
```

`ios/CarbBookCore/Tests/CarbBookCoreTests/SmokeTests.swift`:
```swift
import XCTest
@testable import CarbBookCore

final class SmokeTests: XCTestCase {
    func testVersion() {
        XCTAssertEqual(CarbBookCore.version, "0.1.0")
    }
}
```

- [ ] **Step 3: Run it to verify it fails**

Run: `ios/scripts/swift-test.sh CarbBookCore --filter SmokeTests`
Expected: FAIL. SwiftPM reports that target `CarbBookCore` has no source files (`Sources/CarbBookCore` does not exist yet).

- [ ] **Step 4: Add the version marker**

`ios/CarbBookCore/Sources/CarbBookCore/CarbBookCore.swift`:
```swift
/// CarbBook shared logic, mirrored from packages/core (TypeScript).
public enum CarbBookCore {
    public static let version = "0.1.0"
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `ios/scripts/swift-test.sh CarbBookCore --filter SmokeTests`
Expected: `Executed 1 test, with 0 failures (0 unexpected)`.

- [ ] **Step 6: Add the CI workflow**

`.github/workflows/ios-tests.yml`:
```yaml
name: ios-tests

# Swift package tests. Linux jobs run on every relevant push (cheap); the macOS job runs on
# main, pull requests and manual runs only, because macOS minutes are expensive on a private repo.
on:
  push:
    paths:
      - 'ios/CarbBookCore/**'
      - 'ios/scripts/**'
      - 'ios/docker/**'
      - 'testdata/**'
      - '.github/workflows/ios-tests.yml'
  pull_request:
    paths:
      - 'ios/CarbBookCore/**'
      - 'ios/scripts/**'
      - 'ios/docker/**'
      - 'testdata/**'
      - '.github/workflows/ios-tests.yml'
  workflow_dispatch:

jobs:
  testdata-copies:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: ios/scripts/sync-testdata.sh --check

  core-linux:
    runs-on: ubuntu-latest
    container: swift:6.3.3-noble
    steps:
      - uses: actions/checkout@v4
      - name: swift test (Linux, Foundation only)
        working-directory: ios/CarbBookCore
        run: swift test

  core-macos:
    if: github.event_name != 'push' || github.ref == 'refs/heads/main'
    runs-on: macos-26
    steps:
      - uses: actions/checkout@v4
      - name: Select Xcode 26.6
        run: |
          sudo xcode-select -s /Applications/Xcode_26.6.app
          xcodebuild -version
      - name: swift test (macOS)
        working-directory: ios/CarbBookCore
        run: swift test
```

Run: `cd ~/Projects/CarbBook && python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ios-tests.yml')); print('yaml ok')"`
Expected: `yaml ok`

- [ ] **Step 7: Commit**

```bash
cd ~/Projects/CarbBook
git add ios/.gitignore ios/docker/Dockerfile ios/scripts ios/CarbBookCore .github/workflows/ios-tests.yml
git commit -m "feat(ios-core): Swift package scaffold, Docker test runner and CI"
```

---

### Task 2: JavaScript-compatible formatting and string order

**Files:**
- Create: `ios/CarbBookCore/Sources/CarbBookCore/JSCompat.swift`
- Test: `ios/CarbBookCore/Tests/CarbBookCoreTests/JSCompatTests.swift`

The TS core formats the breakdown with `toFixed` and `String(number)` and breaks LWW / density / settings ties with JS string comparison. These helpers make the Swift port produce identical output.

- [ ] **Step 1: Write the failing test**

`ios/CarbBookCore/Tests/CarbBookCoreTests/JSCompatTests.swift`:
```swift
import XCTest
@testable import CarbBookCore

final class JSCompatTests: XCTestCase {
    func testStringOrderUsesUTF16CodeUnits() {
        // U+FF61 is one UTF-16 unit (0xFF61); U+1F600 is a surrogate pair starting 0xD83D.
        // JS: "｡" > "😀". Swift's own `<` says the opposite.
        XCTAssertTrue(JS.greater("\u{FF61}", "\u{1F600}"))
        XCTAssertTrue("\u{FF61}" < "\u{1F600}")
        XCTAssertTrue(JS.less("laptop", "phone"))
        XCTAssertFalse(JS.less("phone", "phone"))
        XCTAssertTrue(JS.less("a-cup", "b-cup"))
    }

    func testToFixedMatchesJavaScript() {
        XCTAssertEqual(JS.toFixed(9, 1), "9.0")
        XCTAssertEqual(JS.toFixed(9.9, 1), "9.9")
        XCTAssertEqual(JS.toFixed(2.5, 0), "3") // JS picks the larger on exact ties; printf would give "2"
        XCTAssertEqual(JS.toFixed(0.25, 1), "0.3")
        XCTAssertEqual(JS.toFixed(0.125, 2), "0.13")
        XCTAssertEqual(JS.toFixed(1.005, 2), "1.00") // 1.005 is really 1.00499999…
        XCTAssertEqual(JS.toFixed(-2.5, 0), "-3")
        XCTAssertEqual(JS.toFixed(-0.04, 1), "-0.0")
        XCTAssertEqual(JS.toFixed(10.5, 4), "10.5000")
    }

    func testNumberStringMatchesJavaScript() {
        XCTAssertEqual(JS.numberString(9), "9")
        XCTAssertEqual(JS.numberString(-0.0), "0")
        XCTAssertEqual(JS.numberString(79.2), "79.2")
        XCTAssertEqual(JS.numberString(0.1 + 0.2), "0.30000000000000004")
        XCTAssertEqual(JS.numberString(130), "130")
        XCTAssertEqual(JS.numberString(1e21), "1e+21")
        XCTAssertEqual(JS.numberString(1e16), "10000000000000000")
        XCTAssertEqual(JS.numberString(0.000001), "0.000001")
        XCTAssertEqual(JS.numberString(1.5e-7), "1.5e-7")
        XCTAssertEqual(JS.numberString(-2.25), "-2.25")
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `ios/scripts/swift-test.sh CarbBookCore --filter JSCompatTests`
Expected: build FAILS with `error: cannot find 'JS' in scope`.

- [ ] **Step 3: Implement**

`ios/CarbBookCore/Sources/CarbBookCore/JSCompat.swift`:
```swift
import Foundation

/// Helpers that reproduce JavaScript semantics the TypeScript core relies on, so both
/// implementations produce identical strings and identical tie-breaks.
public enum JS {
    /// JS `a < b` on strings: lexicographic order of UTF-16 code units (Swift's `<` compares
    /// Unicode scalars / canonical equivalence and disagrees for astral characters).
    public static func less(_ a: String, _ b: String) -> Bool {
        Array(a.utf16).lexicographicallyPrecedes(Array(b.utf16))
    }

    /// JS `a > b` on strings.
    public static func greater(_ a: String, _ b: String) -> Bool {
        less(b, a)
    }

    /// `Number.prototype.toFixed(digits)` for finite values with |x| < 1e21 and digits 0...20.
    /// JS picks the larger candidate on an exact tie; printf rounds ties to even, so exact
    /// ties are formatted from the next representable value above instead.
    public static func toFixed(_ x: Double, _ digits: Int) -> String {
        precondition(x.isFinite && abs(x) < 1e21 && (0...20).contains(digits), "toFixed domain")
        if x < 0 { return "-" + toFixed(-x, digits) }
        let value = x == 0 ? 0.0 : x // drops the sign of -0, as JS does
        let long = String(format: "%.\(digits + 25)f", value)
        let decimals = long.split(separator: ".").dropFirst().first.map(String.init) ?? ""
        let tail = decimals.dropFirst(digits)
        let isTie = tail.first == "5" && tail.dropFirst().allSatisfy { $0 == "0" }
        return String(format: "%.\(digits)f", isTie ? value.nextUp : value)
    }

    /// `String(n)` for a JS number: shortest round-trip digits, no trailing ".0",
    /// exponent notation only outside 1e-7 < |x| < 1e21.
    public static func numberString(_ x: Double) -> String {
        if x.isNaN { return "NaN" }
        if x.isInfinite { return x < 0 ? "-Infinity" : "Infinity" }
        if x == 0 { return "0" }
        if x < 0 { return "-" + numberString(-x) }
        // Swift's description is also shortest round-trip; only its layout differs.
        let description = x.description // "12.5", "1e-05", "1.5e+16"
        var mantissa = description
        var exponent = 0
        if let e = description.firstIndex(where: { $0 == "e" || $0 == "E" }) {
            mantissa = String(description[..<e])
            exponent = Int(description[description.index(after: e)...])!
        }
        let parts = mantissa.split(separator: ".", omittingEmptySubsequences: false)
        let intPart = String(parts[0])
        var fracPart = parts.count > 1 ? String(parts[1]) : ""
        while fracPart.hasSuffix("0") { fracPart.removeLast() }
        var digits = intPart + fracPart
        var pointIndex = intPart.count + exponent // position of the decimal point within digits
        while digits.hasPrefix("0") && digits.count > 1 {
            digits.removeFirst()
            pointIndex -= 1
        }
        // JS: n = pointIndex, k = digits.count
        let k = digits.count
        let n = pointIndex
        if k <= n && n <= 21 {
            return digits + String(repeating: "0", count: n - k)
        }
        if 0 < n && n <= 21 {
            let i = digits.index(digits.startIndex, offsetBy: n)
            return String(digits[..<i]) + "." + String(digits[i...])
        }
        if -6 < n && n <= 0 {
            return "0." + String(repeating: "0", count: -n) + digits
        }
        let e = n - 1
        let sign = e < 0 ? "-" : "+"
        let head = String(digits.prefix(1))
        let rest = String(digits.dropFirst())
        return (rest.isEmpty ? head : head + "." + rest) + "e" + sign + String(abs(e))
    }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `ios/scripts/swift-test.sh CarbBookCore --filter JSCompatTests`
Expected: `Executed 3 tests, with 0 failures (0 unexpected)` and no `warning:` lines for CarbBookCore sources.

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/CarbBook
git add ios/CarbBookCore/Sources/CarbBookCore/JSCompat.swift ios/CarbBookCore/Tests/CarbBookCoreTests/JSCompatTests.swift
git commit -m "feat(ios-core): JS-compatible toFixed, number strings and UTF-16 string order"
```

---

### Task 3: JSON values and domain types

**Files:**
- Create: `ios/CarbBookCore/Sources/CarbBookCore/JSONValue.swift`
- Create: `ios/CarbBookCore/Sources/CarbBookCore/Types.swift`
- Test: `ios/CarbBookCore/Tests/CarbBookCoreTests/TypesTests.swift`

`JSONValue` carries sync records whose shape depends on the table. Domain structs mirror `types.ts`; optional fields decode from missing or `null`, and `deleted` is optional because vectors omit it.

- [ ] **Step 1: Write the failing test**

`ios/CarbBookCore/Tests/CarbBookCoreTests/TypesTests.swift`:
```swift
import XCTest
@testable import CarbBookCore

final class TypesTests: XCTestCase {
    func testJSONValueDecodesEveryKind() throws {
        let json = #"{"a":null,"b":true,"c":1,"d":"x","e":[1.5],"f":{"g":false}}"#
        let value = try JSONDecoder().decode(JSONValue.self, from: Data(json.utf8))
        XCTAssertEqual(value, .object([
            "a": .null, "b": .bool(true), "c": .number(1), "d": .string("x"),
            "e": .array([.number(1.5)]), "f": .object(["g": .bool(false)]),
        ]))
        let roundTrip = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(value))
        XCTAssertEqual(roundTrip, value)
    }

    func testFoodDecodesColumnNamesAndMissingOptionals() throws {
        let json = #"{"id":"milk","name":"Milk","carbs_per_100g":4.8,"density_g_per_ml":1.03}"#
        let food = try JSONDecoder().decode(FoodData.self, from: Data(json.utf8))
        XCTAssertEqual(food, FoodData(id: "milk", name: "Milk", carbsPer100g: 4.8, densityGPerMl: 1.03))
        XCTAssertNil(food.deleted)
        let nullCarbs = try JSONDecoder().decode(FoodData.self, from: Data(#"{"id":"m","name":"M","carbs_per_100g":null}"#.utf8))
        XCTAssertNil(nullCarbs.carbsPer100g)
    }

    func testDoseSettingsRoundTripThroughJSONValue() throws {
        let settings = DoseSettingsData(
            id: "s1", effectiveFrom: 1_786_492_800_000,
            windows: [DoseWindow(name: "Breakfast", start: "05:00", ratioGPerUnit: 8)],
            correction: CorrectionRule(threshold: 200, step: 50, unitsPerStep: 1, mode: "started"),
            rounding: RoundingRule(increment: 1, roundDownBelowBg: 130)
        )
        let value = try JSONValue.from(settings)
        guard case .object(let object) = value else { return XCTFail("not an object") }
        XCTAssertEqual(object["effective_from"], .number(1_786_492_800_000))
        XCTAssertEqual(try value.decode(DoseSettingsData.self), settings)
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `ios/scripts/swift-test.sh CarbBookCore --filter TypesTests`
Expected: build FAILS with `error: cannot find 'JSONValue' in scope`.

- [ ] **Step 3: Implement**

`ios/CarbBookCore/Sources/CarbBookCore/JSONValue.swift`:
```swift
import Foundation

/// A JSON value, used for sync records whose shape depends on the table.
public enum JSONValue: Codable, Hashable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else {
            self = .object(try container.decode([String: JSONValue].self))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }

    public var stringValue: String? { if case .string(let v) = self { v } else { nil } }
    public var doubleValue: Double? { if case .number(let v) = self { v } else { nil } }
    public var int64Value: Int64? { doubleValue.map { Int64($0) } }

    /// Converts an Encodable value (e.g. `FoodData`) to JSON. Optional nils are omitted by
    /// synthesized Codable, so callers that need explicit nulls add them afterwards.
    public static func from<T: Encodable>(_ value: T) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(value))
    }

    /// Decodes a Decodable value from this JSON value.
    public func decode<T: Decodable>(_ type: T.Type) throws -> T {
        try JSONDecoder().decode(T.self, from: JSONEncoder().encode(self))
    }
}
```

`ios/CarbBookCore/Sources/CarbBookCore/Types.swift`:
```swift
import Foundation

/// Mirrors packages/core/src/types.ts. Property names are Swift-cased; coding keys are the
/// §3 column names so the same structs decode test vectors and sync records.
public typealias Id = String

public struct FoodData: Codable, Equatable, Sendable {
    public var id: Id
    public var name: String
    public var brand: String?
    public var source: String?
    public var sourceRef: String?
    public var derivedFrom: Id?
    public var carbsPer100g: Double?
    public var fiberPer100g: Double?
    public var densityGPerMl: Double?
    public var notes: String?
    public var deleted: Int?

    public init(id: Id, name: String, brand: String? = nil, source: String? = nil, sourceRef: String? = nil,
                derivedFrom: Id? = nil, carbsPer100g: Double?, fiberPer100g: Double? = nil,
                densityGPerMl: Double? = nil, notes: String? = nil, deleted: Int? = nil) {
        self.id = id; self.name = name; self.brand = brand; self.source = source; self.sourceRef = sourceRef
        self.derivedFrom = derivedFrom; self.carbsPer100g = carbsPer100g; self.fiberPer100g = fiberPer100g
        self.densityGPerMl = densityGPerMl; self.notes = notes; self.deleted = deleted
    }

    enum CodingKeys: String, CodingKey {
        case id, name, brand, source, notes, deleted
        case sourceRef = "source_ref"
        case derivedFrom = "derived_from"
        case carbsPer100g = "carbs_per_100g"
        case fiberPer100g = "fiber_per_100g"
        case densityGPerMl = "density_g_per_ml"
    }
}

public struct PortionData: Codable, Equatable, Sendable {
    public var id: Id
    public var foodId: Id
    /// For kind "volume" this must be a volume unit id (e.g. "cup"); otherwise free text ("slice").
    public var label: String
    /// "volume" | "count" | "serving"
    public var kind: String
    public var quantity: Double
    public var grams: Double
    public var deleted: Int?

    public init(id: Id, foodId: Id, label: String, kind: String, quantity: Double, grams: Double, deleted: Int? = nil) {
        self.id = id; self.foodId = foodId; self.label = label; self.kind = kind
        self.quantity = quantity; self.grams = grams; self.deleted = deleted
    }

    enum CodingKeys: String, CodingKey {
        case id, label, kind, quantity, grams, deleted
        case foodId = "food_id"
    }
}

public struct MealData: Codable, Equatable, Sendable {
    public var id: Id
    public var name: String
    public var yieldServings: Double
    public var totalWeightG: Double?
    public var notes: String?
    public var deleted: Int?

    public init(id: Id, name: String, yieldServings: Double, totalWeightG: Double? = nil, notes: String? = nil, deleted: Int? = nil) {
        self.id = id; self.name = name; self.yieldServings = yieldServings
        self.totalWeightG = totalWeightG; self.notes = notes; self.deleted = deleted
    }

    enum CodingKeys: String, CodingKey {
        case id, name, notes, deleted
        case yieldServings = "yield_servings"
        case totalWeightG = "total_weight_g"
    }
}

public enum RefType: String, Codable, Sendable {
    case food, meal
}

public struct MealItemData: Codable, Equatable, Sendable {
    public var id: Id
    public var mealId: Id
    public var refType: RefType
    public var refId: Id
    public var amount: Double
    public var unit: String
    public var position: Int
    public var deleted: Int?

    public init(id: Id, mealId: Id, refType: RefType, refId: Id, amount: Double, unit: String, position: Int, deleted: Int? = nil) {
        self.id = id; self.mealId = mealId; self.refType = refType; self.refId = refId
        self.amount = amount; self.unit = unit; self.position = position; self.deleted = deleted
    }

    enum CodingKeys: String, CodingKey {
        case id, amount, unit, position, deleted
        case mealId = "meal_id"
        case refType = "ref_type"
        case refId = "ref_id"
    }
}

public struct DoseWindow: Codable, Equatable, Sendable {
    public var name: String
    /// "HH:MM", 24-hour local time
    public var start: String
    public var ratioGPerUnit: Double

    public init(name: String, start: String, ratioGPerUnit: Double) {
        self.name = name; self.start = start; self.ratioGPerUnit = ratioGPerUnit
    }

    enum CodingKeys: String, CodingKey {
        case name, start
        case ratioGPerUnit = "ratio_g_per_unit"
    }
}

public struct CorrectionRule: Codable, Equatable, Sendable {
    public var threshold: Double
    public var step: Double
    public var unitsPerStep: Double
    /// "started" | "full" | "proportional" — kept as a string so bad stored values refuse
    /// with `invalid_settings` instead of failing to decode.
    public var mode: String

    public init(threshold: Double, step: Double, unitsPerStep: Double, mode: String) {
        self.threshold = threshold; self.step = step; self.unitsPerStep = unitsPerStep; self.mode = mode
    }

    enum CodingKeys: String, CodingKey {
        case threshold, step, mode
        case unitsPerStep = "units_per_step"
    }
}

public struct RoundingRule: Codable, Equatable, Sendable {
    public var increment: Double
    public var roundDownBelowBg: Double?

    public init(increment: Double, roundDownBelowBg: Double?) {
        self.increment = increment; self.roundDownBelowBg = roundDownBelowBg
    }

    enum CodingKeys: String, CodingKey {
        case increment
        case roundDownBelowBg = "round_down_below_bg"
    }
}

public struct DoseSettingsData: Codable, Equatable, Sendable {
    public var id: Id
    /// ms since epoch
    public var effectiveFrom: Int64
    public var windows: [DoseWindow]
    public var correction: CorrectionRule
    public var rounding: RoundingRule
    public var deleted: Int?

    public init(id: Id, effectiveFrom: Int64, windows: [DoseWindow], correction: CorrectionRule, rounding: RoundingRule,
                deleted: Int? = nil) {
        self.id = id; self.effectiveFrom = effectiveFrom; self.windows = windows
        self.correction = correction; self.rounding = rounding; self.deleted = deleted
    }

    enum CodingKeys: String, CodingKey {
        case id, windows, correction, rounding, deleted
        case effectiveFrom = "effective_from"
    }
}

public struct LogEntryData: Codable, Equatable, Sendable {
    public var id: Id
    public var eatenAt: Int64
    public var windowName: String?
    public var bgMgdl: Double?
    /// "dexcom" | "manual" | "none"
    public var bgSource: String
    public var bgTrend: String?
    public var totalCarbsG: Double
    public var suggestedUnits: Double?
    public var takenUnits: Double?
    public var settingsVersionId: Id?
    public var notes: String?

    public init(id: Id, eatenAt: Int64, windowName: String?, bgMgdl: Double?, bgSource: String, bgTrend: String?,
                totalCarbsG: Double, suggestedUnits: Double?, takenUnits: Double?, settingsVersionId: Id?, notes: String?) {
        self.id = id; self.eatenAt = eatenAt; self.windowName = windowName; self.bgMgdl = bgMgdl
        self.bgSource = bgSource; self.bgTrend = bgTrend; self.totalCarbsG = totalCarbsG
        self.suggestedUnits = suggestedUnits; self.takenUnits = takenUnits
        self.settingsVersionId = settingsVersionId; self.notes = notes
    }

    enum CodingKeys: String, CodingKey {
        case id, notes
        case eatenAt = "eaten_at"
        case windowName = "window_name"
        case bgMgdl = "bg_mgdl"
        case bgSource = "bg_source"
        case bgTrend = "bg_trend"
        case totalCarbsG = "total_carbs_g"
        case suggestedUnits = "suggested_units"
        case takenUnits = "taken_units"
        case settingsVersionId = "settings_version_id"
    }
}

public struct LogItemData: Codable, Equatable, Sendable {
    public var id: Id
    public var logEntryId: Id
    public var refType: RefType
    public var refId: Id
    public var displayName: String
    public var amount: Double
    public var unit: String
    public var carbsG: Double

    public init(id: Id, logEntryId: Id, refType: RefType, refId: Id, displayName: String, amount: Double, unit: String, carbsG: Double) {
        self.id = id; self.logEntryId = logEntryId; self.refType = refType; self.refId = refId
        self.displayName = displayName; self.amount = amount; self.unit = unit; self.carbsG = carbsG
    }

    enum CodingKeys: String, CodingKey {
        case id, amount, unit
        case logEntryId = "log_entry_id"
        case refType = "ref_type"
        case refId = "ref_id"
        case displayName = "display_name"
        case carbsG = "carbs_g"
    }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `ios/scripts/swift-test.sh CarbBookCore --filter TypesTests`
Expected: `Executed 3 tests, with 0 failures (0 unexpected)` and no `warning:` lines for CarbBookCore sources.

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/CarbBook
git add ios/CarbBookCore/Sources/CarbBookCore/JSONValue.swift ios/CarbBookCore/Sources/CarbBookCore/Types.swift ios/CarbBookCore/Tests/CarbBookCoreTests/TypesTests.swift
git commit -m "feat(ios-core): JSON value and domain types with column-name coding keys"
```

---

### Task 4: Units

**Files:**
- Create: `ios/CarbBookCore/Sources/CarbBookCore/Units.swift`
- Test: `ios/CarbBookCore/Tests/CarbBookCoreTests/UnitsTests.swift`

Mirror of `units.ts`: mass always, volume when density is explicit or derivable from the valid `volume` portion with the smallest id (JS order), count/serving portions as `p:<id>`.

- [ ] **Step 1: Write the failing test**

`ios/CarbBookCore/Tests/CarbBookCoreTests/UnitsTests.swift`:
```swift
import XCTest
@testable import CarbBookCore

final class UnitsTests: XCTestCase {
    let rice = FoodData(id: "rice", name: "Rice", carbsPer100g: 28.2)
    let riceCup = PortionData(id: "rice-cup", foodId: "rice", label: "cup", kind: "volume", quantity: 1, grams: 158)
    let bread = FoodData(id: "bread", name: "Bread", carbsPer100g: 49)
    let slice = PortionData(id: "bread-slice", foodId: "bread", label: "slice", kind: "count", quantity: 1, grams: 25)
    let milk = FoodData(id: "milk", name: "Milk", carbsPer100g: 4.8, densityGPerMl: 1.03)

    func testDensityPrefersExplicitThenPortion() {
        XCTAssertEqual(densityOf(milk, []), 1.03)
        XCTAssertEqual(densityOf(rice, [riceCup])!, 158 / 236.5882365, accuracy: 1e-9)
        XCTAssertNil(densityOf(bread, [slice]))
        var infMilk = milk
        infMilk.densityGPerMl = .infinity
        XCTAssertEqual(densityOf(infMilk, [riceCup])!, 158 / 236.5882365, accuracy: 1e-9)
    }

    func testDensityUsesSmallestIdValidVolumePortion() {
        let cupB = PortionData(id: "b-cup", foodId: "rice", label: "cup", kind: "volume", quantity: 1, grams: 300)
        let cupA = PortionData(id: "a-cup", foodId: "rice", label: "cup", kind: "volume", quantity: 1, grams: 200)
        XCTAssertEqual(densityOf(rice, [cupB, cupA])!, 200 / 236.5882365, accuracy: 1e-9)
        let bad = PortionData(id: "a-cup", foodId: "rice", label: "cup", kind: "volume", quantity: 0, grams: 200)
        XCTAssertEqual(densityOf(rice, [bad, riceCup])!, 158 / 236.5882365, accuracy: 1e-9)
    }

    func testFoodAmountToGrams() {
        XCTAssertEqual(foodAmountToGrams(4, "oz", rice, [])!, 113.398093, accuracy: 1e-5)
        XCTAssertEqual(foodAmountToGrams(1, "kg", rice, []), 1000)
        XCTAssertEqual(foodAmountToGrams(2, "tbsp", rice, [riceCup])!, 19.75, accuracy: 1e-6)
        XCTAssertEqual(foodAmountToGrams(2, "p:bread-slice", bread, [slice]), 50)
        XCTAssertNil(foodAmountToGrams(1, "cup", bread, [slice]))
        XCTAssertNil(foodAmountToGrams(1, "handful", rice, []))
        XCTAssertNil(foodAmountToGrams(1, "p:missing", bread, [slice]))
        XCTAssertNil(foodAmountToGrams(-1, "g", rice, []))
        XCTAssertNil(foodAmountToGrams(.nan, "g", rice, []))
    }

    func testRejectsInvalidPortions() {
        for bad in [
            PortionData(id: "bread-slice", foodId: "bread", label: "slice", kind: "count", quantity: 1, grams: 0),
            PortionData(id: "bread-slice", foodId: "bread", label: "slice", kind: "count", quantity: -1, grams: 25),
            PortionData(id: "bread-slice", foodId: "bread", label: "slice", kind: "count", quantity: 1, grams: .infinity),
            PortionData(id: "bread-slice", foodId: "bread", label: "slice", kind: "count", quantity: .nan, grams: 25),
        ] {
            XCTAssertNil(foodAmountToGrams(2, "p:bread-slice", bread, [bad]))
        }
    }

    func testUnitLists() {
        XCTAssertEqual(foodUnits(rice, [riceCup]), ["g", "kg", "oz", "lb", "ml", "l", "tsp", "tbsp", "floz", "cup"])
        XCTAssertEqual(foodUnits(bread, [slice]), ["g", "kg", "oz", "lb", "p:bread-slice"])
        XCTAssertEqual(mealUnits(MealData(id: "m", name: "M", yieldServings: 2, totalWeightG: 414)), ["serving", "g", "kg", "oz", "lb"])
        XCTAssertEqual(mealUnits(MealData(id: "n", name: "N", yieldServings: 1, totalWeightG: nil)), ["serving"])
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `ios/scripts/swift-test.sh CarbBookCore --filter UnitsTests`
Expected: build FAILS with `error: cannot find 'densityOf' in scope`.

- [ ] **Step 3: Implement**

`ios/CarbBookCore/Sources/CarbBookCore/Units.swift`:
```swift
import Foundation

/// Mirrors packages/core/src/units.ts.
public enum Units {
    /// Mass unit ids in display order, and grams per unit.
    public static let massOrder = ["g", "kg", "oz", "lb"]
    public static let massGrams: [String: Double] = ["g": 1, "kg": 1000, "oz": 28.349523125, "lb": 453.59237]
    /// Volume unit ids in display order, and millilitres per unit (US customary).
    public static let volumeOrder = ["ml", "l", "tsp", "tbsp", "floz", "cup"]
    public static let volumeMl: [String: Double] = [
        "ml": 1, "l": 1000, "tsp": 4.92892159375, "tbsp": 14.78676478125, "floz": 29.5735295625, "cup": 236.5882365,
    ]
    public static let serving = "serving"
    public static let portionPrefix = "p:"
}

public func isMassUnit(_ unit: String) -> Bool { Units.massGrams[unit] != nil }
public func isVolumeUnit(_ unit: String) -> Bool { Units.volumeMl[unit] != nil }

private func isValidAmount(_ amount: Double) -> Bool { amount.isFinite && amount >= 0 }

public func densityOf(_ food: FoodData, _ portions: [PortionData]) -> Double? {
    if let density = food.densityGPerMl, density.isFinite, density > 0 { return density }
    var best: PortionData?
    for p in portions where p.kind == "volume" && isVolumeUnit(p.label)
        && p.quantity.isFinite && p.quantity > 0 && p.grams.isFinite && p.grams > 0 {
        if best == nil || JS.less(p.id, best!.id) { best = p }
    }
    guard let best else { return nil }
    return best.grams / (best.quantity * Units.volumeMl[best.label]!)
}

public func foodUnits(_ food: FoodData, _ portions: [PortionData]) -> [String] {
    var units = Units.massOrder
    if densityOf(food, portions) != nil { units += Units.volumeOrder }
    for p in portions where p.kind != "volume" { units.append(Units.portionPrefix + p.id) }
    return units
}

public func mealUnits(_ meal: MealData) -> [String] {
    let hasWeight = (meal.totalWeightG ?? 0) > 0
    return hasWeight ? [Units.serving] + Units.massOrder : [Units.serving]
}

public func foodAmountToGrams(_ amount: Double, _ unit: String, _ food: FoodData, _ portions: [PortionData]) -> Double? {
    guard isValidAmount(amount) else { return nil }
    if let grams = Units.massGrams[unit] { return amount * grams }
    if let ml = Units.volumeMl[unit] {
        guard let density = densityOf(food, portions) else { return nil }
        return amount * ml * density
    }
    if unit.hasPrefix(Units.portionPrefix) {
        let portionId = String(unit.dropFirst(Units.portionPrefix.count))
        guard let portion = portions.first(where: { $0.id == portionId }),
              portion.grams.isFinite, portion.grams > 0,
              portion.quantity.isFinite, portion.quantity > 0 else { return nil }
        return amount * portion.grams / portion.quantity
    }
    return nil
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `ios/scripts/swift-test.sh CarbBookCore --filter UnitsTests`
Expected: `Executed 5 tests, with 0 failures (0 unexpected)` and no `warning:` lines for CarbBookCore sources.

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/CarbBook
git add ios/CarbBookCore/Sources/CarbBookCore/Units.swift ios/CarbBookCore/Tests/CarbBookCoreTests/UnitsTests.swift
git commit -m "feat(ios-core): unit conversion and unit lists"
```

---

### Task 5: Catalog and carb math

**Files:**
- Create: `ios/CarbBookCore/Sources/CarbBookCore/Carbs.swift`
- Test: `ios/CarbBookCore/Tests/CarbBookCoreTests/CarbsTests.swift`

Mirror of `carbs.ts` with the review hardening: deleted rows skipped, `carbs_per_100g` outside 0–100 or non-finite → incomplete, empty meals incomplete, non-finite yield/weight incomplete, cycles terminate. Meal items sort by `position` with a stable tie-break on input order (JS sort is stable).

- [ ] **Step 1: Write the failing test**

`ios/CarbBookCore/Tests/CarbBookCoreTests/CarbsTests.swift`:
```swift
import XCTest
@testable import CarbBookCore

final class CarbsTests: XCTestCase {
    let catalog = InMemoryCatalog(
        foods: [
            FoodData(id: "rice", name: "Rice", carbsPer100g: 28.2),
            FoodData(id: "corn", name: "Cream corn", carbsPer100g: 18.13),
            FoodData(id: "bread", name: "Bread", carbsPer100g: 49),
            FoodData(id: "mystery", name: "Mystery", carbsPer100g: nil),
        ],
        portions: [
            PortionData(id: "rice-cup", foodId: "rice", label: "cup", kind: "volume", quantity: 1, grams: 158),
            PortionData(id: "corn-cup", foodId: "corn", label: "cup", kind: "volume", quantity: 1, grams: 256),
            PortionData(id: "bread-slice", foodId: "bread", label: "slice", kind: "count", quantity: 1, grams: 25),
        ],
        meals: [
            MealData(id: "rice-corn", name: "Rice and corn", yieldServings: 2, totalWeightG: 414),
            MealData(id: "plate", name: "Plate", yieldServings: 1),
            MealData(id: "bad", name: "Bad", yieldServings: 1),
        ],
        mealItems: [
            MealItemData(id: "i2", mealId: "rice-corn", refType: .food, refId: "corn", amount: 1, unit: "cup", position: 1),
            MealItemData(id: "i1", mealId: "rice-corn", refType: .food, refId: "rice", amount: 1, unit: "cup", position: 0),
            MealItemData(id: "i3", mealId: "plate", refType: .meal, refId: "rice-corn", amount: 1.5, unit: "serving", position: 0),
            MealItemData(id: "i4", mealId: "plate", refType: .food, refId: "bread", amount: 1, unit: "p:bread-slice", position: 1),
            MealItemData(id: "i5", mealId: "bad", refType: .food, refId: "rice", amount: 100, unit: "g", position: 0),
            MealItemData(id: "i6", mealId: "bad", refType: .food, refId: "mystery", amount: 50, unit: "g", position: 1),
        ]
    )

    func testFoodCarbs() {
        let r = itemCarbs(catalog, .food, "rice", 1, "cup")
        XCTAssertTrue(r.complete)
        XCTAssertEqual(r.carbsG, 44.556, accuracy: 1e-6)
        XCTAssertEqual(itemCarbs(catalog, .food, "mystery", 50, "g"), .incomplete)
        XCTAssertEqual(itemCarbs(catalog, .food, "bread", 1, "cup"), .incomplete)
        XCTAssertEqual(itemCarbs(catalog, .food, "nope", 1, "g"), .incomplete)
    }

    func testMealServingsGramsAndNesting() {
        XCTAssertEqual(itemCarbs(catalog, .meal, "rice-corn", 1, "serving").carbsG, 45.4844, accuracy: 1e-6)
        XCTAssertEqual(itemCarbs(catalog, .meal, "rice-corn", 100, "g").carbsG, 21.97314, accuracy: 1e-5)
        let nested = itemCarbs(catalog, .meal, "plate", 1, "serving")
        XCTAssertTrue(nested.complete)
        XCTAssertEqual(nested.carbsG, 80.4766, accuracy: 1e-6)
        XCTAssertEqual(itemCarbs(catalog, .meal, "plate", 1, "g"), .incomplete)
        let bad = itemCarbs(catalog, .meal, "bad", 1, "serving")
        XCTAssertFalse(bad.complete)
        XCTAssertEqual(bad.carbsG, 28.2, accuracy: 1e-6)
    }

    func testInvalidStoredValuesAreIncomplete() {
        let invalid = InMemoryCatalog(foods: [
            FoodData(id: "neg", name: "Neg", carbsPer100g: -1),
            FoodData(id: "huge", name: "Huge", carbsPer100g: 101),
            FoodData(id: "inf", name: "Inf", carbsPer100g: .infinity),
            FoodData(id: "nan", name: "NaN", carbsPer100g: .nan),
            FoodData(id: "edge0", name: "Edge0", carbsPer100g: 0),
            FoodData(id: "edge100", name: "Edge100", carbsPer100g: 100),
        ])
        for id in ["neg", "huge", "inf", "nan"] {
            XCTAssertFalse(itemCarbs(invalid, .food, id, 50, "g").complete, id)
        }
        XCTAssertEqual(itemCarbs(invalid, .food, "edge0", 50, "g"), CarbResult(carbsG: 0, complete: true))
        XCTAssertEqual(itemCarbs(invalid, .food, "edge100", 50, "g"), CarbResult(carbsG: 50, complete: true))
    }

    func testEmptyMealAndNonFiniteMealFieldsAreIncomplete() {
        XCTAssertEqual(itemCarbs(InMemoryCatalog(meals: [MealData(id: "empty", name: "Empty", yieldServings: 1)]), .meal, "empty", 1, "serving"), .incomplete)
        let badMeal = InMemoryCatalog(
            foods: [FoodData(id: "rice", name: "Rice", carbsPer100g: 28.2)],
            meals: [
                MealData(id: "inf-yield", name: "InfYield", yieldServings: .infinity),
                MealData(id: "inf-weight", name: "InfWeight", yieldServings: 1, totalWeightG: .infinity),
            ],
            mealItems: [
                MealItemData(id: "i1", mealId: "inf-yield", refType: .food, refId: "rice", amount: 100, unit: "g", position: 0),
                MealItemData(id: "i2", mealId: "inf-weight", refType: .food, refId: "rice", amount: 100, unit: "g", position: 0),
            ]
        )
        XCTAssertFalse(itemCarbs(badMeal, .meal, "inf-yield", 1, "serving").complete)
        XCTAssertFalse(itemCarbs(badMeal, .meal, "inf-weight", 100, "g").complete)
    }

    func testSoftDeletedRowsAreSkipped() {
        let c = InMemoryCatalog(
            foods: [
                FoodData(id: "rice", name: "Rice", carbsPer100g: 28.2),
                FoodData(id: "ghost-food", name: "Ghost", carbsPer100g: 10, deleted: 1),
            ],
            portions: [
                PortionData(id: "rice-cup", foodId: "rice", label: "cup", kind: "volume", quantity: 1, grams: 158),
                PortionData(id: "ghost-portion", foodId: "rice", label: "tbsp", kind: "volume", quantity: 1, grams: 10, deleted: 1),
            ],
            meals: [
                MealData(id: "plate", name: "Plate", yieldServings: 1),
                MealData(id: "ghost-meal", name: "Ghost meal", yieldServings: 1, deleted: 1),
            ],
            mealItems: [
                MealItemData(id: "i1", mealId: "plate", refType: .food, refId: "rice", amount: 100, unit: "g", position: 0),
                MealItemData(id: "ghost-item", mealId: "plate", refType: .food, refId: "rice", amount: 999, unit: "g", position: 1, deleted: 1),
            ]
        )
        XCTAssertNil(c.food("ghost-food"))
        XCTAssertNil(c.meal("ghost-meal"))
        XCTAssertEqual(c.portions("rice").map(\.id), ["rice-cup"])
        XCTAssertEqual(c.mealItems("plate").map(\.id), ["i1"])
        XCTAssertEqual(itemCarbs(c, .meal, "plate", 1, "serving").carbsG, 28.2, accuracy: 1e-9)
    }

    func testCycles() {
        XCTAssertTrue(wouldCreateCycle(catalog, "plate", "plate"))
        XCTAssertTrue(wouldCreateCycle(catalog, "rice-corn", "plate"))
        XCTAssertFalse(wouldCreateCycle(catalog, "plate", "bad"))
        let cyclic = InMemoryCatalog(
            meals: [MealData(id: "a", name: "A", yieldServings: 1), MealData(id: "b", name: "B", yieldServings: 1)],
            mealItems: [
                MealItemData(id: "x", mealId: "a", refType: .meal, refId: "b", amount: 1, unit: "serving", position: 0),
                MealItemData(id: "y", mealId: "b", refType: .meal, refId: "a", amount: 1, unit: "serving", position: 0),
            ]
        )
        XCTAssertFalse(itemCarbs(cyclic, .meal, "a", 1, "serving").complete)
    }

    func testSumCarbs() {
        XCTAssertEqual(sumCarbs([CarbResult(carbsG: 10, complete: true), CarbResult(carbsG: 5, complete: false)]), CarbResult(carbsG: 15, complete: false))
        XCTAssertEqual(sumCarbs([]), CarbResult(carbsG: 0, complete: true))
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `ios/scripts/swift-test.sh CarbBookCore --filter CarbsTests`
Expected: build FAILS with `error: cannot find 'InMemoryCatalog' in scope`.

- [ ] **Step 3: Implement**

`ios/CarbBookCore/Sources/CarbBookCore/Carbs.swift`:
```swift
import Foundation

/// Mirrors packages/core/src/carbs.ts.
public protocol Catalog: Sendable {
    func food(_ id: Id) -> FoodData?
    func portions(_ foodId: Id) -> [PortionData]
    func meal(_ id: Id) -> MealData?
    func mealItems(_ mealId: Id) -> [MealItemData]
}

public struct CarbResult: Equatable, Sendable {
    public var carbsG: Double
    public var complete: Bool

    public init(carbsG: Double, complete: Bool) {
        self.carbsG = carbsG
        self.complete = complete
    }

    public static let incomplete = CarbResult(carbsG: 0, complete: false)
}

public struct InMemoryCatalog: Catalog {
    private let foods: [Id: FoodData]
    private let portionsByFood: [Id: [PortionData]]
    private let meals: [Id: MealData]
    private let itemsByMeal: [Id: [MealItemData]]

    /// Rows with `deleted == 1` are skipped. Meal items are ordered by `position`, keeping input
    /// order for equal positions (JS `Array.prototype.sort` is stable).
    public init(foods: [FoodData] = [], portions: [PortionData] = [], meals: [MealData] = [], mealItems: [MealItemData] = []) {
        var foodMap: [Id: FoodData] = [:]
        for f in foods where f.deleted != 1 { foodMap[f.id] = f }
        var mealMap: [Id: MealData] = [:]
        for m in meals where m.deleted != 1 { mealMap[m.id] = m }
        var portionMap: [Id: [PortionData]] = [:]
        for p in portions where p.deleted != 1 { portionMap[p.foodId, default: []].append(p) }
        var itemMap: [Id: [(Int, MealItemData)]] = [:]
        for (index, item) in mealItems.enumerated() where item.deleted != 1 {
            itemMap[item.mealId, default: []].append((index, item))
        }
        self.foods = foodMap
        self.meals = mealMap
        self.portionsByFood = portionMap
        self.itemsByMeal = itemMap.mapValues { list in
            list.sorted { $0.1.position != $1.1.position ? $0.1.position < $1.1.position : $0.0 < $1.0 }.map(\.1)
        }
    }

    public func food(_ id: Id) -> FoodData? { foods[id] }
    public func portions(_ foodId: Id) -> [PortionData] { portionsByFood[foodId] ?? [] }
    public func meal(_ id: Id) -> MealData? { meals[id] }
    public func mealItems(_ mealId: Id) -> [MealItemData] { itemsByMeal[mealId] ?? [] }
}

private func isValidCarbsPer100g(_ value: Double?) -> Bool {
    guard let value else { return false }
    return value.isFinite && value >= 0 && value <= 100
}

private func foodItemCarbs(_ catalog: Catalog, _ foodId: Id, _ amount: Double, _ unit: String) -> CarbResult {
    guard let food = catalog.food(foodId), isValidCarbsPer100g(food.carbsPer100g),
          let grams = foodAmountToGrams(amount, unit, food, catalog.portions(foodId)) else { return .incomplete }
    return CarbResult(carbsG: grams * food.carbsPer100g! / 100, complete: true)
}

private func mealTotalCarbs(_ catalog: Catalog, _ mealId: Id, _ visiting: inout Set<Id>) -> CarbResult {
    if visiting.contains(mealId) || catalog.meal(mealId) == nil { return .incomplete }
    visiting.insert(mealId)
    let items = catalog.mealItems(mealId)
    var results: [CarbResult] = []
    for item in items {
        results.append(resolveItem(catalog, item.refType, item.refId, item.amount, item.unit, &visiting))
    }
    let total = items.isEmpty ? .incomplete : sumCarbs(results)
    visiting.remove(mealId)
    return total
}

private func mealItemCarbs(_ catalog: Catalog, _ mealId: Id, _ amount: Double, _ unit: String, _ visiting: inout Set<Id>) -> CarbResult {
    guard let meal = catalog.meal(mealId), amount.isFinite, amount >= 0 else { return .incomplete }
    var factor: Double?
    if unit == Units.serving && meal.yieldServings.isFinite && meal.yieldServings > 0 {
        factor = amount / meal.yieldServings
    } else if let grams = Units.massGrams[unit], let weight = meal.totalWeightG, weight.isFinite, weight > 0 {
        factor = amount * grams / weight
    }
    guard let factor else { return .incomplete }
    let total = mealTotalCarbs(catalog, mealId, &visiting)
    return CarbResult(carbsG: total.carbsG * factor, complete: total.complete)
}

private func resolveItem(_ catalog: Catalog, _ refType: RefType, _ refId: Id, _ amount: Double, _ unit: String,
                         _ visiting: inout Set<Id>) -> CarbResult {
    switch refType {
    case .food: foodItemCarbs(catalog, refId, amount, unit)
    case .meal: mealItemCarbs(catalog, refId, amount, unit, &visiting)
    }
}

/// Carbs for one line item (a food or a meal) at the given amount and unit.
public func itemCarbs(_ catalog: Catalog, _ refType: RefType, _ refId: Id, _ amount: Double, _ unit: String) -> CarbResult {
    var visiting = Set<Id>()
    return resolveItem(catalog, refType, refId, amount, unit, &visiting)
}

public func sumCarbs(_ results: [CarbResult]) -> CarbResult {
    results.reduce(CarbResult(carbsG: 0, complete: true)) {
        CarbResult(carbsG: $0.carbsG + $1.carbsG, complete: $0.complete && $1.complete)
    }
}

/// True if adding `candidateMealId` as a component of `mealId` would make a meal contain itself.
public func wouldCreateCycle(_ catalog: Catalog, _ mealId: Id, _ candidateMealId: Id) -> Bool {
    if candidateMealId == mealId { return true }
    var stack = [candidateMealId]
    var seen = Set<Id>()
    while let current = stack.popLast() {
        if seen.contains(current) { continue }
        seen.insert(current)
        for item in catalog.mealItems(current) where item.refType == .meal {
            if item.refId == mealId { return true }
            stack.append(item.refId)
        }
    }
    return false
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `ios/scripts/swift-test.sh CarbBookCore --filter CarbsTests`
Expected: `Executed 7 tests, with 0 failures (0 unexpected)` and no `warning:` lines for CarbBookCore sources.

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/CarbBook
git add ios/CarbBookCore/Sources/CarbBookCore/Carbs.swift ios/CarbBookCore/Tests/CarbBookCoreTests/CarbsTests.swift
git commit -m "feat(ios-core): catalog, item carbs, nested meals and cycle detection"
```

---

### Task 6: Dose primitives, active settings and recent-dose warning

**Files:**
- Create: `ios/CarbBookCore/Sources/CarbBookCore/Dose.swift`
- Test: `ios/CarbBookCore/Tests/CarbBookCoreTests/DoseTests.swift`

Mirror of the helpers in `dose.ts`. `parseHHMM` accepts exactly two ASCII digits on each side (JS `/^(\\d{2}):(\\d{2})$/` without the `u` flag). `activeSettings` skips soft-deleted versions (feat/server fix).

- [ ] **Step 1: Write the failing test**

`ios/CarbBookCore/Tests/CarbBookCoreTests/DoseTests.swift`:
```swift
import XCTest
@testable import CarbBookCore

let seedSettings = DoseSettingsData(
    id: "s1",
    effectiveFrom: 1_786_492_800_000,
    windows: [
        DoseWindow(name: "Breakfast", start: "05:00", ratioGPerUnit: 8),
        DoseWindow(name: "AM Snack", start: "09:00", ratioGPerUnit: 10),
        DoseWindow(name: "Lunch", start: "11:00", ratioGPerUnit: 8),
        DoseWindow(name: "PM Snack", start: "14:00", ratioGPerUnit: 10),
        DoseWindow(name: "Dinner", start: "16:30", ratioGPerUnit: 8),
        DoseWindow(name: "HS Snack", start: "19:30", ratioGPerUnit: 12),
    ],
    correction: CorrectionRule(threshold: 200, step: 50, unitsPerStep: 1, mode: "started"),
    rounding: RoundingRule(increment: 1, roundDownBelowBg: 130)
)

final class DoseTests: XCTestCase {
    func testParseHHMM() throws {
        XCTAssertEqual(try parseHHMM("16:30"), 990)
        XCTAssertThrowsError(try parseHHMM("24:00"))
        XCTAssertThrowsError(try parseHHMM("9:00"))
        XCTAssertThrowsError(try parseHHMM("09:00\n"))
        XCTAssertThrowsError(try parseHHMM("٠٩:٠٠")) // non-ASCII digits, like JS \d
    }

    func testPickWindow() throws {
        XCTAssertEqual(pickWindow(seedSettings.windows, try parseHHMM("09:00"))?.name, "AM Snack")
        XCTAssertEqual(pickWindow(seedSettings.windows, try parseHHMM("08:59"))?.name, "Breakfast")
        XCTAssertEqual(pickWindow(seedSettings.windows, try parseHHMM("23:30"))?.name, "HS Snack")
        XCTAssertEqual(pickWindow(seedSettings.windows, try parseHHMM("04:59"))?.name, "HS Snack")
        XCTAssertNil(pickWindow([], 600))
        XCTAssertEqual(pickWindow(seedSettings.windows.reversed(), try parseHHMM("12:00"))?.name, "Lunch")
    }

    func testCorrectionUnits() {
        let rule = seedSettings.correction
        XCTAssertEqual(correctionUnits(rule, 200), 0)
        XCTAssertEqual(correctionUnits(rule, 201), 1)
        XCTAssertEqual(correctionUnits(rule, 250), 1)
        XCTAssertEqual(correctionUnits(rule, 251), 2)
        XCTAssertEqual(correctionUnits(rule, nil), 0)
        var full = rule
        full.mode = "full"
        XCTAssertEqual(correctionUnits(full, 249), 0)
        XCTAssertEqual(correctionUnits(full, 263), 1)
        var proportional = rule
        proportional.mode = "proportional"
        XCTAssertEqual(correctionUnits(proportional, 275), 1.5, accuracy: 1e-9)
    }

    func testRoundDose() {
        XCTAssertTrue(roundDose(9.5, seedSettings.rounding, 140) == (10, false))
        XCTAssertTrue(roundDose(9.9, seedSettings.rounding, 125) == (9, true))
        XCTAssertTrue(roundDose(2.5, seedSettings.rounding, nil) == (3, false))
        XCTAssertTrue(roundDose(3.26, RoundingRule(increment: 0.5, roundDownBelowBg: nil), 90) == (3.5, false))
    }

    func testActiveSettings() {
        var old = seedSettings; old.id = "old"; old.effectiveFrom = 1_752_883_200_000
        var future = seedSettings; future.id = "future"; future.effectiveFrom = 1_893_456_000_000
        let now: Int64 = 1_789_344_000_000
        XCTAssertEqual(activeSettings([old, seedSettings, future], now)?.id, "s1")
        XCTAssertNil(activeSettings([future], now))
        var a = seedSettings; a.id = "a"
        var b = seedSettings; b.id = "b"
        XCTAssertEqual(activeSettings([a, b], now)?.id, "b")
        XCTAssertEqual(activeSettings([b, a], now)?.id, "b")
    }

    func testActiveSettingsSkipsDeletedRows() {
        var live = seedSettings; live.id = "live"; live.effectiveFrom = 1_782_864_000_000; live.deleted = 0
        var gone = seedSettings; gone.id = "deleted"; gone.effectiveFrom = 1_785_542_400_000; gone.deleted = 1
        let now: Int64 = 1_789_344_000_000
        XCTAssertEqual(activeSettings([live, gone], now)?.id, "live")
        XCTAssertNil(activeSettings([gone], now))
    }

    func testRecentDoseWarning() {
        let now: Int64 = 1_789_387_200_000
        XCTAssertTrue(recentDoseWarning(now - 3 * 3_600_000, now))
        XCTAssertFalse(recentDoseWarning(now - 5 * 3_600_000, now))
        XCTAssertFalse(recentDoseWarning(nil, now))
        XCTAssertTrue(recentDoseWarning(now + 10 * 60_000, now))
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `ios/scripts/swift-test.sh CarbBookCore --filter DoseTests`
Expected: build FAILS with `error: cannot find 'parseHHMM' in scope`.

- [ ] **Step 3: Implement**

`ios/CarbBookCore/Sources/CarbBookCore/Dose.swift`:
```swift
import Foundation

/// Mirrors packages/core/src/dose.ts.
private let EPS = 1e-9
private let HOUR_MS: Int64 = 3_600_000

public struct InvalidTimeError: Error, Equatable {
    public let value: String
}

/// Parses "HH:MM" (exactly two ASCII digits each side, 00:00-23:59) to minutes since midnight.
public func parseHHMM(_ value: String) throws -> Int {
    let bytes = Array(value.utf8)
    func digit(_ b: UInt8) -> Int? { (48...57).contains(b) ? Int(b - 48) : nil }
    guard bytes.count == 5, bytes[2] == UInt8(ascii: ":"),
          let h1 = digit(bytes[0]), let h2 = digit(bytes[1]),
          let m1 = digit(bytes[3]), let m2 = digit(bytes[4]) else { throw InvalidTimeError(value: value) }
    let hours = h1 * 10 + h2
    let minutes = m1 * 10 + m2
    guard hours <= 23, minutes <= 59 else { throw InvalidTimeError(value: value) }
    return hours * 60 + minutes
}

public func minutesOfDay(_ date: Date, calendar: Calendar = .current) -> Int {
    let parts = calendar.dateComponents([.hour, .minute], from: date)
    return parts.hour! * 60 + parts.minute!
}

/// Last window whose start ≤ minutes; before the first start → the previous day's last window.
/// Windows with unparseable starts sort as if they started at 0 (estimateDose refuses those first).
public func pickWindow(_ windows: [DoseWindow], _ minutes: Int) -> DoseWindow? {
    guard !windows.isEmpty else { return nil }
    let sorted = windows.enumerated()
        .map { (index: $0.offset, window: $0.element, start: (try? parseHHMM($0.element.start)) ?? 0) }
        .sorted { $0.start != $1.start ? $0.start < $1.start : $0.index < $1.index }
    var chosen = sorted.last!.window
    for entry in sorted where entry.start <= minutes { chosen = entry.window }
    return chosen
}

public func correctionUnits(_ rule: CorrectionRule, _ bg: Double?) -> Double {
    guard let bg, bg > rule.threshold, rule.step > 0 else { return 0 }
    let steps = (bg - rule.threshold) / rule.step
    switch rule.mode {
    case "started": return (steps - EPS).rounded(.up) * rule.unitsPerStep
    case "full": return (steps + EPS).rounded(.down) * rule.unitsPerStep
    case "proportional": return steps * rule.unitsPerStep
    default: return 0 // unreachable after validation; TS returns undefined here
    }
}

/// Rounds a raw dose to `rule.increment`. Pure: assumes `rule.increment > 0`.
public func roundDose(_ raw: Double, _ rule: RoundingRule, _ bg: Double?) -> (units: Double, roundedDown: Bool) {
    let increment = rule.increment
    var roundedDown = false
    if let bg, let below = rule.roundDownBelowBg, bg < below { roundedDown = true }
    let steps = roundedDown ? (raw / increment + EPS).rounded(.down) : (raw / increment + 0.5 + EPS).rounded(.down)
    return (Double(JS.toFixed(steps * increment, 4))!, roundedDown)
}

public protocol EffectiveVersion {
    var id: Id { get }
    var effectiveFrom: Int64 { get }
    var deleted: Int? { get }
}

extension DoseSettingsData: EffectiveVersion {}

/// Newest non-deleted version with effective_from ≤ atMs; ties go to the larger id (JS string order).
public func activeSettings<T: EffectiveVersion>(_ versions: [T], _ atMs: Int64) -> T? {
    var best: T?
    for v in versions where v.deleted != 1 && v.effectiveFrom <= atMs {
        if let current = best {
            if v.effectiveFrom > current.effectiveFrom || (v.effectiveFrom == current.effectiveFrom && JS.greater(v.id, current.id)) {
                best = v
            }
        } else {
            best = v
        }
    }
    return best
}

/// Warns near a logged dose in either time direction, including clock-skewed future timestamps.
public func recentDoseWarning(_ lastDoseAtMs: Int64?, _ nowMs: Int64, hours: Int64 = 4) -> Bool {
    guard let lastDoseAtMs else { return false }
    return nowMs - lastDoseAtMs < hours * HOUR_MS
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `ios/scripts/swift-test.sh CarbBookCore --filter DoseTests`
Expected: `Executed 7 tests, with 0 failures (0 unexpected)` and no `warning:` lines for CarbBookCore sources.

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/CarbBook
git add ios/CarbBookCore/Sources/CarbBookCore/Dose.swift ios/CarbBookCore/Tests/CarbBookCoreTests/DoseTests.swift
git commit -m "feat(ios-core): windows, correction, rounding, active settings"
```

---

### Task 7: Dose estimate, refusals and breakdown text

**Files:**
- Create: `ios/CarbBookCore/Sources/CarbBookCore/Estimate.swift`
- Test: `ios/CarbBookCore/Tests/CarbBookCoreTests/EstimateDoseTests.swift`

Validation order matches TS: `invalid_input` (minutes, carbs, BG) before `invalid_settings` (window starts, duplicate starts, correction, rounding), then `no_window`, `invalid_ratio`, `incomplete_carbs`. Each refusal has a user-facing message for the Calculator.

- [ ] **Step 1: Write the failing test**

`ios/CarbBookCore/Tests/CarbBookCoreTests/EstimateDoseTests.swift`:
```swift
import XCTest
@testable import CarbBookCore

final class EstimateDoseTests: XCTestCase {
    private func estimate(_ settings: DoseSettingsData = seedSettings, minutes: Int = 600, carbs: Double = 10,
                          complete: Bool = true, bg: Double? = nil) -> DoseEstimate {
        estimateDose(DoseInput(settings: settings, minutes: minutes, carbs: CarbResult(carbsG: carbs, complete: complete), bg: bg))
    }

    func testCombinesMealAndCorrectionWithBreakdown() {
        guard case .ok(let s) = estimate(minutes: 1080, carbs: 72, bg: 263) else { return XCTFail("expected a dose") }
        XCTAssertEqual(s.mealUnits, 9)
        XCTAssertEqual(s.correctionUnits, 2)
        XCTAssertEqual(s.units, 11)
        XCTAssertFalse(s.roundedDown)
        XCTAssertEqual(formatBreakdown(s), "72g ÷ 8 = 9.0 + BG 263 → 2u = 11.0 → 11u")
    }

    func testRefusals() {
        XCTAssertEqual(estimate(carbs: 40, complete: false, bg: 150), .refused(.incompleteCarbs, window: seedSettings.windows[1]))
        var noWindows = seedSettings
        noWindows.windows = []
        XCTAssertEqual(estimate(noWindows), .refused(.noWindow, window: nil))
        var zero = seedSettings
        zero.windows = [DoseWindow(name: "All", start: "00:00", ratioGPerUnit: 0)]
        XCTAssertEqual(estimate(zero), .refused(.invalidRatio, window: zero.windows[0]))
    }

    func testInvalidInputRefusesBeforeSettings() {
        var broken = seedSettings
        broken.rounding.increment = 0
        XCTAssertEqual(estimate(broken, minutes: -1), .refused(.invalidInput, window: nil))
        XCTAssertEqual(estimate(minutes: 1440), .refused(.invalidInput, window: nil))
        XCTAssertEqual(estimate(carbs: .nan), .refused(.invalidInput, window: nil))
        XCTAssertEqual(estimate(carbs: -1), .refused(.invalidInput, window: nil))
        XCTAssertEqual(estimate(bg: .nan), .refused(.invalidInput, window: nil))
        XCTAssertEqual(estimate(bg: -1), .refused(.invalidInput, window: nil))
    }

    func testInvalidSettingsRefuse() {
        var cases: [DoseSettingsData] = []
        var s = seedSettings; s.windows = [DoseWindow(name: "Bad", start: "25:99", ratioGPerUnit: 8)]; cases.append(s)
        s = seedSettings; s.windows = [DoseWindow(name: "A", start: "05:00", ratioGPerUnit: 8), DoseWindow(name: "B", start: "05:00", ratioGPerUnit: 10)]; cases.append(s)
        s = seedSettings; s.correction.threshold = .nan; cases.append(s)
        s = seedSettings; s.correction.step = 0; cases.append(s)
        s = seedSettings; s.correction.unitsPerStep = -1; cases.append(s)
        s = seedSettings; s.correction.mode = "bogus"; cases.append(s)
        s = seedSettings; s.rounding.increment = 0; cases.append(s)
        s = seedSettings; s.rounding.roundDownBelowBg = .nan; cases.append(s)
        for (index, settings) in cases.enumerated() {
            XCTAssertEqual(estimate(settings), .refused(.invalidSettings, window: nil), "case \(index)")
        }
    }

    func testRefusalMessagesAreDistinct() {
        let all: [DoseRefusal] = [.noWindow, .invalidRatio, .incompleteCarbs, .invalidInput, .invalidSettings]
        XCTAssertEqual(Set(all.map(\.message)).count, all.count)
        XCTAssertEqual(DoseRefusal.incompleteCarbs.rawValue, "incomplete_carbs")
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `ios/scripts/swift-test.sh CarbBookCore --filter EstimateDoseTests`
Expected: build FAILS with `error: cannot find 'estimateDose' in scope`.

- [ ] **Step 3: Implement**

`ios/CarbBookCore/Sources/CarbBookCore/Estimate.swift`:
```swift
import Foundation

/// Mirrors estimateDose, its validation and formatBreakdown in packages/core/src/dose.ts.
public struct DoseInput: Sendable {
    public var settings: DoseSettingsData
    /// Minutes since local midnight when the food is eaten.
    public var minutes: Int
    public var carbs: CarbResult
    public var bg: Double?

    public init(settings: DoseSettingsData, minutes: Int, carbs: CarbResult, bg: Double?) {
        self.settings = settings; self.minutes = minutes; self.carbs = carbs; self.bg = bg
    }
}

public enum DoseRefusal: String, Sendable {
    case noWindow = "no_window"
    case invalidRatio = "invalid_ratio"
    case incompleteCarbs = "incomplete_carbs"
    case invalidInput = "invalid_input"
    case invalidSettings = "invalid_settings"

    /// Shown in place of a dose. iOS-only text; the reason codes match the TS core.
    public var message: String {
        switch self {
        case .noWindow: "No dose estimate: the dose settings have no meal windows."
        case .invalidRatio: "No dose estimate: this meal window's carb ratio is not above zero."
        case .incompleteCarbs: "No dose estimate: at least one item is missing carb data or uses a unit it can't convert."
        case .invalidInput: "No dose estimate: the carbs, BG or time entered are not valid numbers."
        case .invalidSettings: "No dose estimate: the dose settings are invalid. Fix them in Settings."
        }
    }
}

public struct DoseSuggestion: Equatable, Sendable {
    public var window: DoseWindow
    public var carbsG: Double
    public var bg: Double?
    public var mealUnits: Double
    public var correctionUnits: Double
    public var rawUnits: Double
    public var units: Double
    public var roundedDown: Bool
    public var roundDownBelowBg: Double?
}

public enum DoseEstimate: Equatable, Sendable {
    case ok(DoseSuggestion)
    case refused(DoseRefusal, window: DoseWindow?)

    public var window: DoseWindow? {
        switch self {
        case .ok(let s): s.window
        case .refused(_, let window): window
        }
    }
}

private func hasInvalidInput(_ input: DoseInput) -> Bool {
    if input.minutes < 0 || input.minutes > 1439 { return true }
    if !input.carbs.carbsG.isFinite || input.carbs.carbsG < 0 { return true }
    if let bg = input.bg, !bg.isFinite || bg < 0 { return true }
    return false
}

private let validCorrectionModes: Set<String> = ["started", "full", "proportional"]

/// Same order and rules as TS `hasInvalidSettings`.
public func hasInvalidSettings(_ settings: DoseSettingsData) -> Bool {
    var starts: [Int] = []
    for window in settings.windows {
        guard let start = try? parseHHMM(window.start) else { return true }
        if starts.contains(start) { return true }
        starts.append(start)
    }
    let c = settings.correction
    if !c.threshold.isFinite { return true }
    if !c.step.isFinite || c.step <= 0 { return true }
    if !c.unitsPerStep.isFinite || c.unitsPerStep < 0 { return true }
    if !validCorrectionModes.contains(c.mode) { return true }
    let r = settings.rounding
    if !r.increment.isFinite || r.increment <= 0 { return true }
    if let below = r.roundDownBelowBg, !below.isFinite { return true }
    return false
}

public func estimateDose(_ input: DoseInput) -> DoseEstimate {
    if hasInvalidInput(input) { return .refused(.invalidInput, window: nil) }
    if hasInvalidSettings(input.settings) { return .refused(.invalidSettings, window: nil) }
    guard let window = pickWindow(input.settings.windows, input.minutes) else { return .refused(.noWindow, window: nil) }
    if !(window.ratioGPerUnit > 0) { return .refused(.invalidRatio, window: window) }
    if !input.carbs.complete { return .refused(.incompleteCarbs, window: window) }
    let mealUnits = input.carbs.carbsG / window.ratioGPerUnit
    let correction = correctionUnits(input.settings.correction, input.bg)
    let raw = mealUnits + correction
    let rounded = roundDose(raw, input.settings.rounding, input.bg)
    return .ok(DoseSuggestion(
        window: window, carbsG: input.carbs.carbsG, bg: input.bg, mealUnits: mealUnits,
        correctionUnits: correction, rawUnits: raw, units: rounded.units, roundedDown: rounded.roundedDown,
        roundDownBelowBg: input.settings.rounding.roundDownBelowBg
    ))
}

private func trim(_ n: Double, _ digits: Int) -> String {
    JS.numberString(Double(JS.toFixed(n, digits))!)
}

/// e.g. "72g ÷ 8 = 9.0 + BG 263 → 2u = 11.0 → 11u". Same format as the TS core.
public func formatBreakdown(_ e: DoseSuggestion) -> String {
    var text = "\(trim(e.carbsG, 1))g ÷ \(trim(e.window.ratioGPerUnit, 2)) = \(JS.toFixed(e.mealUnits, 1))"
    if let bg = e.bg {
        text += " + BG \(trim(bg, 0)) → \(trim(e.correctionUnits, 2))u = \(JS.toFixed(e.rawUnits, 1))"
    }
    text += " → \(trim(e.units, 2))u"
    if e.roundedDown {
        text += " (rounded down: BG under \(e.roundDownBelowBg.map(JS.numberString) ?? "null"))"
    }
    return text
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `ios/scripts/swift-test.sh CarbBookCore --filter EstimateDoseTests`
Expected: `Executed 5 tests, with 0 failures (0 unexpected)` and no `warning:` lines for CarbBookCore sources.

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/CarbBook
git add ios/CarbBookCore/Sources/CarbBookCore/Estimate.swift ios/CarbBookCore/Tests/CarbBookCoreTests/EstimateDoseTests.swift
git commit -m "feat(ios-core): dose estimate with validation refusals and breakdown"
```

---

### Task 8: Shared test vectors

**Files:**
- Test: `ios/CarbBookCore/Tests/CarbBookCoreTests/VectorTests.swift`
- Uses: `ios/CarbBookCore/Tests/CarbBookCoreTests/Resources/units-vectors.json`, `dose-vectors.json` (copied in Task 1)

The same cases Vitest runs (`packages/core/test/vectors.test.ts`): grams, carbs, unit lists and cycles from `units-vectors.json`; every dose case from `dose-vectors.json`, applying per-case `correction` and `rounding` overrides and `complete: false`, checking `ok`, `window`, `reason` (including the `invalid_settings` and `invalid_input` refusals), the four unit values within `tolerance`, `rounded_down` and `breakdown` when present.

- [ ] **Step 1: Write the vector test**

`ios/CarbBookCore/Tests/CarbBookCoreTests/VectorTests.swift`:
```swift
import XCTest
@testable import CarbBookCore

/// Runs the shared vectors in testdata/ (copied into Resources/ by scripts/sync-testdata.sh).
final class VectorTests: XCTestCase {
    struct UnitsVectors: Decodable {
        struct GramsCase: Decodable { let name: String; let food_id: String; let amount: Double; let unit: String; let expect: Double? }
        struct CarbExpect: Decodable { let carbs_g: Double; let complete: Bool }
        struct CarbCase: Decodable { let name: String; let ref_type: RefType; let ref_id: String; let amount: Double; let unit: String; let expect: CarbExpect }
        struct UnitListCase: Decodable { let ref_type: RefType; let ref_id: String; let expect: [String] }
        struct CycleCase: Decodable { let meal_id: String; let candidate: String; let expect: Bool }
        let tolerance: Double
        let foods: [FoodData]
        let portions: [PortionData]
        let meals: [MealData]
        let meal_items: [MealItemData]
        let grams_cases: [GramsCase]
        let carb_cases: [CarbCase]
        let unit_list_cases: [UnitListCase]
        let cycle_cases: [CycleCase]
    }

    struct DoseVectors: Decodable {
        struct Expect: Decodable {
            let ok: Bool
            let window: String?
            let reason: String?
            let meal_units: Double?
            let correction_units: Double?
            let raw_units: Double?
            let units: Double?
            let rounded_down: Bool?
            let breakdown: String?
        }
        struct Case: Decodable {
            let name: String
            let time: String
            let carbs: Double
            let complete: Bool?
            let bg: Double?
            let correction: CorrectionRule?
            let rounding: RoundingRule?
            let expect: Expect
        }
        let tolerance: Double
        let settings: DoseSettingsData
        let cases: [Case]
    }

    private func load<T: Decodable>(_ name: String, as type: T.Type) throws -> T {
        let url = try XCTUnwrap(Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Resources"))
        return try JSONDecoder().decode(T.self, from: Data(contentsOf: url))
    }

    func testUnitsVectors() throws {
        let u = try load("units-vectors", as: UnitsVectors.self)
        XCTAssertFalse(u.grams_cases.isEmpty)
        XCTAssertFalse(u.carb_cases.isEmpty)
        XCTAssertFalse(u.unit_list_cases.isEmpty)
        XCTAssertFalse(u.cycle_cases.isEmpty)
        let catalog = InMemoryCatalog(foods: u.foods, portions: u.portions, meals: u.meals, mealItems: u.meal_items)
        for c in u.grams_cases {
            let food = try XCTUnwrap(catalog.food(c.food_id), c.name)
            let grams = foodAmountToGrams(c.amount, c.unit, food, catalog.portions(c.food_id))
            if let expected = c.expect {
                XCTAssertEqual(try XCTUnwrap(grams, c.name), expected, accuracy: u.tolerance, "grams: \(c.name)")
            } else {
                XCTAssertNil(grams, "grams: \(c.name)")
            }
        }
        for c in u.carb_cases {
            let r = itemCarbs(catalog, c.ref_type, c.ref_id, c.amount, c.unit)
            XCTAssertEqual(r.complete, c.expect.complete, "carbs: \(c.name)")
            XCTAssertEqual(r.carbsG, c.expect.carbs_g, accuracy: u.tolerance, "carbs: \(c.name)")
        }
        for c in u.unit_list_cases {
            let units = c.ref_type == .food
                ? foodUnits(try XCTUnwrap(catalog.food(c.ref_id)), catalog.portions(c.ref_id))
                : mealUnits(try XCTUnwrap(catalog.meal(c.ref_id)))
            XCTAssertEqual(units, c.expect, "unit list: \(c.ref_id)")
        }
        for c in u.cycle_cases {
            XCTAssertEqual(wouldCreateCycle(catalog, c.meal_id, c.candidate), c.expect, "cycle: \(c.candidate) into \(c.meal_id)")
        }
    }

    func testDoseVectors() throws {
        let d = try load("dose-vectors", as: DoseVectors.self)
        XCTAssertFalse(d.cases.isEmpty)
        for c in d.cases {
            var settings = d.settings
            if let correction = c.correction { settings.correction = correction }
            if let rounding = c.rounding { settings.rounding = rounding }
            let r = estimateDose(DoseInput(
                settings: settings, minutes: try parseHHMM(c.time),
                carbs: CarbResult(carbsG: c.carbs, complete: c.complete ?? true), bg: c.bg
            ))
            let e = c.expect
            XCTAssertEqual(r.window?.name, e.window, "window: \(c.name)")
            switch r {
            case .refused(let reason, _):
                XCTAssertFalse(e.ok, "unexpected refusal \(reason.rawValue): \(c.name)")
                XCTAssertEqual(reason.rawValue, e.reason, c.name)
            case .ok(let s):
                XCTAssertTrue(e.ok, "unexpected dose: \(c.name)")
                XCTAssertEqual(s.mealUnits, try XCTUnwrap(e.meal_units), accuracy: d.tolerance, "meal_units: \(c.name)")
                XCTAssertEqual(s.correctionUnits, try XCTUnwrap(e.correction_units), accuracy: d.tolerance, "correction_units: \(c.name)")
                XCTAssertEqual(s.rawUnits, try XCTUnwrap(e.raw_units), accuracy: d.tolerance, "raw_units: \(c.name)")
                XCTAssertEqual(s.units, try XCTUnwrap(e.units), accuracy: d.tolerance, "units: \(c.name)")
                XCTAssertEqual(s.roundedDown, e.rounded_down, "rounded_down: \(c.name)")
                if let breakdown = e.breakdown { XCTAssertEqual(formatBreakdown(s), breakdown, c.name) }
            }
        }
    }
}
```

- [ ] **Step 2: Run it**

Run: `ios/scripts/swift-test.sh CarbBookCore --filter VectorTests`
Expected: `Executed 2 tests, with 0 failures (0 unexpected)`. This task adds no production code: the vectors exercise Tasks 4–7. If a case fails, fix the Swift port to match `packages/core/src`; never edit the copied vectors (Task 1's `--check` would fail CI anyway).

- [ ] **Step 3: Prove the test really reads the vectors**

Run: `cd ~/Projects/CarbBook && sed -i 's/"units": 11, "rounded_down": false,$/"units": 12, "rounded_down": false,/' ios/CarbBookCore/Tests/CarbBookCoreTests/Resources/dose-vectors.json && ios/scripts/swift-test.sh CarbBookCore --filter VectorTests; ios/scripts/sync-testdata.sh`
Expected: the first run FAILS with `XCTAssertEqual failed: ("11.0") is not equal to ("12.0") +/- ("1e-06") - units: breakdown text` and `Executed 2 tests, with 1 failure (0 unexpected)`; the final `sync-testdata.sh` restores the copy and prints `testdata vectors in sync`.

- [ ] **Step 4: Commit**

```bash
cd ~/Projects/CarbBook
git add ios/CarbBookCore/Tests/CarbBookCoreTests/VectorTests.swift
git commit -m "test(ios-core): run shared units and dose vectors"
```

---

### Task 9: Sync primitives, wire types and UUIDv7

**Files:**
- Create: `ios/CarbBookCore/Sources/CarbBookCore/Sync.swift`
- Create: `ios/CarbBookCore/Sources/CarbBookCore/UUIDv7.swift`
- Test: `ios/CarbBookCore/Tests/CarbBookCoreTests/SyncTests.swift`

`isNewer` compares `updated_by` as JS strings (`Array(updated_by.utf16)` order). `shouldApplyPulled` is the client merge rule (decision 5). Wire structs match `POST /api/sync/push` and `GET /api/sync/pull`. New rows get UUIDv7 ids (spec §3).

- [ ] **Step 1: Write the failing test**

`ios/CarbBookCore/Tests/CarbBookCoreTests/SyncTests.swift`:
```swift
import XCTest
@testable import CarbBookCore

final class SyncTests: XCTestCase {
    func testIsNewer() {
        XCTAssertTrue(isNewer(RecordVersion(updatedAt: 1, updatedBy: "a"), than: nil))
        XCTAssertTrue(isNewer(RecordVersion(updatedAt: 2, updatedBy: "a"), than: RecordVersion(updatedAt: 1, updatedBy: "z")))
        XCTAssertFalse(isNewer(RecordVersion(updatedAt: 1, updatedBy: "z"), than: RecordVersion(updatedAt: 2, updatedBy: "a")))
        XCTAssertTrue(isNewer(RecordVersion(updatedAt: 5, updatedBy: "phone"), than: RecordVersion(updatedAt: 5, updatedBy: "laptop")))
        XCTAssertFalse(isNewer(RecordVersion(updatedAt: 5, updatedBy: "laptop"), than: RecordVersion(updatedAt: 5, updatedBy: "phone")))
        XCTAssertFalse(isNewer(RecordVersion(updatedAt: 5, updatedBy: "phone"), than: RecordVersion(updatedAt: 5, updatedBy: "phone")))
        // Tie-break follows JS string order, not Swift's.
        XCTAssertTrue(isNewer(RecordVersion(updatedAt: 5, updatedBy: "\u{FF61}"), than: RecordVersion(updatedAt: 5, updatedBy: "\u{1F600}")))
    }

    func testShouldApplyPulled() {
        let older = RecordVersion(updatedAt: 1, updatedBy: "laptop")
        let newer = RecordVersion(updatedAt: 2, updatedBy: "phone")
        XCTAssertTrue(shouldApplyPulled(incoming: older, local: nil, localPending: false))
        XCTAssertTrue(shouldApplyPulled(incoming: older, local: newer, localPending: false))
        XCTAssertFalse(shouldApplyPulled(incoming: older, local: newer, localPending: true))
        XCTAssertTrue(shouldApplyPulled(incoming: newer, local: older, localPending: true))
        XCTAssertTrue(shouldApplyPulled(incoming: newer, local: newer, localPending: true))
    }

    func testWireFormatDecodes() throws {
        let push = #"{"results":[{"table":"food","id":"f1","status":"accepted","server_seq":7},{"table":"meal","id":"m1","status":"rejected","reason":"cycle","message":"meal would contain itself"}],"server_seq":7}"#
        let response = try JSONDecoder().decode(PushResponse.self, from: Data(push.utf8))
        XCTAssertEqual(response.serverSeq, 7)
        XCTAssertEqual(response.results[1], PushResult(table: "meal", id: "m1", status: "rejected", reason: "cycle", message: "meal would contain itself"))
        let pull = #"{"changes":[{"table":"food","record":{"id":"f1","name":"Tortilla","updated_at":1000,"updated_by":"phone","deleted":0,"server_seq":7}}],"next_since":7,"has_more":false}"#
        let page = try JSONDecoder().decode(PullResponse.self, from: Data(pull.utf8))
        XCTAssertEqual(page.nextSince, 7)
        XCTAssertEqual(page.changes[0].key, "food/f1")
        XCTAssertEqual(page.changes[0].version, RecordVersion(updatedAt: 1000, updatedBy: "phone"))
    }

    func testUUIDv7Layout() {
        struct Fixed: RandomNumberGenerator {
            let value: UInt64
            mutating func next() -> UInt64 { value }
        }
        var zeros = Fixed(value: 0)
        XCTAssertEqual(UUIDv7.make(nowMs: 0x0123_4567_89AB, using: &zeros), "01234567-89ab-7000-8000-000000000000")
        var ones = Fixed(value: .max)
        XCTAssertEqual(UUIDv7.make(nowMs: 0x0123_4567_89AB, using: &ones), "01234567-89ab-7fff-bfff-ffffffffffff")
        let earlier = UUIDv7.make(nowMs: 1_000)
        let later = UUIDv7.make(nowMs: 2_000)
        XCTAssertTrue(JS.less(earlier, later))
        XCTAssertEqual(later.count, 36)
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `ios/scripts/swift-test.sh CarbBookCore --filter SyncTests`
Expected: build FAILS with `error: cannot find 'isNewer' in scope`.

- [ ] **Step 3: Implement**

`ios/CarbBookCore/Sources/CarbBookCore/Sync.swift`:
```swift
import Foundation

/// Mirrors packages/core/src/sync.ts plus the wire format of POST /api/sync/push and
/// GET /api/sync/pull (server-data plan, "Wire formats").
public struct RecordVersion: Equatable, Sendable {
    public var updatedAt: Int64
    public var updatedBy: String

    public init(updatedAt: Int64, updatedBy: String) {
        self.updatedAt = updatedAt
        self.updatedBy = updatedBy
    }
}

/// Last-write-wins: newer timestamp wins; equal timestamps go to the higher device id, compared
/// as JS strings (UTF-16 code units). An exact replay is not newer.
public func isNewer(_ incoming: RecordVersion, than stored: RecordVersion?) -> Bool {
    guard let stored else { return true }
    if incoming.updatedAt != stored.updatedAt { return incoming.updatedAt > stored.updatedAt }
    return JS.greater(incoming.updatedBy, stored.updatedBy)
}

/// A pulled record overwrites the local row unless the local row has an unpushed change that
/// beats it under LWW (that change is pushed on the next sync and wins on the server too).
public func shouldApplyPulled(incoming: RecordVersion, local: RecordVersion?, localPending: Bool) -> Bool {
    guard let local, localPending else { return true }
    return !isNewer(local, than: incoming)
}

public enum SyncTables {
    /// Synced tables, in the server's pull order.
    public static let all = ["food", "portion", "barcode", "meal", "meal_item", "log_entry", "log_item", "dose_settings"]
}

public struct SyncChange: Codable, Equatable, Sendable {
    public var table: String
    public var record: [String: JSONValue]

    public init(table: String, record: [String: JSONValue]) {
        self.table = table
        self.record = record
    }

    public var id: String? { record["id"]?.stringValue }
    public var key: String { "\(table)/\(id ?? "")" }

    public var version: RecordVersion? {
        guard let at = record["updated_at"]?.int64Value, let by = record["updated_by"]?.stringValue else { return nil }
        return RecordVersion(updatedAt: at, updatedBy: by)
    }
}

public struct PushRequest: Codable, Equatable, Sendable {
    public var changes: [SyncChange]
    public init(changes: [SyncChange]) { self.changes = changes }
}

public struct PushResult: Codable, Equatable, Sendable {
    public var table: String
    public var id: String
    /// "accepted" | "ignored" | "rejected"
    public var status: String
    public var serverSeq: Int64?
    /// "unknown_table" | "invalid" | "forbidden" | "cycle" when rejected
    public var reason: String?
    public var message: String?

    public init(table: String, id: String, status: String, serverSeq: Int64? = nil, reason: String? = nil, message: String? = nil) {
        self.table = table; self.id = id; self.status = status; self.serverSeq = serverSeq
        self.reason = reason; self.message = message
    }

    public var key: String { "\(table)/\(id)" }

    enum CodingKeys: String, CodingKey {
        case table, id, status, reason, message
        case serverSeq = "server_seq"
    }
}

public struct PushResponse: Codable, Equatable, Sendable {
    public var results: [PushResult]
    public var serverSeq: Int64

    public init(results: [PushResult], serverSeq: Int64) {
        self.results = results
        self.serverSeq = serverSeq
    }

    enum CodingKeys: String, CodingKey {
        case results
        case serverSeq = "server_seq"
    }
}

public struct PullResponse: Codable, Equatable, Sendable {
    public var changes: [SyncChange]
    public var nextSince: Int64
    public var hasMore: Bool

    public init(changes: [SyncChange], nextSince: Int64, hasMore: Bool) {
        self.changes = changes
        self.nextSince = nextSince
        self.hasMore = hasMore
    }

    enum CodingKeys: String, CodingKey {
        case changes
        case nextSince = "next_since"
        case hasMore = "has_more"
    }
}
```

`ios/CarbBookCore/Sources/CarbBookCore/UUIDv7.swift`:
```swift
import Foundation

/// UUIDv7 (RFC 9562) as lowercase text: 48-bit Unix ms, version 7, 74 random bits.
/// Ids sort by creation time, which the spec's §3 `id` column expects.
public enum UUIDv7 {
    private static let hex = Array("0123456789abcdef")

    public static func make<R: RandomNumberGenerator>(nowMs: Int64, using rng: inout R) -> String {
        var bytes = [UInt8](repeating: 0, count: 16)
        let ms = UInt64(max(0, nowMs)) & 0xFFFF_FFFF_FFFF
        for i in 0..<6 { bytes[i] = UInt8(truncatingIfNeeded: ms >> (UInt64(5 - i) * 8)) }
        let high: UInt64 = rng.next()
        let low: UInt64 = rng.next()
        for i in 6..<14 { bytes[i] = UInt8(truncatingIfNeeded: high >> (UInt64(i - 6) * 8)) }
        for i in 14..<16 { bytes[i] = UInt8(truncatingIfNeeded: low >> (UInt64(i - 14) * 8)) }
        bytes[6] = (bytes[6] & 0x0F) | 0x70
        bytes[8] = (bytes[8] & 0x3F) | 0x80
        var out = ""
        for (i, b) in bytes.enumerated() {
            if [4, 6, 8, 10].contains(i) { out.append("-") }
            out.append(hex[Int(b >> 4)])
            out.append(hex[Int(b & 0x0F)])
        }
        return out
    }

    public static func make(nowMs: Int64) -> String {
        var rng = SystemRandomNumberGenerator()
        return make(nowMs: nowMs, using: &rng)
    }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `ios/scripts/swift-test.sh CarbBookCore --filter SyncTests`
Expected: `Executed 4 tests, with 0 failures (0 unexpected)` and no `warning:` lines for CarbBookCore sources.

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/CarbBook
git add ios/CarbBookCore/Sources/CarbBookCore/Sync.swift ios/CarbBookCore/Sources/CarbBookCore/UUIDv7.swift ios/CarbBookCore/Tests/CarbBookCoreTests/SyncTests.swift
git commit -m "feat(ios-core): LWW compare, pull merge rule, sync wire types, UUIDv7"
```

---

### Task 10: Sync engine

**Files:**
- Create: `ios/CarbBookCore/Sources/CarbBookCore/SyncEngine.swift`
- Test: `ios/CarbBookCore/Tests/CarbBookCoreTests/SyncEngineTests.swift`

Spec §5: push pending changes in batches of at most 500, record per-record results, then pull pages of 500 until `has_more` is false, then stamp last-synced. Any thrown error (e.g. 401) leaves pending changes and the cursor untouched. The test actors model the GRDB store and the server so two-client scenarios (offline edits, LWW ties, soft deletes, rejections, paging) are covered without a network.

- [ ] **Step 1: Write the failing test**

`ios/CarbBookCore/Tests/CarbBookCoreTests/SyncEngineTests.swift`:
```swift
import XCTest
@testable import CarbBookCore

/// In-memory client store with the same rules the GRDB store implements.
actor MemorySyncStore: SyncStore {
    let deviceId: String
    var rows: [String: SyncChange] = [:]
    var pending: [String] = []
    var rejections: [PushResult] = []
    var cursor: Int64 = 0
    var lastSynced: Int64?

    init(deviceId: String) { self.deviceId = deviceId }

    func write(_ table: String, _ fields: [String: JSONValue], at ms: Int64, deleted: Bool = false) {
        var record = fields
        record["updated_at"] = .number(Double(ms))
        record["updated_by"] = .string(deviceId)
        record["deleted"] = .number(deleted ? 1 : 0)
        let change = SyncChange(table: table, record: record)
        rows[change.key] = change
        if !pending.contains(change.key) { pending.append(change.key) }
    }

    func name(_ key: String) -> String? { rows[key]?.record["name"]?.stringValue }
    func isDeleted(_ key: String) -> Bool { rows[key]?.record["deleted"] == .number(1) }

    func pendingChanges(limit: Int) -> [SyncChange] { pending.prefix(limit).compactMap { rows[$0] } }

    func recordPushResults(_ pushed: [SyncChange], _ results: [PushResult]) {
        let byKey = Dictionary(uniqueKeysWithValues: pushed.map { ($0.key, $0) })
        for result in results {
            guard let sent = byKey[result.key] else { continue }
            if result.status == "rejected" {
                rejections.append(result)
                pending.removeAll { $0 == result.key }
            } else if rows[result.key]?.version == sent.version {
                pending.removeAll { $0 == result.key }
            }
        }
    }

    func pullCursor() -> Int64 { cursor }

    func applyPull(_ changes: [SyncChange], nextSince: Int64) {
        for change in changes {
            guard let incoming = change.version else { continue }
            let isPending = pending.contains(change.key)
            if shouldApplyPulled(incoming: incoming, local: rows[change.key]?.version, localPending: isPending) {
                var record = change.record
                record.removeValue(forKey: "server_seq")
                rows[change.key] = SyncChange(table: change.table, record: record)
                pending.removeAll { $0 == change.key }
            }
        }
        cursor = nextSince
    }

    func setLastSynced(_ ms: Int64) { lastSynced = ms }
}

/// Minimal server: LWW via `isNewer`, one server_seq per accepted write, paged pull.
actor FakeServer: SyncTransport {
    var rows: [String: SyncChange] = [:]
    var seq: Int64 = 0
    var failNextWith: Error?

    func push(_ changes: [SyncChange]) throws -> PushResponse {
        if let error = failNextWith { failNextWith = nil; throw error }
        var results: [PushResult] = []
        for change in changes {
            let id = change.id ?? ""
            guard SyncTables.all.contains(change.table) else {
                results.append(PushResult(table: change.table, id: id, status: "rejected", reason: "unknown_table", message: "unknown table"))
                continue
            }
            let stored = rows[change.key]
            if let incoming = change.version, isNewer(incoming, than: stored?.version) {
                seq += 1
                var record = change.record
                record["server_seq"] = .number(Double(seq))
                rows[change.key] = SyncChange(table: change.table, record: record)
                results.append(PushResult(table: change.table, id: id, status: "accepted", serverSeq: seq))
            } else {
                results.append(PushResult(table: change.table, id: id, status: "ignored", serverSeq: stored?.record["server_seq"]?.int64Value))
            }
        }
        return PushResponse(results: results, serverSeq: seq)
    }

    func pull(since: Int64, limit: Int) -> PullResponse {
        let newer = rows.values
            .filter { ($0.record["server_seq"]?.int64Value ?? 0) > since }
            .sorted { $0.record["server_seq"]!.int64Value! < $1.record["server_seq"]!.int64Value! }
        let page = Array(newer.prefix(limit))
        return PullResponse(changes: page, nextSince: page.last?.record["server_seq"]?.int64Value ?? since, hasMore: newer.count > limit)
    }

    func failNextPush(_ error: Error) { failNextWith = error }
}

struct Unauthorized: Error {}

final class SyncEngineTests: XCTestCase {
    func testOfflineEditsConvergeWithLastWriteWinning() async throws {
        let server = FakeServer()
        let phone = MemorySyncStore(deviceId: "phone")
        let laptop = MemorySyncStore(deviceId: "laptop")
        await phone.write("food", ["id": .string("f1"), "name": .string("Tortilla")], at: 1_000)
        _ = try await SyncEngine(store: phone, transport: server).run { 1_100 }
        _ = try await SyncEngine(store: laptop, transport: server).run { 1_200 }
        let laptopName = await laptop.name("food/f1")
        XCTAssertEqual(laptopName, "Tortilla")

        // Both edit offline; the laptop's edit is later.
        await phone.write("food", ["id": .string("f1"), "name": .string("Flour tortilla")], at: 2_000)
        await laptop.write("food", ["id": .string("f1"), "name": .string("Corn tortilla")], at: 3_000)
        let laptopReport = try await SyncEngine(store: laptop, transport: server).run { 3_100 }
        XCTAssertEqual(laptopReport.accepted, 1)
        let phoneReport = try await SyncEngine(store: phone, transport: server).run { 3_200 }
        XCTAssertEqual(phoneReport.ignored, 1)
        let phoneName = await phone.name("food/f1")
        let phonePending = await phone.pending
        let phoneLastSynced = await phone.lastSynced
        XCTAssertEqual(phoneName, "Corn tortilla")
        XCTAssertEqual(phonePending, [])
        XCTAssertEqual(phoneLastSynced, 3_200)
    }

    func testEqualTimestampsGoToHigherDeviceId() async throws {
        let server = FakeServer()
        let phone = MemorySyncStore(deviceId: "phone")
        let laptop = MemorySyncStore(deviceId: "laptop")
        await laptop.write("meal", ["id": .string("m1"), "name": .string("Laptop tacos")], at: 5_000)
        await phone.write("meal", ["id": .string("m1"), "name": .string("Phone tacos")], at: 5_000)
        _ = try await SyncEngine(store: laptop, transport: server).run { 5_100 }
        _ = try await SyncEngine(store: phone, transport: server).run { 5_200 }
        _ = try await SyncEngine(store: laptop, transport: server).run { 5_300 }
        let laptopName = await laptop.name("meal/m1")
        let phoneName = await phone.name("meal/m1")
        XCTAssertEqual(laptopName, "Phone tacos")
        XCTAssertEqual(phoneName, "Phone tacos")
    }

    func testSoftDeletePropagates() async throws {
        let server = FakeServer()
        let phone = MemorySyncStore(deviceId: "phone")
        let laptop = MemorySyncStore(deviceId: "laptop")
        await phone.write("food", ["id": .string("f1"), "name": .string("Rice")], at: 1_000)
        _ = try await SyncEngine(store: phone, transport: server).run { 1_000 }
        _ = try await SyncEngine(store: laptop, transport: server).run { 1_000 }
        await laptop.write("food", ["id": .string("f1"), "name": .string("Rice")], at: 2_000, deleted: true)
        _ = try await SyncEngine(store: laptop, transport: server).run { 2_000 }
        _ = try await SyncEngine(store: phone, transport: server).run { 2_000 }
        let deleted = await phone.isDeleted("food/f1")
        XCTAssertTrue(deleted)
    }

    func testRejectionsAreKeptAndClearedFromPending() async throws {
        let server = FakeServer()
        let phone = MemorySyncStore(deviceId: "phone")
        await phone.write("recipe", ["id": .string("r1")], at: 1_000)
        let report = try await SyncEngine(store: phone, transport: server).run { 1_000 }
        XCTAssertEqual(report.rejected.map(\.reason), ["unknown_table"])
        let pending = await phone.pending
        let rejections = await phone.rejections
        XCTAssertEqual(pending, [])
        XCTAssertEqual(rejections.count, 1)
    }

    func testPullPagesUntilDrained() async throws {
        let server = FakeServer()
        let phone = MemorySyncStore(deviceId: "phone")
        for i in 1...1_203 {
            await phone.write("food", ["id": .string("f\(i)"), "name": .string("Food \(i)")], at: Int64(i))
        }
        let laptop = MemorySyncStore(deviceId: "laptop")
        let pushReport = try await SyncEngine(store: phone, transport: server).run { 2_000 }
        XCTAssertEqual(pushReport.accepted, 1_203) // three push batches of ≤500
        let pullReport = try await SyncEngine(store: laptop, transport: server).run { 2_000 }
        XCTAssertEqual(pullReport.pulled, 1_203)
        let cursor = await laptop.cursor
        XCTAssertEqual(cursor, 1_203)
    }

    func testFailedPushKeepsPendingAndCursor() async throws {
        let server = FakeServer()
        let phone = MemorySyncStore(deviceId: "phone")
        await phone.write("food", ["id": .string("f1"), "name": .string("Rice")], at: 1_000)
        await server.failNextPush(Unauthorized())
        do {
            _ = try await SyncEngine(store: phone, transport: server).run { 1_000 }
            XCTFail("expected an error")
        } catch is Unauthorized {}
        let pending = await phone.pending
        let lastSynced = await phone.lastSynced
        XCTAssertEqual(pending, ["food/f1"])
        XCTAssertNil(lastSynced)
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `ios/scripts/swift-test.sh CarbBookCore --filter SyncEngineTests`
Expected: build FAILS with `error: cannot find type 'SyncStore' in scope`.

- [ ] **Step 3: Implement**

`ios/CarbBookCore/Sources/CarbBookCore/SyncEngine.swift`:
```swift
import Foundation

/// Local persistence the sync engine drives. The iOS app implements it with GRDB; tests use an actor.
public protocol SyncStore: Sendable {
    /// Unpushed local changes (full records), oldest first, at most `limit`.
    func pendingChanges(limit: Int) async throws -> [SyncChange]
    /// accepted/ignored: clear the pending mark if the row still has the pushed version.
    /// rejected: keep the row, save the rejection for Settings → Sync, clear the pending mark.
    func recordPushResults(_ pushed: [SyncChange], _ results: [PushResult]) async throws
    func pullCursor() async throws -> Int64
    /// Applies pulled records using `shouldApplyPulled` and stores `nextSince`, atomically.
    func applyPull(_ changes: [SyncChange], nextSince: Int64) async throws
    func setLastSynced(_ ms: Int64) async throws
}

/// The server API. The iOS app implements it with URLSession.
public protocol SyncTransport: Sendable {
    func push(_ changes: [SyncChange]) async throws -> PushResponse
    func pull(since: Int64, limit: Int) async throws -> PullResponse
}

public struct SyncReport: Equatable, Sendable {
    public var accepted = 0
    public var ignored = 0
    public var rejected: [PushResult] = []
    public var pulled = 0

    public init() {}
}

/// Spec §5: push pending changes, then pull until drained. Any thrown error leaves pending
/// changes and the pull cursor as they were, so the next run retries.
public struct SyncEngine: Sendable {
    public static let maxPushChanges = 500
    public static let pullLimit = 500
    /// Bounds the push loop if rows keep changing while a push is in flight.
    public static let maxPushBatches = 20

    public let store: SyncStore
    public let transport: SyncTransport

    public init(store: SyncStore, transport: SyncTransport) {
        self.store = store
        self.transport = transport
    }

    public func run(nowMs: @Sendable () -> Int64) async throws -> SyncReport {
        var report = SyncReport()
        for _ in 0..<Self.maxPushBatches {
            let batch = try await store.pendingChanges(limit: Self.maxPushChanges)
            if batch.isEmpty { break }
            let response = try await transport.push(batch)
            try await store.recordPushResults(batch, response.results)
            for result in response.results {
                switch result.status {
                case "accepted": report.accepted += 1
                case "ignored": report.ignored += 1
                default: report.rejected.append(result)
                }
            }
            if batch.count < Self.maxPushChanges { break }
        }

        var since = try await store.pullCursor()
        while true {
            let page = try await transport.pull(since: since, limit: Self.pullLimit)
            try await store.applyPull(page.changes, nextSince: page.nextSince)
            report.pulled += page.changes.count
            let advanced = page.nextSince > since
            since = page.nextSince
            if !page.hasMore || !advanced { break }
        }
        try await store.setLastSynced(nowMs())
        return report
    }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `ios/scripts/swift-test.sh CarbBookCore --filter SyncEngineTests`
Expected: `Executed 6 tests, with 0 failures (0 unexpected)` and no `warning:` lines for CarbBookCore sources.

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/CarbBook
git add ios/CarbBookCore/Sources/CarbBookCore/SyncEngine.swift ios/CarbBookCore/Tests/CarbBookCoreTests/SyncEngineTests.swift
git commit -m "feat(ios-core): push-then-pull sync engine"
```

---

### Task 11: Search query and barcode helpers

**Files:**
- Create: `ios/CarbBookCore/Sources/CarbBookCore/Search.swift`
- Test: `ios/CarbBookCore/Tests/CarbBookCoreTests/SearchHelpersTests.swift`

Ports of the server's `toFtsQuery` (lower-case, split on non letter/number, max 8 prefix tokens) and `barcodeCandidates` (UPC-A/EAN-13 zero padding), so offline search and offline barcode lookups behave like the server.

- [ ] **Step 1: Write the failing test**

`ios/CarbBookCore/Tests/CarbBookCoreTests/SearchHelpersTests.swift`:
```swift
import XCTest
@testable import CarbBookCore

final class SearchHelpersTests: XCTestCase {
    func testToFtsQuery() {
        XCTAssertEqual(toFtsQuery("pea but"), #""pea"* "but"*"#)
        XCTAssertEqual(toFtsQuery("Crème Brûlée!"), #""crème"* "brûlée"*"#)
        XCTAssertEqual(toFtsQuery("  !! "), nil)
        XCTAssertEqual(toFtsQuery("a b c d e f g h i j"), #""a"* "b"* "c"* "d"* "e"* "f"* "g"* "h"*"#)
        XCTAssertEqual(toFtsQuery("2% milk"), #""2"* "milk"*"#)
    }

    func testBarcodeCandidates() {
        XCTAssertEqual(barcodeCandidates("737628064502"), ["737628064502", "0737628064502"])
        XCTAssertEqual(barcodeCandidates("0737628064502"), ["0737628064502", "737628064502"])
        XCTAssertEqual(barcodeCandidates("000000"), ["000000", "0", "000000000000", "0000000000000"])
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `ios/scripts/swift-test.sh CarbBookCore --filter SearchHelpersTests`
Expected: build FAILS with `error: cannot find 'toFtsQuery' in scope`.

- [ ] **Step 3: Implement**

`ios/CarbBookCore/Sources/CarbBookCore/Search.swift`:
```swift
import Foundation

/// Turns user input into an FTS5 prefix query: `pea but` → `"pea"* "but"*` (server search.ts).
public func toFtsQuery(_ input: String) -> String? {
    var tokens: [String] = []
    var current = String.UnicodeScalarView()
    func flush() {
        if !current.isEmpty {
            tokens.append(String(current))
            current = String.UnicodeScalarView()
        }
    }
    for scalar in input.lowercased().unicodeScalars {
        switch scalar.properties.generalCategory {
        case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter, .otherLetter,
             .decimalNumber, .letterNumber, .otherNumber:
            current.append(scalar)
        default:
            flush()
        }
    }
    flush()
    guard !tokens.isEmpty else { return nil }
    return tokens.prefix(8).map { "\"\($0)\"*" }.joined(separator: " ")
}

/// UPC-A/EAN-13 variants so "737628064502" finds a stored "0737628064502" and vice versa (server normalize.ts).
public func barcodeCandidates(_ code: String) -> [String] {
    let withoutZeros = String(code.drop(while: { $0 == "0" }))
    let stripped = withoutZeros.isEmpty ? "0" : withoutZeros
    func pad(_ s: String, _ length: Int) -> String {
        s.count >= length ? s : String(repeating: "0", count: length - s.count) + s
    }
    var seen = Set<String>()
    return [code, stripped, pad(stripped, 12), pad(stripped, 13)].filter { seen.insert($0).inserted }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `ios/scripts/swift-test.sh CarbBookCore --filter SearchHelpersTests`
Expected: `Executed 2 tests, with 0 failures (0 unexpected)` and no `warning:` lines for CarbBookCore sources.

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/CarbBook
git add ios/CarbBookCore/Sources/CarbBookCore/Search.swift ios/CarbBookCore/Tests/CarbBookCoreTests/SearchHelpersTests.swift
git commit -m "feat(ios-core): FTS5 query builder and barcode candidates"
```

---

### Task 12: Food record builders

**Files:**
- Create: `ios/CarbBookCore/Sources/CarbBookCore/FoodBuilders.swift`
- Test: `ios/CarbBookCore/Tests/CarbBookCoreTests/FoodBuildersTests.swift`

Food editor validation with the server's push rules (`carbs_per_100g`/`fiber_per_100g` within 0–100, density > 0), label math for **Foods → create from label**, the USDA copy made the first time a USDA food is used in a meal or log (`source='usda'`, `source_ref=<fdc_id>`, portions copied), and the records saved after confirming an Open Food Facts draft.

- [ ] **Step 1: Write the failing test**

`ios/CarbBookCore/Tests/CarbBookCoreTests/FoodBuildersTests.swift`:
```swift
import XCTest
@testable import CarbBookCore

final class FoodBuildersTests: XCTestCase {
    func testCarbsPer100gFromLabel() {
        XCTAssertEqual(carbsPer100gFromLabel(servingGrams: 30, carbsPerServing: 22)!, 73.3333333, accuracy: 1e-6)
        XCTAssertNil(carbsPer100gFromLabel(servingGrams: 0, carbsPerServing: 5))
        XCTAssertNil(carbsPer100gFromLabel(servingGrams: 30, carbsPerServing: -1))
        XCTAssertNil(carbsPer100gFromLabel(servingGrams: 30, carbsPerServing: 31))
    }

    func testValidateFood() {
        XCTAssertNil(validateFood(FoodData(id: "f", name: "Oats", carbsPer100g: 66, fiberPer100g: 10)))
        XCTAssertNil(validateFood(FoodData(id: "f", name: "Unlabeled", carbsPer100g: nil)))
        XCTAssertEqual(validateFood(FoodData(id: "f", name: " ", carbsPer100g: 1)), "name must not be empty")
        XCTAssertEqual(validateFood(FoodData(id: "f", name: "Sugar", carbsPer100g: 100.5)), "carbs_per_100g must be between 0 and 100")
        XCTAssertEqual(validateFood(FoodData(id: "f", name: "Bran", carbsPer100g: 60, fiberPer100g: -1)), "fiber_per_100g must be between 0 and 100")
        XCTAssertEqual(validateFood(FoodData(id: "f", name: "Milk", carbsPer100g: 5, densityGPerMl: 0)), "density_g_per_ml must be > 0")
    }

    func testCopyUsdaFood() {
        var n = 0
        let ids = { () -> Id in n += 1; return "id\(n)" }
        let usda = UsdaFood(fdcId: 168878, name: "Rice, white, cooked", carbsPer100g: 28.2, fiberPer100g: 0.4)
        let portion = UsdaPortion(id: 9, fdcId: 168878, label: "cup", kind: "volume", quantity: 1, grams: 158, description: "1 cup")
        let copy = copyUsdaFood(usda, portions: [portion], newId: ids)
        XCTAssertEqual(copy.food, FoodData(id: "id1", name: "Rice, white, cooked", source: "usda", sourceRef: "168878", carbsPer100g: 28.2, fiberPer100g: 0.4))
        XCTAssertEqual(copy.portions, [PortionData(id: "id2", foodId: "id1", label: "cup", kind: "volume", quantity: 1, grams: 158)])
    }

    func testRecordsFromOffDraft() throws {
        let json = #"{"food":{"name":"Granola","brand":"Acme","source":"off","source_ref":"0737628064502","carbs_per_100g":64,"fiber_per_100g":null},"portions":[{"label":"label serving","kind":"serving","quantity":1,"grams":52}],"barcode":"0737628064502","serving_size":"1/2 cup (52 g)"}"#
        let draft = try JSONDecoder().decode(OffDraft.self, from: Data(json.utf8))
        var n = 0
        var edited = draft.food
        edited.name = "Acme granola"
        let records = recordsFromOffDraft(draft, confirmed: edited, newId: { n += 1; return "id\(n)" })
        XCTAssertEqual(records.food.name, "Acme granola")
        XCTAssertEqual(records.food.source, "off")
        XCTAssertEqual(records.portions.first?.grams, 52)
        XCTAssertEqual(records.barcode, BarcodeData(id: "id3", code: "0737628064502", foodId: "id1"))
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `ios/scripts/swift-test.sh CarbBookCore --filter FoodBuildersTests`
Expected: build FAILS with `error: cannot find 'carbsPer100gFromLabel' in scope`.

- [ ] **Step 3: Implement**

`ios/CarbBookCore/Sources/CarbBookCore/FoodBuilders.swift`:
```swift
import Foundation

/// Carbs per 100 g from a nutrition label ("serving 30 g, 22 g carbs" → 73.33).
/// nil when the serving weight is not positive, carbs are negative, or carbs exceed the serving.
public func carbsPer100gFromLabel(servingGrams: Double, carbsPerServing: Double) -> Double? {
    guard servingGrams.isFinite, servingGrams > 0, carbsPerServing.isFinite, carbsPerServing >= 0,
          carbsPerServing <= servingGrams else { return nil }
    return carbsPerServing / servingGrams * 100
}

/// Food editor validation with the server's push rules: non-empty name, `carbs_per_100g` and
/// `fiber_per_100g` within 0...100 (or empty), density above zero (or empty). nil when valid.
public func validateFood(_ food: FoodData) -> String? {
    if food.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "name must not be empty" }
    if let carbs = food.carbsPer100g, !(carbs.isFinite && carbs >= 0 && carbs <= 100) { return "carbs_per_100g must be between 0 and 100" }
    if let fiber = food.fiberPer100g, !(fiber.isFinite && fiber >= 0 && fiber <= 100) { return "fiber_per_100g must be between 0 and 100" }
    if let density = food.densityGPerMl, !(density.isFinite && density > 0) { return "density_g_per_ml must be > 0" }
    return nil
}

/// A row of the USDA SQLite bundle's `usda_food` table.
public struct UsdaFood: Equatable, Sendable {
    public var fdcId: Int64
    public var name: String
    public var carbsPer100g: Double?
    public var fiberPer100g: Double?

    public init(fdcId: Int64, name: String, carbsPer100g: Double?, fiberPer100g: Double?) {
        self.fdcId = fdcId; self.name = name; self.carbsPer100g = carbsPer100g; self.fiberPer100g = fiberPer100g
    }
}

/// A row of the USDA SQLite bundle's `usda_portion` table.
public struct UsdaPortion: Equatable, Sendable {
    public var id: Int64
    public var fdcId: Int64
    public var label: String
    public var kind: String
    public var quantity: Double
    public var grams: Double
    public var description: String

    public init(id: Int64, fdcId: Int64, label: String, kind: String, quantity: Double, grams: Double, description: String) {
        self.id = id; self.fdcId = fdcId; self.label = label; self.kind = kind
        self.quantity = quantity; self.grams = grams; self.description = description
    }
}

/// The synced copy of a USDA food used in a meal or log: `source = "usda"`, `source_ref = fdc_id`,
/// portions copied in bundle order. `newId` supplies UUIDv7 ids.
public func copyUsdaFood(_ usda: UsdaFood, portions: [UsdaPortion], newId: () -> Id) -> (food: FoodData, portions: [PortionData]) {
    let food = FoodData(id: newId(), name: usda.name, source: "usda", sourceRef: String(usda.fdcId),
                        carbsPer100g: usda.carbsPer100g, fiberPer100g: usda.fiberPer100g)
    let copied = portions.map {
        PortionData(id: newId(), foodId: food.id, label: $0.label, kind: $0.kind, quantity: $0.quantity, grams: $0.grams)
    }
    return (food, copied)
}

/// `draft` from GET /api/barcode/:code (server normalize.ts `FoodDraft`).
public struct OffDraft: Codable, Equatable, Sendable {
    public struct Food: Codable, Equatable, Sendable {
        public var name: String
        public var brand: String?
        public var source: String
        public var sourceRef: String
        public var carbsPer100g: Double?
        public var fiberPer100g: Double?

        enum CodingKeys: String, CodingKey {
            case name, brand, source
            case sourceRef = "source_ref"
            case carbsPer100g = "carbs_per_100g"
            case fiberPer100g = "fiber_per_100g"
        }
    }

    public struct Portion: Codable, Equatable, Sendable {
        public var label: String
        public var kind: String
        public var quantity: Double
        public var grams: Double
    }

    public var food: Food
    public var portions: [Portion]
    public var barcode: String
    public var servingSize: String?

    enum CodingKeys: String, CodingKey {
        case food, portions, barcode
        case servingSize = "serving_size"
    }
}

/// A barcode row as synced (§3 `barcode`).
public struct BarcodeData: Codable, Equatable, Sendable {
    public var id: Id
    public var code: String
    public var foodId: Id

    public init(id: Id, code: String, foodId: Id) {
        self.id = id; self.code = code; self.foodId = foodId
    }

    enum CodingKeys: String, CodingKey {
        case id, code
        case foodId = "food_id"
    }
}

/// Records to save once the user confirms an Open Food Facts draft (possibly after editing `food`).
public func recordsFromOffDraft(_ draft: OffDraft, confirmed food: OffDraft.Food, newId: () -> Id)
    -> (food: FoodData, portions: [PortionData], barcode: BarcodeData) {
    let saved = FoodData(id: newId(), name: food.name, brand: food.brand, source: "off", sourceRef: food.sourceRef,
                         carbsPer100g: food.carbsPer100g, fiberPer100g: food.fiberPer100g)
    let portions = draft.portions.map {
        PortionData(id: newId(), foodId: saved.id, label: $0.label, kind: $0.kind, quantity: $0.quantity, grams: $0.grams)
    }
    return (saved, portions, BarcodeData(id: newId(), code: draft.barcode, foodId: saved.id))
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `ios/scripts/swift-test.sh CarbBookCore --filter FoodBuildersTests`
Expected: `Executed 4 tests, with 0 failures (0 unexpected)` and no `warning:` lines for CarbBookCore sources.

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/CarbBook
git add ios/CarbBookCore/Sources/CarbBookCore/FoodBuilders.swift ios/CarbBookCore/Tests/CarbBookCoreTests/FoodBuildersTests.swift
git commit -m "feat(ios-core): label math, USDA copy and OFF draft records"
```

---

### Task 13: Calculator evaluation and log/meal records

**Files:**
- Create: `ios/CarbBookCore/Sources/CarbBookCore/Calculator.swift`
- Test: `ios/CarbBookCore/Tests/CarbBookCoreTests/CalculatorTests.swift`

Everything the Calculator shows in one pure function: per-line carbs, total, active settings at the eating time, window (auto or user override, applied as that window's start time), the estimate with breakdown or refusal message, and the 4-hour recent-dose warning. `isBgReadingUsable` mirrors the server's freshness rule (≤ 15 min old, ≤ 2 min in the future). Record builders produce the rows for **Log it** and **Save as meal**.

- [ ] **Step 1: Write the failing test**

`ios/CarbBookCore/Tests/CarbBookCoreTests/CalculatorTests.swift`:
```swift
import XCTest
@testable import CarbBookCore

final class CalculatorTests: XCTestCase {
    let catalog = InMemoryCatalog(
        foods: [FoodData(id: "rice", name: "Rice", carbsPer100g: 28.2), FoodData(id: "mystery", name: "Mystery", carbsPer100g: nil)]
    )
    let utc: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "UTC")!
        return c
    }()
    // 2026-09-14 18:00 UTC
    let dinner = Date(timeIntervalSince1970: 1_789_408_800)

    func testSuggestsDoseWithBreakdown() {
        let lines = [CalculatorLine(id: "l1", refType: .food, refId: "rice", displayName: "Rice", amount: 255.3191489, unit: "g")]
        let result = evaluateCalculator(lines: lines, catalog: catalog, settingsVersions: [seedSettings], eatenAt: dinner,
                                        calendar: utc, windowOverride: nil, bg: .dexcom(mgdl: 263, trend: "Flat"),
                                        lastDoseAtMs: nil, nowMs: 1_789_408_800_000)
        XCTAssertEqual(result.estimate?.window?.name, "Dinner")
        XCTAssertEqual(result.breakdown, "72g ÷ 8 = 9.0 + BG 263 → 2u = 11.0 → 11u")
        XCTAssertNil(result.refusal)

        let (entry, items) = buildLogRecords(lines: lines, result: result, bg: .dexcom(mgdl: 263, trend: "Flat"),
                                             eatenAt: dinner, takenUnits: 10, notes: nil, newId: { "x" })
        XCTAssertEqual(entry.suggestedUnits, 11)
        XCTAssertEqual(entry.takenUnits, 10)
        XCTAssertEqual(entry.bgSource, "dexcom")
        XCTAssertEqual(entry.windowName, "Dinner")
        XCTAssertEqual(entry.settingsVersionId, "s1")
        XCTAssertEqual(entry.eatenAt, 1_789_408_800_000)
        XCTAssertEqual(items.first!.carbsG, 72, accuracy: 1e-6)
    }

    func testWindowOverrideAndRefusals() {
        let lines = [CalculatorLine(id: "l1", refType: .food, refId: "rice", displayName: "Rice", amount: 100, unit: "g")]
        let snack = evaluateCalculator(lines: lines, catalog: catalog, settingsVersions: [seedSettings], eatenAt: dinner,
                                       calendar: utc, windowOverride: "HS Snack", bg: .none, lastDoseAtMs: nil, nowMs: 0)
        XCTAssertEqual(snack.estimate?.window?.name, "HS Snack")

        let incomplete = evaluateCalculator(
            lines: lines + [CalculatorLine(id: "l2", refType: .food, refId: "mystery", displayName: "Mystery", amount: 10, unit: "g")],
            catalog: catalog, settingsVersions: [seedSettings], eatenAt: dinner, calendar: utc,
            windowOverride: nil, bg: .manual(mgdl: 120), lastDoseAtMs: 1_789_400_000_000, nowMs: 1_789_408_800_000)
        XCTAssertNil(incomplete.breakdown)
        XCTAssertEqual(incomplete.refusal, DoseRefusal.incompleteCarbs.message)
        XCTAssertTrue(incomplete.recentDoseWarning)

        let noSettings = evaluateCalculator(lines: lines, catalog: catalog, settingsVersions: [], eatenAt: dinner,
                                            calendar: utc, windowOverride: nil, bg: .none, lastDoseAtMs: nil, nowMs: 0)
        XCTAssertEqual(noSettings.refusal, noSettingsMessage)
    }

    func testBgFreshness() {
        let now: Int64 = 1_789_408_800_000
        XCTAssertTrue(isBgReadingUsable(readAtMs: now - 15 * 60_000, nowMs: now))
        XCTAssertFalse(isBgReadingUsable(readAtMs: now - 15 * 60_000 - 1, nowMs: now))
        XCTAssertTrue(isBgReadingUsable(readAtMs: now + 2 * 60_000, nowMs: now))
        XCTAssertFalse(isBgReadingUsable(readAtMs: now + 2 * 60_000 + 1, nowMs: now))
    }

    func testBuildMealRecords() {
        let lines = [
            CalculatorLine(id: "a", refType: .food, refId: "rice", displayName: "Rice", amount: 1, unit: "cup"),
            CalculatorLine(id: "b", refType: .meal, refId: "m0", displayName: "Beans", amount: 0.5, unit: "serving"),
        ]
        var n = 0
        let (meal, items) = buildMealRecords(name: "Rice bowl", yieldServings: 2, totalWeightG: nil, lines: lines, newId: { n += 1; return "id\(n)" })
        XCTAssertEqual(meal, MealData(id: "id1", name: "Rice bowl", yieldServings: 2, totalWeightG: nil))
        XCTAssertEqual(items.map(\.position), [0, 1])
        XCTAssertEqual(items[1].refType, .meal)
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `ios/scripts/swift-test.sh CarbBookCore --filter CalculatorTests`
Expected: build FAILS with `error: cannot find 'evaluateCalculator' in scope`.

- [ ] **Step 3: Implement**

`ios/CarbBookCore/Sources/CarbBookCore/Calculator.swift`:
```swift
import Foundation

/// One row on the Calculator screen.
public struct CalculatorLine: Equatable, Sendable, Identifiable {
    public var id: String
    public var refType: RefType
    public var refId: Id
    public var displayName: String
    public var amount: Double
    public var unit: String

    public init(id: String, refType: RefType, refId: Id, displayName: String, amount: Double, unit: String) {
        self.id = id; self.refType = refType; self.refId = refId
        self.displayName = displayName; self.amount = amount; self.unit = unit
    }
}

public enum BgInput: Equatable, Sendable {
    case none
    case dexcom(mgdl: Double, trend: String?)
    case manual(mgdl: Double)

    public var mgdl: Double? {
        switch self {
        case .none: nil
        case .dexcom(let mgdl, _), .manual(let mgdl): mgdl
        }
    }

    /// §3 `bg_source`
    public var source: String {
        switch self {
        case .none: "none"
        case .dexcom: "dexcom"
        case .manual: "manual"
        }
    }

    public var trend: String? { if case .dexcom(_, let trend) = self { trend } else { nil } }
}

public struct CalculatorResult: Equatable, Sendable {
    public var lineCarbs: [CarbResult]
    public var total: CarbResult
    public var settings: DoseSettingsData?
    public var estimate: DoseEstimate?
    /// Breakdown text when a dose is suggested.
    public var breakdown: String?
    /// Why there is no dose, when there is none.
    public var refusal: String?
    public var recentDoseWarning: Bool
}

/// A Dexcom reading prefills BG only when it is at most 15 minutes old and not more than
/// 2 minutes in the future (server /api/bg rule); otherwise the user enters BG manually.
public func isBgReadingUsable(readAtMs: Int64, nowMs: Int64) -> Bool {
    let age = nowMs - readAtMs
    return age <= 15 * 60_000 && age >= -2 * 60_000
}

public let noSettingsMessage = "No dose estimate: no dose settings are in effect yet."

/// Everything the Calculator shows, computed from the current lines and inputs.
/// `windowOverride` is a window name chosen by the user; the dose uses that window's start time.
public func evaluateCalculator(
    lines: [CalculatorLine],
    catalog: Catalog,
    settingsVersions: [DoseSettingsData],
    eatenAt: Date,
    calendar: Calendar = .current,
    windowOverride: String?,
    bg: BgInput,
    lastDoseAtMs: Int64?,
    nowMs: Int64
) -> CalculatorResult {
    let lineCarbs = lines.map { itemCarbs(catalog, $0.refType, $0.refId, $0.amount, $0.unit) }
    let total = sumCarbs(lineCarbs)
    let eatenMs = Int64((eatenAt.timeIntervalSince1970 * 1000).rounded())
    let settings = activeSettings(settingsVersions, eatenMs)
    var result = CalculatorResult(lineCarbs: lineCarbs, total: total, settings: settings, estimate: nil,
                                  breakdown: nil, refusal: nil,
                                  recentDoseWarning: recentDoseWarning(lastDoseAtMs, nowMs))
    guard let settings else {
        result.refusal = noSettingsMessage
        return result
    }
    var minutes = minutesOfDay(eatenAt, calendar: calendar)
    if let name = windowOverride, let window = settings.windows.first(where: { $0.name == name }),
       let start = try? parseHHMM(window.start) {
        minutes = start
    }
    let estimate = estimateDose(DoseInput(settings: settings, minutes: minutes, carbs: total, bg: bg.mgdl))
    result.estimate = estimate
    switch estimate {
    case .ok(let suggestion): result.breakdown = formatBreakdown(suggestion)
    case .refused(let reason, _): result.refusal = reason.message
    }
    return result
}

/// The log_entry + log_item records for "Log it".
public func buildLogRecords(
    lines: [CalculatorLine],
    result: CalculatorResult,
    bg: BgInput,
    eatenAt: Date,
    takenUnits: Double?,
    notes: String?,
    newId: () -> Id
) -> (entry: LogEntryData, items: [LogItemData]) {
    var suggested: Double?
    if case .ok(let s) = result.estimate { suggested = s.units }
    let entry = LogEntryData(
        id: newId(),
        eatenAt: Int64((eatenAt.timeIntervalSince1970 * 1000).rounded()),
        windowName: result.estimate?.window?.name,
        bgMgdl: bg.mgdl,
        bgSource: bg.source,
        bgTrend: bg.trend,
        totalCarbsG: result.total.carbsG,
        suggestedUnits: suggested,
        takenUnits: takenUnits,
        settingsVersionId: result.settings?.id,
        notes: notes
    )
    let items = zip(lines, result.lineCarbs).map { line, carbs in
        LogItemData(id: newId(), logEntryId: entry.id, refType: line.refType, refId: line.refId,
                    displayName: line.displayName, amount: line.amount, unit: line.unit, carbsG: carbs.carbsG)
    }
    return (entry, items)
}

/// The meal + meal_item records for "Save as meal".
public func buildMealRecords(
    name: String,
    yieldServings: Double,
    totalWeightG: Double?,
    lines: [CalculatorLine],
    newId: () -> Id
) -> (meal: MealData, items: [MealItemData]) {
    let meal = MealData(id: newId(), name: name, yieldServings: yieldServings, totalWeightG: totalWeightG)
    let items = lines.enumerated().map { index, line in
        MealItemData(id: newId(), mealId: meal.id, refType: line.refType, refId: line.refId,
                     amount: line.amount, unit: line.unit, position: index)
    }
    return (meal, items)
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `ios/scripts/swift-test.sh CarbBookCore --filter CalculatorTests`
Expected: `Executed 4 tests, with 0 failures (0 unexpected)` and no `warning:` lines for CarbBookCore sources.

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/CarbBook
git add ios/CarbBookCore/Sources/CarbBookCore/Calculator.swift ios/CarbBookCore/Tests/CarbBookCoreTests/CalculatorTests.swift
git commit -m "feat(ios-core): calculator evaluation, BG freshness, log and meal records"
```

---

### Task 14: Dose settings validation and new versions

**Files:**
- Create: `ios/CarbBookCore/Sources/CarbBookCore/DoseSettingsDraft.swift`
- Test: `ios/CarbBookCore/Tests/CarbBookCoreTests/DoseSettingsDraftTests.swift`

The Settings editor validates with the same rules and messages as the server's `dose_settings` push checks, and always saves a **new** version (fresh id, chosen effective date, windows sorted) because the server rejects edits and deletes of existing versions.

- [ ] **Step 1: Write the failing test**

`ios/CarbBookCore/Tests/CarbBookCoreTests/DoseSettingsDraftTests.swift`:
```swift
import XCTest
@testable import CarbBookCore

final class DoseSettingsDraftTests: XCTestCase {
    func testAcceptsSeedAndReportsServerMessages() {
        XCTAssertNil(validateDoseSettings(seedSettings))
        var s = seedSettings; s.windows = []
        XCTAssertEqual(validateDoseSettings(s), "windows must be an array of 1-24 windows")
        s = seedSettings; s.windows[0].name = " "
        XCTAssertEqual(validateDoseSettings(s), "every window needs a name")
        s = seedSettings; s.windows[1].start = "9:00"
        XCTAssertEqual(validateDoseSettings(s), "window \"AM Snack\" has invalid start \"9:00\"")
        s = seedSettings; s.windows[1].start = "05:00"
        XCTAssertEqual(validateDoseSettings(s), "duplicate window start 05:00")
        s = seedSettings; s.windows[2].ratioGPerUnit = 0
        XCTAssertEqual(validateDoseSettings(s), "window \"Lunch\" needs ratio_g_per_unit > 0")
        s = seedSettings; s.correction.threshold = -1
        XCTAssertEqual(validateDoseSettings(s), "correction.threshold must be >= 0")
        s = seedSettings; s.correction.mode = "sliding"
        XCTAssertEqual(validateDoseSettings(s), "correction.mode must be started, full or proportional")
        s = seedSettings; s.rounding.roundDownBelowBg = -5
        XCTAssertEqual(validateDoseSettings(s), "rounding.round_down_below_bg must be null or >= 0")
    }

    func testNewVersionSortsWindowsAndNeverReusesId() {
        var draft = seedSettings
        draft.windows.reverse()
        let version = newDoseSettingsVersion(from: draft, effectiveFrom: 1_789_000_000_000, newId: { "v2" })
        XCTAssertEqual(version.id, "v2")
        XCTAssertEqual(version.effectiveFrom, 1_789_000_000_000)
        XCTAssertEqual(version.windows.map(\.name), seedSettings.windows.map(\.name))
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `ios/scripts/swift-test.sh CarbBookCore --filter DoseSettingsDraftTests`
Expected: build FAILS with `error: cannot find 'validateDoseSettings' in scope`.

- [ ] **Step 3: Implement**

`ios/CarbBookCore/Sources/CarbBookCore/DoseSettingsDraft.swift`:
```swift
import Foundation

/// The server's dose_settings push checks (server-data plan, sync/tables.ts), so the Settings
/// editor refuses to save a version the server would reject. Messages match the server's.
public func validateDoseSettings(_ s: DoseSettingsData) -> String? {
    if s.windows.isEmpty || s.windows.count > 24 { return "windows must be an array of 1-24 windows" }
    var starts = Set<Int>()
    for window in s.windows {
        if window.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "every window needs a name" }
        guard let minutes = try? parseHHMM(window.start) else {
            return "window \"\(window.name)\" has invalid start \"\(window.start)\""
        }
        if !starts.insert(minutes).inserted { return "duplicate window start \(window.start)" }
        if !window.ratioGPerUnit.isFinite || window.ratioGPerUnit <= 0 {
            return "window \"\(window.name)\" needs ratio_g_per_unit > 0"
        }
    }
    let c = s.correction
    if !c.threshold.isFinite || c.threshold < 0 { return "correction.threshold must be >= 0" }
    if !c.step.isFinite || c.step <= 0 { return "correction.step must be > 0" }
    if !c.unitsPerStep.isFinite || c.unitsPerStep < 0 { return "correction.units_per_step must be >= 0" }
    if !["started", "full", "proportional"].contains(c.mode) { return "correction.mode must be started, full or proportional" }
    let r = s.rounding
    if !r.increment.isFinite || r.increment <= 0 { return "rounding.increment must be > 0" }
    if let below = r.roundDownBelowBg, !below.isFinite || below < 0 {
        return "rounding.round_down_below_bg must be null or >= 0"
    }
    if s.effectiveFrom < 0 { return "effective_from must be a non-negative integer (ms)" }
    return nil
}

/// A new dose settings version: windows sorted by start, fresh id. Old versions are never edited.
public func newDoseSettingsVersion(from draft: DoseSettingsData, effectiveFrom: Int64, newId: () -> Id) -> DoseSettingsData {
    var version = draft
    version.id = newId()
    version.effectiveFrom = effectiveFrom
    version.windows = draft.windows.sorted { ((try? parseHHMM($0.start)) ?? 0) < ((try? parseHHMM($1.start)) ?? 0) }
    return version
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `ios/scripts/swift-test.sh CarbBookCore --filter DoseSettingsDraftTests`
Expected: `Executed 2 tests, with 0 failures (0 unexpected)` and no `warning:` lines for CarbBookCore sources.

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/CarbBook
git add ios/CarbBookCore/Sources/CarbBookCore/DoseSettingsDraft.swift ios/CarbBookCore/Tests/CarbBookCoreTests/DoseSettingsDraftTests.swift
git commit -m "feat(ios-core): dose settings validation and append-only versions"
```

---

### Task 15: Log recalculation

**Files:**
- Create: `ios/CarbBookCore/Sources/CarbBookCore/LogRecalc.swift`
- Test: `ios/CarbBookCore/Tests/CarbBookCoreTests/LogRecalcTests.swift`

Log → **Recalculate from current meal** (decision 7).

- [ ] **Step 1: Write the failing test**

`ios/CarbBookCore/Tests/CarbBookCoreTests/LogRecalcTests.swift`:
```swift
import XCTest
@testable import CarbBookCore

final class LogRecalcTests: XCTestCase {
    func testRefreshesSnapshotFromCurrentCatalog() {
        let catalog = InMemoryCatalog(
            foods: [FoodData(id: "rice", name: "Rice, jasmine", carbsPer100g: 30)],
            meals: [MealData(id: "bowl", name: "Bowl", yieldServings: 2)],
            mealItems: [MealItemData(id: "i1", mealId: "bowl", refType: .food, refId: "rice", amount: 200, unit: "g", position: 0)]
        )
        let entry = LogEntryData(id: "e1", eatenAt: 1_789_408_800_000, windowName: "Dinner", bgMgdl: 150, bgSource: "manual",
                                 bgTrend: nil, totalCarbsG: 50, suggestedUnits: 6, takenUnits: 6, settingsVersionId: "s1", notes: nil)
        let items = [
            LogItemData(id: "x1", logEntryId: "e1", refType: .food, refId: "rice", displayName: "Rice", amount: 100, unit: "g", carbsG: 28),
            LogItemData(id: "x2", logEntryId: "e1", refType: .meal, refId: "bowl", displayName: "Old bowl", amount: 1, unit: "serving", carbsG: 22),
        ]
        let result = recalculateLogEntry(entry: entry, items: items, catalog: catalog, settingsVersions: [seedSettings])
        XCTAssertTrue(result.complete)
        XCTAssertEqual(result.items.map(\.displayName), ["Rice, jasmine", "Bowl"])
        XCTAssertEqual(result.items.map(\.carbsG), [30, 30])
        XCTAssertEqual(result.entry.totalCarbsG, 60)
        XCTAssertEqual(result.entry.suggestedUnits, 8) // Dinner 1:8 → 7.5 → half-up 8
        XCTAssertEqual(result.entry.takenUnits, 6)
        XCTAssertEqual(result.entry.settingsVersionId, "s1")
    }

    func testIncompleteItemsClearTheSuggestion() {
        let entry = LogEntryData(id: "e1", eatenAt: 1_789_408_800_000, windowName: "Dinner", bgMgdl: nil, bgSource: "none",
                                 bgTrend: nil, totalCarbsG: 10, suggestedUnits: 1, takenUnits: 1, settingsVersionId: "s1", notes: nil)
        let items = [LogItemData(id: "x1", logEntryId: "e1", refType: .food, refId: "gone", displayName: "Gone", amount: 1, unit: "g", carbsG: 10)]
        let result = recalculateLogEntry(entry: entry, items: items, catalog: InMemoryCatalog(), settingsVersions: [seedSettings])
        XCTAssertFalse(result.complete)
        XCTAssertNil(result.entry.suggestedUnits)
        XCTAssertEqual(result.items[0].displayName, "Gone")
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `ios/scripts/swift-test.sh CarbBookCore --filter LogRecalcTests`
Expected: build FAILS with `error: cannot find 'recalculateLogEntry' in scope`.

- [ ] **Step 3: Implement**

`ios/CarbBookCore/Sources/CarbBookCore/LogRecalc.swift`:
```swift
import Foundation

/// Log → "Recalculate from current meal": refreshes each item's name and carbs from the current
/// catalog, the entry total, and the suggested dose (with the entry's own settings version and
/// window when they still exist). `taken_units`, BG and time are left as logged.
public func recalculateLogEntry(
    entry: LogEntryData,
    items: [LogItemData],
    catalog: Catalog,
    settingsVersions: [DoseSettingsData],
    calendar: Calendar = .current
) -> (entry: LogEntryData, items: [LogItemData], complete: Bool) {
    var newItems: [LogItemData] = []
    var results: [CarbResult] = []
    for item in items {
        let carbs = itemCarbs(catalog, item.refType, item.refId, item.amount, item.unit)
        var updated = item
        updated.carbsG = carbs.carbsG
        switch item.refType {
        case .food: if let food = catalog.food(item.refId) { updated.displayName = food.name }
        case .meal: if let meal = catalog.meal(item.refId) { updated.displayName = meal.name }
        }
        newItems.append(updated)
        results.append(carbs)
    }
    let total = sumCarbs(results)
    var newEntry = entry
    newEntry.totalCarbsG = total.carbsG

    let settings = settingsVersions.first(where: { $0.id == entry.settingsVersionId })
        ?? activeSettings(settingsVersions, entry.eatenAt)
    newEntry.settingsVersionId = settings?.id
    newEntry.suggestedUnits = nil
    if let settings {
        let eatenAt = Date(timeIntervalSince1970: Double(entry.eatenAt) / 1000)
        var minutes = minutesOfDay(eatenAt, calendar: calendar)
        if let name = entry.windowName, let window = settings.windows.first(where: { $0.name == name }),
           let start = try? parseHHMM(window.start) {
            minutes = start
        }
        let estimate = estimateDose(DoseInput(settings: settings, minutes: minutes, carbs: total, bg: entry.bgMgdl))
        if case .ok(let s) = estimate { newEntry.suggestedUnits = s.units }
        newEntry.windowName = estimate.window?.name ?? entry.windowName
    }
    return (newEntry, newItems, total.complete)
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `ios/scripts/swift-test.sh CarbBookCore --filter LogRecalcTests`
Expected: `Executed 2 tests, with 0 failures (0 unexpected)` and no `warning:` lines for CarbBookCore sources.

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/CarbBook
git add ios/CarbBookCore/Sources/CarbBookCore/LogRecalc.swift ios/CarbBookCore/Tests/CarbBookCoreTests/LogRecalcTests.swift
git commit -m "feat(ios-core): recalculate a log entry from current catalog data"
```

---

### Task 16: Full verification

**Files:** none

- [ ] **Step 1: Run the whole package locally**

Run: `cd ~/Projects/CarbBook && ios/scripts/sync-testdata.sh --check && ios/scripts/swift-test.sh CarbBookCore 2>&1 | grep -E "warning:|error:|Executed [0-9]+ tests" | tail -3`
Expected: `testdata vectors in sync`, no `warning:`/`error:` lines, and `Executed 57 tests, with 0 failures (0 unexpected)` (printed for the bundle and for "All tests").

- [ ] **Step 2: Confirm the TS core still agrees with the same vectors**

Run: `cd ~/Projects/CarbBook/packages/core && pnpm exec vitest run test/vectors.test.ts`
Expected: all vector tests pass (same JSON the Swift tests just ran).

- [ ] **Step 3: Confirm no Apple-only imports crept in**

Run: `cd ~/Projects/CarbBook && grep -rhoE "^import [A-Za-z]+" ios/CarbBookCore/Sources | sort -u`
Expected: exactly `import Foundation`.

- [ ] **Step 4: Push and check CI**

Run: `cd ~/Projects/CarbBook && (git remote get-url origin >/dev/null 2>&1 || gh repo create sbruschke/CarbBook --private --source . --remote origin) && git push -u origin feat/ios && sleep 5 && gh run list --workflow ios-tests.yml --branch feat/ios --limit 1`
Expected: a run for `feat/ios`; `gh run watch` ends with `testdata-copies` and `core-linux` succeeded (`core-macos` is skipped on branch pushes; it runs on the pull request).

---

## Self-review against the spec

| Requirement | Task |
|---|---|
| §4.1 units (mass, volume via density/volume portion, count/serving portions, meal serving + mass) | 4 |
| §4.2 carbs, nested meals, incomplete propagation; review hardening (invalid stored values, empty meals, deleted rows, smallest-id density) | 4, 5 |
| §4.3 window pick, three correction modes, round-down below BG, no suggestion when incomplete, 4 h warning, breakdown text | 6, 7, 13 |
| Dose validation order and `invalid_input` / `invalid_settings` refusals | 7, 8 |
| §10 `units-vectors.json` + `dose-vectors.json` with per-case overrides, run by XCTest | 1, 8 |
| §5 LWW with JS-order tie-break, push then pull until drained, pending survives failures, last synced | 9, 10 |
| §3 UUIDv7 ids, soft deletes | 9, 10 |
| Food editor 0–100 carbs/fiber validation (server push rule) | 12 |
| §6 USDA foods copied into `food` (`source='usda'`) with portions; OFF draft confirm; offline barcode candidates; local FTS5 query | 11, 12 |
| §8 Calculator (window override, BG, Log it, Save as meal); Log recalc; Settings dose editor as new versions | 13, 14, 15 |
| §4.4 / server review: BG prefill only when ≤15 min old and ≤2 min in the future | 13 |
| `activeSettings` skips deleted versions; append-only dose settings | 6, 14 |
| Foundation-only core, `swift test` on Linux and macOS CI | 1, 16 |

Placeholder scan: no TBD/TODO; every code step has full file contents taken from the verified run. Type names used by the app plan (`SyncStore`, `SyncTransport`, `SyncEngine`, `SyncChange`, `PushResult`, `InMemoryCatalog`, `evaluateCalculator`, `buildLogRecords`, `buildMealRecords`, `copyUsdaFood`, `recordsFromOffDraft`, `validateFood`, `validateDoseSettings`, `newDoseSettingsVersion`, `recalculateLogEntry`, `isBgReadingUsable`, `toFtsQuery`, `barcodeCandidates`, `UUIDv7.make`) are defined here.
