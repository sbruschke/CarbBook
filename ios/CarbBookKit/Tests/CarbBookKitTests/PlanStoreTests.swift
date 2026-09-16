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
}
