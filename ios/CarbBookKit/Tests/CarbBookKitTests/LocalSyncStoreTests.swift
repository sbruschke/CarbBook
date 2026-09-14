import CarbBookCore
@testable import CarbBookKit
import XCTest

final class LocalSyncStoreTests: XCTestCase {
    private func settings(_ id: String, ratio: Double = 10, below: Double? = 130) -> DoseSettingsData {
        DoseSettingsData(
            id: id, effectiveFrom: 1, windows: [DoseWindow(name: "All", start: "00:00", ratioGPerUnit: ratio)],
            correction: CorrectionRule(threshold: 200, step: 50, unitsPerStep: 1, mode: "started"),
            rounding: RoundingRule(increment: 1, roundDownBelowBg: below))
    }

    private func rice(_ name: String) -> FoodData {
        FoodData(id: "f1", name: name, source: "custom", carbsPer100g: 28.2)
    }

    private func pushAll(_ store: LocalStore, _ status: String, reason: String? = nil, seq: Int64? = nil) async throws -> [SyncChange] {
        let pushed = try await store.pendingChanges(limit: 500)
        try await store.recordPushResults(pushed, pushed.map {
            PushResult(table: $0.table, id: $0.id, status: status, serverSeq: seq, reason: reason, message: reason.map { "server says \($0)" })
        })
        return pushed
    }

    func testPendingChangesSurviveRestart() async throws {
        let dir = try temporaryDirectory()
        let path = dir.appendingPathComponent("carbbook.sqlite").path
        let first = try LocalStore(path: path, now: { 5_000 })
        try first.save("meal", MealData(id: "m1", name: "Tacos", yieldServings: 4))
        let deviceId = first.deviceId

        let reopened = try LocalStore(path: path, now: { 6_000 })
        XCTAssertEqual(reopened.deviceId, deviceId)
        XCTAssertEqual(try reopened.pendingCount(), 1)
        let pending = try await reopened.pendingChanges(limit: 500)
        XCTAssertEqual(pending.map(\.key), ["meal/m1"])
        XCTAssertNil(pending[0].record["server_seq"])
        XCTAssertEqual(pending[0].record["total_weight_g"], .null)
    }

    func testAcceptedPushClearsPendingAndRecordsServerSeq() async throws {
        let store = try LocalStore(path: nil, now: { 1_000 })
        try store.save("food", rice("Rice"))
        let pushed = try await store.pendingChanges(limit: 500)
        try await store.recordPushResults(pushed, [PushResult(table: "food", id: "f1", status: "accepted", serverSeq: 42)])
        XCTAssertEqual(try store.pendingCount(), 0)
        let seq = try await store.dbQueue.read { db in try Int64.fetchOne(db, sql: "SELECT server_seq FROM food WHERE id = 'f1'") }
        XCTAssertEqual(seq, 42)
    }

    func testRowEditedDuringPushStaysPending() async throws {
        let clock = TestClock(1_000)
        let store = try LocalStore(path: nil, now: clock.now)
        try store.save("food", rice("Rice"))
        let pushed = try await store.pendingChanges(limit: 500)
        clock.ms = 1_500
        try store.save("food", rice("Jasmine rice"))
        try await store.recordPushResults(pushed, [PushResult(table: "food", id: "f1", status: "accepted", serverSeq: 1)])
        XCTAssertEqual(try store.pendingCount(), 1)
    }

    /// A never-synced row that the server rejects is deleted locally (not left diverged), the
    /// rejection is stored for Settings → Sync, and a rejected dose settings id is reported.
    func testRejectionIsStoredAndLeavesTheQueue() async throws {
        let store = try LocalStore(path: nil, now: { 1_000 })
        try store.save("dose_settings", settings("s2"))
        let pushed = try await store.pendingChanges(limit: 500)
        try await store.recordPushResults(pushed, [PushResult(table: "dose_settings", id: "s2", status: "rejected",
                                                              reason: "forbidden", message: "Only the owner can change dose settings")])
        XCTAssertEqual(try store.pendingCount(), 0)
        XCTAssertEqual(try store.rejections().map(\.reason), ["forbidden"])
        XCTAssertEqual(try store.rejections().map(\.rejectedAt), [1_000])
        XCTAssertEqual(try store.doseSettingsVersions().map(\.id), [])
        XCTAssertEqual(try store.rejectedDoseSettingsIds(), ["s2"])
        try store.dismissRejection(table: "dose_settings", recordId: "s2")
        XCTAssertEqual(try store.rejections(), [])
        XCTAssertEqual(try store.rejectedDoseSettingsIds(), [])
    }

