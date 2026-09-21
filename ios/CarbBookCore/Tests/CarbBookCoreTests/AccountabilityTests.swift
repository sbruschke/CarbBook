import XCTest
@testable import CarbBookCore

final class AccountabilityTests: XCTestCase {
    func testNonFiniteCarbsAreNeverPrinted() {
        let text = accountabilityText(AccountabilityInput(when: "now", bgMgdl: 100, carbsG: .nan, units: 4))
        XCTAssertEqual(text, "As of now my blood sugar is 100. I do not have a carb total for this meal.")
    }

    func testNonFiniteBgReadsAsNoReading() {
        let text = accountabilityText(AccountabilityInput(when: "now", bgMgdl: .nan, carbsG: 10, units: nil))
        XCTAssertTrue(text.contains("I do not have a blood sugar reading."))
    }

    func testNonFiniteDoseReadsAsNoneRecorded() {
        let text = accountabilityText(AccountabilityInput(when: "now", bgMgdl: 100, carbsG: 10, units: .infinity))
        XCTAssertTrue(text.contains("have not recorded a dose yet."))
    }
}
