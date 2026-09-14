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

    func testCorrectionUnitsNaNMatchesTypeScript() {
        // TS: `NaN <= threshold` and `step <= 0` are false, so NaN flows through as NaN.
        let rule = seedSettings.correction
        XCTAssertTrue(correctionUnits(rule, .nan).isNaN)
        var nanThreshold = rule; nanThreshold.threshold = .nan
        XCTAssertTrue(correctionUnits(nanThreshold, 250).isNaN)
        var nanStep = rule; nanStep.step = .nan
        XCTAssertTrue(correctionUnits(nanStep, 250).isNaN)
        XCTAssertEqual(correctionUnits(rule, nil), 0)
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
