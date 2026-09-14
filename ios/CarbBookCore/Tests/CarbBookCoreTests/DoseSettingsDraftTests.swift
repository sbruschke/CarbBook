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
