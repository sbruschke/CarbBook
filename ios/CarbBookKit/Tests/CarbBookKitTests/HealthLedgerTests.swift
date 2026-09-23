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
