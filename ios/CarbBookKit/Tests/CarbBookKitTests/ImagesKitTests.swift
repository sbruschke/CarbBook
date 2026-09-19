import CarbBookCore
@testable import CarbBookKit
import Foundation
import GRDB
import XCTest

/// Images spec: the `image` table, `food.image_id`/`meal.image_id`, and their codec registration.
final class ImagesKitTests: XCTestCase {
    private let hash = String(repeating: "a", count: 64)

    func testCodecKnowsTheImageTableColumns() throws {
        XCTAssertEqual(try TableCodec.columns("image"), [
            "id", "mime", "width", "height", "source", "source_url", "license", "attribution",
            "updated_at", "updated_by", "deleted", "server_seq",
        ])
        XCTAssertEqual(try TableCodec.columns("food").last, "server_seq")
        XCTAssertTrue(try TableCodec.columns("food").contains("image_id"))
        XCTAssertTrue(try TableCodec.columns("meal").contains("image_id"))
    }

    func testMigratedDatabaseHasTheImageTableAndColumns() async throws {
        let store = try LocalStore(path: nil, now: { 1_000 })
        try await store.dbQueue.read { db in
            XCTAssertTrue(try db.tableExists("image"))
            XCTAssertTrue(try db.columns(in: "food").map(\.name).contains("image_id"))
            XCTAssertTrue(try db.columns(in: "meal").map(\.name).contains("image_id"))
        }
    }

    /// `width`/`height` must survive as SQLite integers, not "800.0" strings, so the record the
    /// server gets back is the record it sent.
    func testImageRowRoundTripsWithIntegerDimensions() async throws {
        let store = try LocalStore(path: nil, now: { 1_000 })
        let record: [String: JSONValue] = [
            "id": .string(hash), "mime": .string("image/jpeg"), "width": .number(800), "height": .number(600),
            "source": .string("openverse"), "source_url": .string("https://example.test/p"),
            "license": .string("CC0"), "attribution": .null,
        ]
        try store.save([SyncChange(table: "image", record: record)])

        let stored = try await store.dbQueue.read { db in
            try Row.fetchOne(db, sql: "SELECT width, height FROM image WHERE id = ?", arguments: [self.hash])
        }
        XCTAssertEqual(stored?["width"] as DatabaseValue?, Int64(800).databaseValue)
        XCTAssertEqual(stored?["height"] as DatabaseValue?, Int64(600).databaseValue)

        let pending = try await store.pendingChanges(limit: 10)
        XCTAssertEqual(pending.map(\.key), ["image/\(hash)"])
        XCTAssertEqual(pending[0].record["width"], .number(800))
        XCTAssertEqual(pending[0].record["height"], .number(600))
        XCTAssertEqual(pending[0].record["source"], .string("openverse"))
        XCTAssertEqual(pending[0].record["attribution"], .null)
    }

    /// A food or meal that was already pending when the column arrived was edited without knowing
    /// about it, so its push must omit `image_id` and leave the server's value alone (the v4 pattern).
    /// A v4 store with a food already queued for push, as an app upgraded into the images schema has.
    private func v4Store(at path: String) throws {
        let queue = try DatabaseQueue(path: path)
        var old = DatabaseMigrator()
        old.registerMigration("v1") { db in try db.execute(sql: Schema.v1) }
        old.registerMigration("v2-any-unit-foods") { db in try db.execute(sql: Schema.v2AnyUnitFoods) }
        old.registerMigration("v3-meal-plan") { db in try db.execute(sql: Schema.v3MealPlan) }
        old.registerMigration("v4-quick-carbs") { db in try db.execute(sql: Schema.v4QuickCarbs) }
        try old.migrate(queue)
        try queue.write { db in
            try db.execute(sql: """
            INSERT INTO sync_state (key, value) VALUES ('device_id', 'ios-old'), ('pull_cursor', '42');
            INSERT INTO food (id, name, source, carbs_per_100g, updated_at, updated_by, deleted, server_seq)
              VALUES ('f1', 'Rice', 'custom', 28.2, 1000, 'ios-old', 0, 7);
            INSERT INTO sync_pending (key, table_name, record_id, queued_at) VALUES ('food/f1', 'food', 'f1', 1000);
            """)
        }
        try queue.close()
    }

