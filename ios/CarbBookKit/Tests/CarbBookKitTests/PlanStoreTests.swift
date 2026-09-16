import CarbBookCore
@testable import CarbBookKit
import Foundation
import GRDB
import XCTest

final class PlanStoreTests: XCTestCase {
    func testMigrationCreatesBothPlanTables() throws {
        let store = try LocalStore(path: nil, now: { 1_000 })
        try store.dbQueue.read { db in
            XCTAssertTrue(try db.tableExists("plan_entry"))
            XCTAssertTrue(try db.tableExists("plan_item"))
        }
    }

    func testPlanEntryRoundTripsThroughTheStore() throws {
        let store = try LocalStore(path: nil, now: { 1_000 })
        let entry = PlanEntryData(id: "p1", date: "2026-09-16", windowName: "Lunch", status: .planned,
                                  note: nil, logEntryId: nil)
        let saved = try store.save("plan_entry", entry)
        XCTAssertEqual(saved.record["note"], .null)
        XCTAssertEqual(saved.record["log_entry_id"], .null)
        XCTAssertEqual(saved.record["status"], .string("planned"))
        let rows: [PlanEntryData] = try store.records("plan_entry")
        XCTAssertEqual(rows, [PlanEntryData(id: "p1", date: "2026-09-16", windowName: "Lunch", status: .planned,
                                            note: nil, logEntryId: nil, deleted: 0)])
    }

    func testPlanItemRoundTripsWithAnIntegerPosition() throws {
        let store = try LocalStore(path: nil, now: { 1_000 })
        try store.save("plan_item", PlanItemData(id: "i1", planEntryId: "p1", refType: .food, refId: "f1",
                                                 amount: 0.5, unit: "cup", position: 3))
        let rows: [PlanItemData] = try store.records("plan_item")
        XCTAssertEqual(rows.first?.position, 3)
        XCTAssertEqual(rows.first?.amount, 0.5)
        XCTAssertEqual(rows.first?.refType, .food)
    }

    func testAPlanItemWhoseParentIsMissingIsStillStored() throws {
        // No foreign keys between synced tables: a child may sync before its parent.
        let store = try LocalStore(path: nil, now: { 1_000 })
        try store.save("plan_item", PlanItemData(id: "i1", planEntryId: "nope", refType: .meal, refId: "m1",
                                                 amount: 1, unit: Units.serving, position: 0))
        XCTAssertEqual((try store.records("plan_item") as [PlanItemData]).count, 1)
    }

    func testExistingDatabasesMigrateWithoutLosingRows() throws {
        let directory = try temporaryDirectory()
        let path = directory.appendingPathComponent("carbbook.sqlite").path
        let queue = try DatabaseQueue(path: path)
        var oldMigrator = DatabaseMigrator()
        oldMigrator.registerMigration("v1") { db in try db.execute(sql: Schema.v1) }
        oldMigrator.registerMigration("v2-any-unit-foods") { db in try db.execute(sql: Schema.v2AnyUnitFoods) }
        try oldMigrator.migrate(queue)
        try queue.write { db in
            try db.execute(sql: """
            INSERT INTO food (id, name, source, carbs_per_100g, updated_at, updated_by, deleted)
            VALUES ('f1', 'Rice', 'custom', 28.2, 1, 'dev', 0)
            """)
        }
        // Closing the queue before reopening the same file through LocalStore.
        try queue.close()
        let store = try LocalStore(path: path, now: { 2_000 })
        XCTAssertEqual(try store.catalog().food("f1")?.name, "Rice")
        try store.dbQueue.read { db in XCTAssertTrue(try db.tableExists("plan_entry")) }
    }

    func testPlanRowsPushAndPullThroughTheServer() async throws {
        let server = FakeServer()
        let deviceA = try LocalStore(path: nil, now: { 1_000 })
        let deviceB = try LocalStore(path: nil, now: { 1_000 })
        try deviceA.save("plan_entry", PlanEntryData(id: "p1", date: "2026-09-16", windowName: "Lunch",
                                                     status: .planned, note: "leftovers", logEntryId: nil))
        try deviceA.save("plan_item", PlanItemData(id: "i1", planEntryId: "p1", refType: .food, refId: "f1",
                                                   amount: 2, unit: "p:x", position: 0))
        _ = try await SyncEngine(store: deviceA, transport: server).run { 1_000 }
        _ = try await SyncEngine(store: deviceB, transport: server).run { 1_000 }

        let entries: [PlanEntryData] = try deviceB.records("plan_entry")
        XCTAssertEqual(entries.count, 1)
        XCTAssertEqual(entries.first?.note, "leftovers")
        XCTAssertNil(entries.first?.logEntryId)
        let items: [PlanItemData] = try deviceB.records("plan_item")
        XCTAssertEqual(items.first?.unit, "p:x")
        XCTAssertEqual(items.first?.position, 0)
    }

