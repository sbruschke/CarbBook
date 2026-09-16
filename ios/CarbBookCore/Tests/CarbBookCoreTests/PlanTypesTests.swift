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