    /// A food or meal that was already pending when the column arrived was edited without knowing
    /// about it, so its push must omit `image_id` and leave the server's value alone (the v4 pattern).
    func testFoodPendingBeforeTheMigrationPushesWithoutImageId() async throws {
        let path = try temporaryDirectory().appendingPathComponent("carbbook.sqlite").path
        try v4Store(at: path)

        let clock = TestClock(5_000)
        let store = try LocalStore(path: path, now: clock.now)
        var pending = try await store.pendingChanges(limit: 10)
        XCTAssertEqual(pending.map(\.key), ["food/f1"])
        XCTAssertNil(pending[0].record["image_id"], "an edit made before the column existed must not clear the server's image")
        // The image table is new, so its rows arrive on the next ordinary pull: no cursor reset.
        let cursor = try await store.pullCursor()
        XCTAssertEqual(cursor, 42)

        clock.ms = 6_000
        try store.save("food", FoodData(id: "f1", name: "Jasmine rice", source: "custom", carbsPer100g: 28.2))
        pending = try await store.pendingChanges(limit: 10)
        XCTAssertEqual(pending[0].record["image_id"], .null, "a new edit carries every column")
    }
}

/// The data-loss guard for images: `LocalStore.writeLocal` fills every column the incoming record
/// omits with null, so a core struct with no `imageId` turns an ordinary edit into "clear the image".
/// These two pull a row that already has an image (as one chosen on the web arrives), edit an
/// unrelated field, and check the push still carries the same `image_id`.
extension ImagesKitTests {
    private func pulled(_ table: String, _ record: [String: JSONValue], into store: LocalStore) async throws {
        var row = record
        row["updated_at"] = .number(1_000)
        row["updated_by"] = .string("web-1")
        row["deleted"] = .number(0)
        row["server_seq"] = .number(1)
        try await store.applyPull([SyncChange(table: table, record: row)], nextSince: 1)
    }

    func testEditingAPulledFoodKeepsItsImage() async throws {
        let clock = TestClock(2_000)
        let store = try LocalStore(path: nil, now: clock.now)
        try await pulled("food", [
            "id": .string("f1"), "name": .string("Rice"), "source": .string("custom"),
            "carbs_per_100g": .number(28.2), "image_id": .string(hash),
        ], into: store)

        var food = try XCTUnwrap(store.foods().first)
        XCTAssertEqual(food.imageId, hash, "a pulled image_id must decode onto the struct")
        food.name = "Jasmine rice"
        clock.ms = 3_000
        try store.save("food", food)

        let pending = try await store.pendingChanges(limit: 10)
        XCTAssertEqual(pending.map(\.key), ["food/f1"])
        XCTAssertEqual(pending[0].record["name"], .string("Jasmine rice"))
        XCTAssertEqual(pending[0].record["image_id"], .string(hash), "editing the name must not wipe the image")
    }

    func testEditingAPulledMealKeepsItsImage() async throws {
        let clock = TestClock(2_000)
        let store = try LocalStore(path: nil, now: clock.now)
        try await pulled("meal", [
            "id": .string("m1"), "name": .string("Chilli"), "yield_servings": .number(4),
            "image_id": .string(hash),
        ], into: store)

        var meal = try XCTUnwrap(store.meals().first)
        XCTAssertEqual(meal.imageId, hash, "a pulled image_id must decode onto the struct")
        meal.name = "Chilli con carne"
        clock.ms = 3_000
        try store.save("meal", meal)

        let pending = try await store.pendingChanges(limit: 10)
        XCTAssertEqual(pending.map(\.key), ["meal/m1"])
        XCTAssertEqual(pending[0].record["image_id"], .string(hash), "editing the name must not wipe the image")
    }
}