    /// Port of core `testRejectedEditOfSyncedRowRestoresServerCopy`.
    func testRejectedEditOfSyncedRowRestoresServerCopy() async throws {
        let clock = TestClock(1_000)
        let store = try LocalStore(path: nil, now: clock.now)
        try store.save("food", rice("Rice"))
        _ = try await pushAll(store, "accepted", seq: 1)
        XCTAssertEqual(try store.foods().map(\.name), ["Rice"])

        clock.ms = 2_000
        try store.save("food", rice("Brown rice"))
        _ = try await pushAll(store, "rejected", reason: "invalid")

        XCTAssertEqual(try store.foods().map(\.name), ["Rice"]) // restored to the last server-acknowledged copy
        let version = try await store.dbQueue.read { db in try store.change(db, table: "food", id: "f1")?.version }
        XCTAssertEqual(version, RecordVersion(updatedAt: 1_000, updatedBy: store.deviceId))
        let seq = try await store.dbQueue.read { db in try Int64.fetchOne(db, sql: "SELECT server_seq FROM food WHERE id = 'f1'") }
        XCTAssertEqual(seq, 1)
        XCTAssertEqual(try store.pendingCount(), 0)
        XCTAssertEqual(try store.rejections().map(\.reason), ["invalid"])
        let indexedNames = try await store.dbQueue.read { db in try String.fetchAll(db, sql: "SELECT name FROM catalog_fts") }
        XCTAssertEqual(indexedNames, ["Rice"])
    }

    /// Port of core `testRejectedNeverSyncedRowIsDeleted`; the search index follows the delete.
    func testRejectedNeverSyncedRowIsDeleted() async throws {
        let store = try LocalStore(path: nil, now: { 1_000 })
        try store.save("food", rice("Rice"))
        try store.save("meal", MealData(id: "m1", name: "Rice bowl", yieldServings: 1))
        _ = try await pushAll(store, "rejected", reason: "invalid")

        let exists = try await store.dbQueue.read { db in try Int.fetchOne(db, sql: "SELECT (SELECT count(*) FROM food) + (SELECT count(*) FROM meal)") }
        XCTAssertEqual(exists, 0)
        XCTAssertEqual(try store.pendingCount(), 0)
        let indexed = try await store.dbQueue.read { db in try Int.fetchOne(db, sql: "SELECT count(*) FROM catalog_fts") }
        XCTAssertEqual(indexed, 0)
        XCTAssertEqual(try store.rejections().count, 2)
    }

    /// Port of core `testRejectionWhileNewerLocalEditExistsKeepsNewerEditQueued`.
    func testRejectionWhileNewerLocalEditExistsKeepsNewerEditQueued() async throws {
        let clock = TestClock(1_000)
        let store = try LocalStore(path: nil, now: clock.now)
        try store.save("food", rice("Rice"))
        _ = try await pushAll(store, "accepted", seq: 1)

        clock.ms = 2_000
        try store.save("food", rice("Brown rice"))
        let pushed = try await store.pendingChanges(limit: 500) // captures the 2_000 edit as "in flight"
        clock.ms = 3_000
        try store.save("food", rice("Jasmine rice"))
        try await store.recordPushResults(pushed, [PushResult(table: "food", id: "f1", status: "rejected", reason: "invalid", message: "bad")])

        XCTAssertEqual(try store.foods().map(\.name), ["Jasmine rice"]) // newer local edit is untouched
        let pending = try await store.pendingChanges(limit: 500)
        XCTAssertEqual(pending.map(\.key), ["food/f1"]) // still queued to retry
        XCTAssertEqual(try store.rejections(), [])
    }

