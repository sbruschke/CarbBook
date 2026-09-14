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

    func testDoseLimitsMatchTypeScript() {
        XCTAssertEqual(DoseLimits.maxCarbsG, 2000)
        XCTAssertEqual(DoseLimits.maxBg, 1000)
        XCTAssertEqual(DoseLimits.maxRatioGPerUnit, 1000)
        XCTAssertEqual(DoseLimits.maxCorrectionThreshold, 1000)
        XCTAssertEqual(DoseLimits.maxCorrectionStep, 1000)
        XCTAssertEqual(DoseLimits.maxUnitsPerStep, 50)
        XCTAssertEqual(DoseLimits.maxRoundingIncrement, 10)
        XCTAssertEqual(DoseLimits.maxRoundDownBelowBg, 1000)
        XCTAssertEqual(DoseLimits.maxRawUnits, 50)
    }

    func testInputLimitsRefuse() {
        XCTAssertNotEqual(estimate(carbs: 2000), .refused(.invalidInput, window: nil))
        XCTAssertEqual(estimate(carbs: 2001), .refused(.invalidInput, window: nil))
        guard case .ok = estimate(bg: 1000) else { return XCTFail("BG 1000 should be estimated") }
        XCTAssertEqual(estimate(bg: 1001), .refused(.invalidInput, window: nil))
    }

    func testSettingsLimitsRefuse() {
        var cases: [DoseSettingsData] = []
        var s = seedSettings; s.windows[0].ratioGPerUnit = 1001; cases.append(s)
        s = seedSettings; s.correction.threshold = 1001; cases.append(s)
        s = seedSettings; s.correction.step = 1001; cases.append(s)
        s = seedSettings; s.correction.unitsPerStep = 51; cases.append(s)
        s = seedSettings; s.rounding.increment = 11; cases.append(s)
        s = seedSettings; s.rounding.roundDownBelowBg = 1001; cases.append(s)
        for (index, settings) in cases.enumerated() {
            XCTAssertEqual(estimate(settings), .refused(.invalidSettings, window: nil), "case \(index)")
        }
        var atLimits = seedSettings
        atLimits.windows = [DoseWindow(name: "All", start: "00:00", ratioGPerUnit: 1000)]
        atLimits.correction = CorrectionRule(threshold: 1000, step: 1000, unitsPerStep: 50, mode: "started")
        atLimits.rounding = RoundingRule(increment: 10, roundDownBelowBg: 1000)
        guard case .ok = estimate(atLimits) else { return XCTFail("settings at the limits should be estimated") }
    }

    func testRawOverLimitRefusesWithWindow() {
        let dinner = seedSettings.windows[4]
        guard case .ok(let s) = estimate(minutes: 1080, carbs: 400) else { return XCTFail("raw 50 should be estimated") }
        XCTAssertEqual(s.rawUnits, 50)
        XCTAssertEqual(s.units, 50)
        XCTAssertEqual(estimate(minutes: 1080, carbs: 401), .refused(.exceedsLimit, window: dinner))
        XCTAssertEqual(estimate(minutes: 1080, carbs: 360, bg: 500), .refused(.exceedsLimit, window: dinner)) // 45 + 6
    }

    func testLimitOrder() {
        var badSettings = seedSettings
        badSettings.rounding.increment = 11
        XCTAssertEqual(estimate(badSettings, carbs: 2001), .refused(.invalidInput, window: nil))
        badSettings.windows = []
        XCTAssertEqual(estimate(badSettings, carbs: 1000), .refused(.invalidSettings, window: nil))
        XCTAssertEqual(estimate(minutes: 1080, carbs: 1000, complete: false), .refused(.incompleteCarbs, window: seedSettings.windows[4]))
        var zero = seedSettings
        zero.windows = [DoseWindow(name: "Z", start: "00:00", ratioGPerUnit: 0)]
        XCTAssertEqual(estimate(zero, carbs: 1000), .refused(.invalidRatio, window: zero.windows[0]))
    }

    func testRefusalMessagesAreDistinct() {
        let all: [DoseRefusal] = [.noWindow, .invalidRatio, .incompleteCarbs, .invalidInput, .invalidSettings, .exceedsLimit]
        XCTAssertEqual(Set(all.map(\.message)).count, all.count)
        XCTAssertEqual(DoseRefusal.incompleteCarbs.rawValue, "incomplete_carbs")
        XCTAssertEqual(DoseRefusal.exceedsLimit.rawValue, "exceeds_limit")
    }
}
