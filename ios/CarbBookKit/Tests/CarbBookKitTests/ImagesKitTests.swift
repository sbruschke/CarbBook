import CarbBookCore
@testable import CarbBookKit
import Foundation
import GRDB
import XCTest

/// Images spec: the `image` table, `food.image_id`/`meal.image_id`, and their codec registration.
final class ImagesKitTests: XCTestCase {
    private let imageHash = String(repeating: "a", count: 64)

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
            "id": .string(imageHash), "mime": .string("image/jpeg"), "width": .number(800), "height": .number(600),
            "source": .string("openverse"), "source_url": .string("https://example.test/p"),
            "license": .string("CC0"), "attribution": .null,
        ]
        try store.save([SyncChange(table: "image", record: record)])

        let stored = try await store.dbQueue.read { db in
            try Row.fetchOne(db, sql: "SELECT width, height FROM image WHERE id = ?", arguments: [self.imageHash])
        }
        XCTAssertEqual(stored?["width"] as DatabaseValue?, Int64(800).databaseValue)
        XCTAssertEqual(stored?["height"] as DatabaseValue?, Int64(600).databaseValue)

        let pending = try await store.pendingChanges(limit: 10)
        XCTAssertEqual(pending.map(\.key), ["image/\(imageHash)"])
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
            "carbs_per_100g": .number(28.2), "image_id": .string(imageHash),
        ], into: store)

        var food = try XCTUnwrap(store.foods().first)
        XCTAssertEqual(food.imageId, imageHash, "a pulled image_id must decode onto the struct")
        food.name = "Jasmine rice"
        clock.ms = 3_000
        try store.save("food", food)

        let pending = try await store.pendingChanges(limit: 10)
        XCTAssertEqual(pending.map(\.key), ["food/f1"])
        XCTAssertEqual(pending[0].record["name"], .string("Jasmine rice"))
        XCTAssertEqual(pending[0].record["image_id"], .string(imageHash), "editing the name must not wipe the image")
    }

    func testEditingAPulledMealKeepsItsImage() async throws {
        let clock = TestClock(2_000)
        let store = try LocalStore(path: nil, now: clock.now)
        try await pulled("meal", [
            "id": .string("m1"), "name": .string("Chilli"), "yield_servings": .number(4),
            "image_id": .string(imageHash),
        ], into: store)

        var meal = try XCTUnwrap(store.meals().first)
        XCTAssertEqual(meal.imageId, imageHash, "a pulled image_id must decode onto the struct")
        meal.name = "Chilli con carne"
        clock.ms = 3_000
        try store.save("meal", meal)

        let pending = try await store.pendingChanges(limit: 10)
        XCTAssertEqual(pending.map(\.key), ["meal/m1"])
        XCTAssertEqual(pending[0].record["image_id"], .string(imageHash), "editing the name must not wipe the image")
    }
}

/// The row thumbnails read the image off the catalog record the row already resolves for its name.
final class ItemImageIdTests: XCTestCase {
    private let imageHash = String(repeating: "c", count: 64)

    func testFoodAndMealImagesAreFoundAndQuickRowsHaveNone() {
        let catalog = InMemoryCatalog(
            foods: [FoodData(id: "f1", name: "Rice", source: "custom", carbsPer100g: 28, imageId: imageHash)],
            meals: [MealData(id: "m1", name: "Chilli", yieldServings: 4)])
        XCTAssertEqual(itemImageId(.food, "f1", catalog: catalog), imageHash)
        XCTAssertNil(itemImageId(.meal, "m1", catalog: catalog), "a meal with no image has none")
        XCTAssertNil(itemImageId(.quick, "q1", catalog: catalog), "quick carbs rows have no record at all")
    }

    /// A reference that has not synced yet reads as no image, the same way its name reads "Unknown item".
    func testUnresolvedReferenceHasNoImage() {
        XCTAssertNil(itemImageId(.food, "missing", catalog: InMemoryCatalog()))
    }
}

/// Stack entries: what the overlapping photo cluster on a collapsed row is built from. The ordering
/// itself belongs to core `imageStackLayout` and is covered by the shared vectors; these tests only
/// check that each surface hands it the right image and the right carbs.
final class StackEntriesTests: XCTestCase {
    private let riceImage = String(repeating: "d", count: 64)
    private let sauceImage = String(repeating: "e", count: 64)

    private func catalog() -> InMemoryCatalog {
        InMemoryCatalog(
            foods: [
                FoodData(id: "rice", name: "Rice", source: "custom", carbsPer100g: 28, imageId: riceImage),
                FoodData(id: "sauce", name: "Sauce", source: "custom", carbsPer100g: 5, imageId: sauceImage),
                FoodData(id: "water", name: "Water", source: "custom", carbsPer100g: 0),
            ],
            meals: [MealData(id: "m1", name: "Rice bowl", yieldServings: 2)],
            mealItems: [
                MealItemData(id: "mi1", mealId: "m1", refType: .food, refId: "sauce", amount: 50, unit: "g", position: 0),
                MealItemData(id: "mi2", mealId: "m1", refType: .food, refId: "rice", amount: 200, unit: "g", position: 1),
            ])
    }