    /// Port of core `testRejectionsAreKeptAndClearedFromPending`: results match by index, so a
    /// result with `id: null` still resolves to the record that was sent at that position.
    func testRejectionWithNullIdIsMatchedByIndex() async throws {
        let clock = TestClock(1_000)
        let store = try LocalStore(path: nil, now: clock.now)
        try store.save("food", rice("Rice"))
        clock.ms = 1_001
        try store.save("meal", MealData(id: "m1", name: "Tacos", yieldServings: 4))
        let pushed = try await store.pendingChanges(limit: 500)
        XCTAssertEqual(pushed.map(\.key), ["food/f1", "meal/m1"])
        try await store.recordPushResults(pushed, [
            PushResult(table: "food", id: nil, status: "rejected", reason: "invalid", message: "id must be a string"),
            PushResult(table: "meal", id: "m1", status: "accepted", serverSeq: 5),
        ])
        XCTAssertEqual(try store.pendingCount(), 0)
        XCTAssertEqual(try store.rejections().map { "\($0.table)/\($0.recordId)" }, ["food/f1"])
        XCTAssertEqual(try store.foods(), [])
        XCTAssertEqual(try store.meals().map(\.name), ["Tacos"])
    }

    /// `ignored` clears the pending mark but leaves the snapshot alone, so a later rejection
    /// restores the last copy the server actually acknowledged.
    func testIgnoredKeepsTheEarlierSnapshot() async throws {
        let clock = TestClock(1_000)
        let store = try LocalStore(path: nil, now: clock.now)
        try store.save("food", rice("Rice"))
        _ = try await pushAll(store, "accepted", seq: 1)
        clock.ms = 2_000
        try store.save("food", rice("Brown rice"))
        _ = try await pushAll(store, "ignored")
        XCTAssertEqual(try store.pendingCount(), 0)
        XCTAssertEqual(try store.rejections(), [])
        clock.ms = 3_000
        try store.save("food", rice("Wild rice"))
        _ = try await pushAll(store, "rejected", reason: "invalid")
        XCTAssertEqual(try store.foods().map(\.name), ["Rice"])
    }

    /// A pulled row is a server-acknowledged snapshot: rejecting a later local edit restores it.
    func testRejectedEditOfPulledRowRestoresPulledCopy() async throws {
        let store = try LocalStore(path: nil, now: { 9_000 })
        try await store.applyPull([SyncChange(table: "food", record: [
            "id": .string("f1"), "name": .string("Server rice"), "brand": .null, "source": .string("custom"), "source_ref": .null,
            "derived_from": .null, "carbs_per_100g": .number(28.2), "fiber_per_100g": .null, "density_g_per_ml": .null, "notes": .null,
            "updated_at": .number(4_000), "updated_by": .string("web"), "deleted": .number(0), "server_seq": .number(3),
        ])], nextSince: 3)
        try store.save("food", FoodData(id: "f1", name: "Rice", source: "custom", carbsPer100g: 250))
        _ = try await pushAll(store, "rejected", reason: "invalid")
        XCTAssertEqual(try store.foods().map(\.name), ["Server rice"])
        XCTAssertEqual(try store.foods().map(\.carbsPer100g), [28.2])
    }

    /// Server rule: dose settings are append-only. A rejected edit of a synced version restores
    /// that version and records its id as rejected.
    func testAppendOnlyRejectionOfDoseSettingsEditRestoresTheVersion() async throws {
        let clock = TestClock(1_000)
        let store = try LocalStore(path: nil, now: clock.now)
        try store.save("dose_settings", settings("s1", ratio: 10, below: nil))
        _ = try await pushAll(store, "accepted", seq: 1)
        clock.ms = 2_000
        try store.save("dose_settings", settings("s1", ratio: 12, below: 100))
        _ = try await pushAll(store, "rejected", reason: "append_only")
        XCTAssertEqual(try store.doseSettingsVersions().map(\.windows.first?.ratioGPerUnit), [10])
        XCTAssertEqual(try store.doseSettingsVersions().map(\.rounding.roundDownBelowBg), [nil])
        XCTAssertEqual(try store.rejectedDoseSettingsIds(), ["s1"])
        XCTAssertEqual(try store.rejections().map(\.reason), ["append_only"])
    }

