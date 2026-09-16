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