    /// Meal components and plan items compute their carbs live, from the catalog the screen holds.
    func testLiveRowsTakeTheirImageAndComputedCarbsFromTheCatalog() {
        let entries = itemStackEntries(catalog().mealItems("m1"), catalog: catalog())
        XCTAssertEqual(entries.map(\.imageId), [sauceImage, riceImage])
        XCTAssertEqual(entries.map(\.carbs), [2.5, 56])
        // Ordering is core's: the bigger contribution comes frontmost, whatever order the rows are in.
        XCTAssertEqual(imageStackLayout(entries).imageIds, [riceImage, sauceImage])
    }

    /// A row whose carbs cannot be worked out keeps its photo but sorts to the back, rather than
    /// being counted as zero carbs or hidden.
    func testARowWithUnknownCarbsHasNilCarbsAndKeepsItsImage() {
        let items = [PlanItemData(id: "i1", planEntryId: "p1", refType: .food, refId: "rice",
                                  amount: 1, unit: "not-a-unit", position: 0)]
        let entries = itemStackEntries(items, catalog: catalog())
        XCTAssertEqual(entries.map(\.imageId), [riceImage])
        XCTAssertNil(entries[0].carbs)
    }

    /// A log entry is a snapshot: `carbs_g` as logged is used verbatim, never recomputed against a
    /// food whose carbs may since have been edited.
    func testLoggedRowsUseTheStoredCarbsAndCountQuickRowsIntoTheOverflow() {
        let items = [
            LogItemData(id: "l1", logEntryId: "e1", refType: .food, refId: "rice", displayName: "Rice",
                        amount: 200, unit: "g", carbsG: 12),
            LogItemData(id: "l2", logEntryId: "e1", refType: .food, refId: "sauce", displayName: "Sauce",
                        amount: 50, unit: "g", carbsG: 40),
            LogItemData(id: "l3", logEntryId: "e1", refType: .quick, refId: "", displayName: "Juice",
                        amount: 15, unit: Units.quick, carbsG: 15),
        ]
        let entries = loggedStackEntries(items, catalog: catalog())
        XCTAssertEqual(entries.map(\.carbs), [12, 40, 15], "the logged snapshot, not 56 g of rice")
        XCTAssertNil(entries[2].imageId, "a quick-carbs row references no food, so it has no photo")

        let layout = imageStackLayout(entries)
        XCTAssertEqual(layout.imageIds, [sauceImage, riceImage])
        XCTAssertEqual(layout.overflow, 1, "the quick row is still one of the three items")
    }

    /// A food with no photo of its own contributes nothing to draw, so an entry of plain rows
    /// renders no stack at all rather than an empty ring.
    func testRowsWithNoPhotosProduceNothingToDraw() {
        let items = [LogItemData(id: "l1", logEntryId: "e1", refType: .food, refId: "water",
                                 displayName: "Water", amount: 1, unit: "g", carbsG: 0)]
        let layout = imageStackLayout(loggedStackEntries(items, catalog: catalog()))
        XCTAssertTrue(layout.imageIds.isEmpty)
        XCTAssertEqual(layout.overflow, 1)
    }
}

/// The Log list resolves every row's photos from one grouped query, never one query per row.
final class LogItemsByEntryTests: XCTestCase {
    private func seed(_ store: LocalStore) throws {
        try store.save("log_entry", LogEntryData(id: "e1", eatenAt: 1_000, windowName: "Lunch", bgMgdl: nil,
                                                 bgSource: "none", bgTrend: nil, totalCarbsG: 30,
                                                 suggestedUnits: nil, takenUnits: nil, settingsVersionId: nil,
                                                 notes: nil))
        try store.save("log_entry", LogEntryData(id: "e2", eatenAt: 2_000, windowName: "Dinner", bgMgdl: nil,
                                                 bgSource: "none", bgTrend: nil, totalCarbsG: 10,
                                                 suggestedUnits: nil, takenUnits: nil, settingsVersionId: nil,
                                                 notes: nil))
        try store.save("log_item", LogItemData(id: "l1", logEntryId: "e1", refType: .food, refId: "rice",
                                               displayName: "Rice", amount: 100, unit: "g", carbsG: 28))
        try store.save("log_item", LogItemData(id: "l2", logEntryId: "e1", refType: .quick, refId: "",
                                               displayName: "Juice", amount: 2, unit: Units.quick, carbsG: 2))
        try store.save("log_item", LogItemData(id: "l3", logEntryId: "e2", refType: .food, refId: "rice",
                                               displayName: "Rice", amount: 40, unit: "g", carbsG: 10))
    }

    func testItemsAreGroupedByEntry() throws {
        let store = try LocalStore(path: nil, now: { 1_000 })
        try seed(store)
        let grouped = try store.logItems(entryIds: ["e1", "e2"])
        XCTAssertEqual(grouped["e1"]?.map(\.id), ["l1", "l2"])
        XCTAssertEqual(grouped["e2"]?.map(\.id), ["l3"])
    }

    /// An entry with no items simply has no key, and asking for nothing reads nothing.
    func testUnknownAndEmptyRequestsReadNothing() throws {
        let store = try LocalStore(path: nil, now: { 1_000 })
        try seed(store)
        XCTAssertNil(try store.logItems(entryIds: ["e3"])["e3"])
        XCTAssertTrue(try store.logItems(entryIds: []).isEmpty)
    }

    func testDeletedItemsAreNotReturned() throws {
        let store = try LocalStore(path: nil, now: { 1_000 })
        try seed(store)
        try store.softDelete("log_item", id: "l1")
        XCTAssertEqual(try store.logItems(entryIds: ["e1"])["e1"]?.map(\.id), ["l2"])
    }
}
