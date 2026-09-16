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

    /// Item 7: effective_from is validated first, with the server's exact message, before
    /// windows/correction/rounding (server field order in tables.ts).
    func testEffectiveFromValidatedFirstWithServerMessage() {
        var s = seedSettings
        s.effectiveFrom = -1
        s.windows = [] // would also fail windows-empty, but effective_from must be reported first
        XCTAssertEqual(validateDoseSettings(s), "effective_from must be >= 0")
    }

    func testNewVersionSortsWindowsAndNeverReusesId() {
        var draft = seedSettings
        draft.windows.reverse()
        let version = newDoseSettingsVersion(from: draft, effectiveFrom: 1_789_000_000_000, newId: { "v2" })
        XCTAssertEqual(version.id, "v2")
        XCTAssertEqual(version.effectiveFrom, 1_789_000_000_000)
        XCTAssertEqual(version.windows.map(\.name), seedSettings.windows.map(\.name))
    }

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
}
