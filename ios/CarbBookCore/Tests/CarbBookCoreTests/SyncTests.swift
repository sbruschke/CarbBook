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