    func testPullKeepsANewerPendingEditAndOverwritesOtherwise() async throws {
        let store = try LocalStore(path: nil, now: { 5_000 })
        try store.save("meal", MealData(id: "m1", name: "Local tacos", yieldServings: 4))
        func incoming(_ name: String, at: Int64, seq: Int64) -> SyncChange {
            SyncChange(table: "meal", record: [
                "id": .string("m1"), "name": .string(name), "yield_servings": .number(2), "total_weight_g": .null, "notes": .null,
                "updated_at": .number(Double(at)), "updated_by": .string("web"), "deleted": .number(0), "server_seq": .number(Double(seq)),
            ])
        }
        try await store.applyPull([incoming("Old server tacos", at: 4_000, seq: 7)], nextSince: 7)
        XCTAssertEqual(try store.meals().map(\.name), ["Local tacos"])
        XCTAssertEqual(try store.pendingCount(), 1)
        let cursorAfterFirst = try await store.pullCursor()
        XCTAssertEqual(cursorAfterFirst, 7)

        try await store.applyPull([incoming("New server tacos", at: 6_000, seq: 9)], nextSince: 9)
        XCTAssertEqual(try store.meals().map(\.name), ["New server tacos"])
        XCTAssertEqual(try store.pendingCount(), 0)
    }

    /// Core `shouldApplyPulled`: an out-of-order older page never regresses a newer local row,
    /// even when nothing is pending for it.
    func testStalePullDoesNotRegressANonPendingRow() async throws {
        let store = try LocalStore(path: nil, now: { 5_000 })
        try store.save("meal", MealData(id: "m1", name: "Local tacos", yieldServings: 4))
        _ = try await pushAll(store, "accepted", seq: 8)
        XCTAssertEqual(try store.pendingCount(), 0)
        try await store.applyPull([SyncChange(table: "meal", record: [
            "id": .string("m1"), "name": .string("Old tacos"), "yield_servings": .number(2), "total_weight_g": .null, "notes": .null,
            "updated_at": .number(4_000), "updated_by": .string("web"), "deleted": .number(0), "server_seq": .number(3),
        ])], nextSince: 3)
        XCTAssertEqual(try store.meals().map(\.name), ["Local tacos"])
        let cursor = try await store.pullCursor()
        XCTAssertEqual(cursor, 3)
    }

    func testTwoDevicesSyncThroughTheServerIncludingChildrenBeforeParents() async throws {
        let server = FakeServer()
        let phone = try LocalStore(path: nil, now: { 1_000 })
        let ipad = try LocalStore(path: nil, now: { 2_000 })
        // A meal item whose meal has not been created yet: no foreign keys, so it syncs fine.
        try phone.save("meal_item", MealItemData(id: "i1", mealId: "m1", refType: .food, refId: "f1", amount: 100, unit: "g", position: 0))
        _ = try await SyncEngine(store: phone, transport: server).run { 1_000 }
        try phone.save("meal", MealData(id: "m1", name: "Rice bowl", yieldServings: 1))
        try phone.save("food", FoodData(id: "f1", name: "Rice", source: "custom", carbsPer100g: 28.2))
        let report = try await SyncEngine(store: phone, transport: server).run { 1_100 }
        XCTAssertEqual(report.accepted, 2)

        let pulled = try await SyncEngine(store: ipad, transport: server).run { 2_000 }
        XCTAssertEqual(pulled.pulled, 3)
        let carbs = itemCarbs(try ipad.catalog(), .meal, "m1", 1, "serving")
        XCTAssertEqual(carbs, CarbResult(carbsG: 28.2, complete: true))
        XCTAssertEqual(try ipad.pendingCount(), 0)
        XCTAssertEqual(try ipad.lastSyncedMs(), 2_000)
    }
}