    func testClearingANoteIsPushedAsAnExplicitNull() async throws {
        let server = FakeServer()
        let clock = TestClock(1_000)
        let store = try LocalStore(path: nil, now: clock.now)
        try store.save("plan_entry", PlanEntryData(id: "p1", date: "2026-09-16", windowName: "Lunch",
                                                   status: .planned, note: "leftovers", logEntryId: nil))
        _ = try await SyncEngine(store: store, transport: server).run(nowMs: clock.now)
        clock.ms = 2_000
        try store.save("plan_entry", PlanEntryData(id: "p1", date: "2026-09-16", windowName: "Lunch",
                                                   status: .skipped, note: nil, logEntryId: nil))
        let pending = try await store.pendingChanges(limit: 10)
        XCTAssertEqual(pending.count, 1)
        XCTAssertEqual(pending[0].record["note"], .null)
        XCTAssertEqual(pending[0].record["status"], .string("skipped"))
    }

    private func seedWeek(_ store: LocalStore) throws {
        try store.save("plan_entry", PlanEntryData(id: "p1", date: "2026-09-14", windowName: "Lunch", status: .planned))
        try store.save("plan_entry", PlanEntryData(id: "p2", date: "2026-09-16", windowName: "Lunch", status: .planned))
        try store.save("plan_entry", PlanEntryData(id: "p3", date: "2026-09-16", windowName: "Dinner", status: .skipped))
        try store.save("plan_entry", PlanEntryData(id: "p4", date: "2026-09-25", windowName: "Lunch", status: .planned))
        try store.save("plan_item", PlanItemData(id: "i2", planEntryId: "p2", refType: .food, refId: "f1",
                                                 amount: 1, unit: "g", position: 1))
        try store.save("plan_item", PlanItemData(id: "i1", planEntryId: "p2", refType: .food, refId: "f2",
                                                 amount: 2, unit: "g", position: 0))
    }

    func testPlanEntriesReadsAnInclusiveDateRange() throws {
        let store = try LocalStore(path: nil, now: { 1_000 })
        try seedWeek(store)
        let entries = try store.planEntries(from: "2026-09-13", to: "2026-09-19")
        XCTAssertEqual(entries.map(\.id), ["p1", "p3", "p2"])
    }

    func testPlanEntriesSkipsDeletedRows() throws {
        let store = try LocalStore(path: nil, now: { 1_000 })
        try seedWeek(store)
        try store.softDelete("plan_entry", id: "p2")
        XCTAssertEqual(try store.planEntries(from: "2026-09-13", to: "2026-09-19").map(\.id), ["p1", "p3"])
    }

    func testPlanItemsAreGroupedByEntryAndOrderedByPosition() throws {
        let store = try LocalStore(path: nil, now: { 1_000 })
        try seedWeek(store)
        let grouped = try store.planItems(entryIds: ["p1", "p2"])
        XCTAssertEqual(grouped["p2"]?.map(\.id), ["i1", "i2"])
        XCTAssertNil(grouped["p1"])
    }

    func testPlanEntryForASlot() throws {
        let store = try LocalStore(path: nil, now: { 1_000 })
        try seedWeek(store)
        XCTAssertEqual(try store.planEntry(date: "2026-09-16", windowName: "Lunch")?.id, "p2")
        XCTAssertNil(try store.planEntry(date: "2026-09-16", windowName: "Breakfast"))
    }

    func testPlanEntryForASlotIgnoresCaseAndWhitespace() throws {
        let store = try LocalStore(path: nil, now: { 1_000 })
        try seedWeek(store)
        XCTAssertEqual(try store.planEntry(date: "2026-09-16", windowName: "  LUNCH ")?.id, "p2")
    }

    func testPlanEntriesLinkedToALogEntry() throws {
        let store = try LocalStore(path: nil, now: { 1_000 })
        try store.save("plan_entry", PlanEntryData(id: "p9", date: "2026-09-16", windowName: "Lunch",
                                                   status: .logged, note: nil, logEntryId: "l1"))
        XCTAssertEqual(try store.planEntries(logEntryId: "l1").map(\.id), ["p9"])
        XCTAssertTrue(try store.planEntries(logEntryId: "l2").isEmpty)
    }
}
