import CarbBookCore
@testable import CarbBookKit
import Foundation
import GRDB
import XCTest

/// Any-unit foods in the local store: migration of an existing v1 store, pulls of the new shapes,
/// and pushes that carry the new keys (explicit null when unset).
final class AnyUnitStoreTests: XCTestCase {
    private func v1Store(at path: String) throws {
        let queue = try DatabaseQueue(path: path)
        var migrator = DatabaseMigrator()
        migrator.registerMigration("v1") { db in try db.execute(sql: Schema.v1) }
        try migrator.migrate(queue)
        try queue.write { db in
            try db.execute(sql: """
            INSERT INTO sync_state (key, value) VALUES ('device_id', 'ios-old'), ('pull_cursor', '42');
            INSERT INTO food (id, name, source, carbs_per_100g, updated_at, updated_by, deleted, server_seq)
              VALUES ('f1', 'Rice', 'custom', 28.2, 1000, 'ios-old', 0, 7), ('f2', 'Oats', 'custom', 60, 1000, 'ios-old', 0, NULL);
            INSERT INTO portion (id, food_id, label, kind, quantity, grams, updated_at, updated_by, deleted, server_seq)
              VALUES ('p1', 'f1', 'cup', 'volume', 1, 158, 1000, 'ios-old', 0, 8), ('p2', 'f1', 'bowl', 'serving', 1, 250, 1000, 'ios-old', 1, 9);
            INSERT INTO sync_pending (key, table_name, record_id, queued_at) VALUES ('food/f2', 'food', 'f2', 1000);
            """)
        }
    }

    func testMigratesAnExistingStoreKeepingRows() async throws {
        let path = try temporaryDirectory().appendingPathComponent("carbbook.sqlite").path
        try v1Store(at: path)
        let store = try LocalStore(path: path, now: { 5_000 })

        XCTAssertEqual(store.deviceId, "ios-old")
        XCTAssertEqual(try store.foods().map(\.id), ["f2", "f1"])
        let rice = try XCTUnwrap(try store.foods().first { $0.id == "f1" })
        XCTAssertEqual(rice.carbsPer100g, 28.2)
        XCTAssertNil(rice.carbsPer100ml)
        let all: [PortionData] = try store.records("portion", "ORDER BY id")
        XCTAssertEqual(all, [
            PortionData(id: "p1", foodId: "f1", label: "cup", kind: "volume", quantity: 1, grams: 158, carbsG: nil, deleted: 0),
            PortionData(id: "p2", foodId: "f1", label: "bowl", kind: "serving", quantity: 1, grams: 250, carbsG: nil, deleted: 1),
        ])
        let seq = try await store.dbQueue.read { db in try Int64.fetchOne(db, sql: "SELECT server_seq FROM portion WHERE id = 'p1'") }
        XCTAssertEqual(seq, 8)
        // A carbs_g-only portion (null grams) now fits.
        try store.save("portion", PortionData(id: "p3", foodId: "f1", label: "bar", kind: "count", quantity: 1, grams: nil, carbsG: 22))
        XCTAssertEqual(try store.portions(foodId: "f1").map(\.id), ["p1", "p3"])
        // Portion index recreated; still no foreign keys.
        let meta = try await store.dbQueue.read { db in
            (try Int.fetchOne(db, sql: "SELECT count(*) FROM sqlite_master WHERE name = 'portion_food'"),
             try Int.fetchOne(db, sql: "SELECT count(*) FROM sqlite_master WHERE sql LIKE '%REFERENCES%'"))
        }
        XCTAssertEqual(meta.0, 1)
        XCTAssertEqual(meta.1, 0)
        // Full re-pull so rows pulled by the old schema pick up the new server columns.
        let cursor = try await store.pullCursor()
        XCTAssertEqual(cursor, 0)
    }

    func testRowPendingBeforeMigrationOmitsNewKeysUntilEditedAgain() async throws {
        let path = try temporaryDirectory().appendingPathComponent("carbbook.sqlite").path
        try v1Store(at: path)
        let clock = TestClock(5_000)
        let store = try LocalStore(path: path, now: clock.now)

        var pending = try await store.pendingChanges(limit: 500)
        XCTAssertEqual(pending.map(\.key), ["food/f2"])
        XCTAssertNil(pending[0].record["carbs_per_100ml"], "server keeps its stored value for an edit made before the column existed")
        XCTAssertEqual(pending[0].record["carbs_per_100g"], .number(60))

        clock.ms = 6_000
        try store.save("food", FoodData(id: "f2", name: "Oats", source: "custom", carbsPer100g: 60))
        pending = try await store.pendingChanges(limit: 500)
        XCTAssertEqual(pending[0].record["carbs_per_100ml"], .null)
    }

    func testPullOfVolumeBasisFoodAndCarbsOnlyPortionAppliesTheWholeBatch() async throws {
        let store = try LocalStore(path: nil, now: { 9_000 })
        func meta(_ seq: Int) -> [String: JSONValue] {
            ["updated_at": .number(4_000), "updated_by": .string("web"), "deleted": .number(0), "server_seq": .number(Double(seq))]
        }
        let calrose = SyncChange(table: "food", record: meta(1).merging([
            "id": .string("f1"), "name": .string("Calrose rice"), "brand": .null, "source": .string("custom"), "source_ref": .null,
            "derived_from": .null, "carbs_per_100g": .null, "carbs_per_100ml": .number(20.2884136211058), "fiber_per_100g": .null,
            "density_g_per_ml": .null, "notes": .null,
        ]) { $1 })
        let granola = SyncChange(table: "food", record: meta(2).merging([
            "id": .string("f2"), "name": .string("Granola bar"), "brand": .null, "source": .string("custom"), "source_ref": .null,
            "derived_from": .null, "carbs_per_100g": .null, "carbs_per_100ml": .null, "fiber_per_100g": .null,
            "density_g_per_ml": .null, "notes": .null,
        ]) { $1 })
        let bar = SyncChange(table: "portion", record: meta(3).merging([
            "id": .string("p1"), "food_id": .string("f2"), "label": .string("bar"), "kind": .string("count"),
            "quantity": .number(1), "grams": .null, "carbs_g": .number(22),
        ]) { $1 })
        let meal = SyncChange(table: "meal", record: meta(4).merging([
            "id": .string("m1"), "name": .string("Lunch"), "yield_servings": .number(1), "total_weight_g": .null, "notes": .null,
        ]) { $1 })
        try await store.applyPull([calrose, granola, bar, meal], nextSince: 4)

        let cursor = try await store.pullCursor()
        XCTAssertEqual(cursor, 4)
        let catalog = try store.catalog()
        XCTAssertEqual(catalog.food("f1")?.carbsPer100ml, 20.2884136211058)
        XCTAssertEqual(catalog.portions("f2"), [PortionData(id: "p1", foodId: "f2", label: "bar", kind: "count", quantity: 1, grams: nil,
                                                            carbsG: 22, deleted: 0)])
        let cup = itemCarbs(catalog, .food, "f1", 1, "cup")
        XCTAssertTrue(cup.complete)
        XCTAssertEqual(cup.carbsG, 48, accuracy: 1e-9)
        XCTAssertEqual(itemCarbs(catalog, .food, "f2", 2, "p:p1"), CarbResult(carbsG: 44, complete: true))
        XCTAssertEqual(try store.meals().map(\.name), ["Lunch"])
        XCTAssertEqual(FoodLabel.basisSummary(catalog.food("f1")!, catalog.portions("f1")), "48 g carbs per cup")
    }

    func testPushCarriesNewKeysWithExplicitNullAndRoundTrips() async throws {
        let server = FakeServer()
        let phone = try LocalStore(path: nil, now: { 1_000 })
        let ipad = try LocalStore(path: nil, now: { 2_000 })
        try phone.save("food", FoodData(id: "f1", name: "Calrose rice", source: "custom", carbsPer100g: nil, carbsPer100ml: 20.2884136211058))
        try phone.save("food", FoodData(id: "f2", name: "Granola bar", source: "custom", carbsPer100g: nil))
        try phone.save("portion", PortionData(id: "p1", foodId: "f2", label: "bar", kind: "count", quantity: 1, grams: nil, carbsG: 22))

        let pending = try await phone.pendingChanges(limit: 500)
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        let wire = String(decoding: try encoder.encode(PushRequestProbe(changes: pending)), as: UTF8.self)
        XCTAssertTrue(wire.contains(#""carbs_per_100g":null,"carbs_per_100ml":20.2884136211058"#), wire)
        XCTAssertTrue(wire.contains(#""carbs_per_100g":null,"carbs_per_100ml":null"#), wire)
        XCTAssertTrue(wire.contains(#""carbs_g":22"#), wire)
        XCTAssertTrue(wire.contains(#""grams":null"#), wire)

        _ = try await SyncEngine(store: phone, transport: server).run { 1_000 }
        _ = try await SyncEngine(store: ipad, transport: server).run { 2_000 }
        let mine: [FoodData] = try phone.records("food", "ORDER BY id")
        let theirs: [FoodData] = try ipad.records("food", "ORDER BY id")
        XCTAssertEqual(theirs, mine)
        XCTAssertEqual(try ipad.portions(foodId: "f2"), try phone.portions(foodId: "f2"))
        XCTAssertEqual(itemCarbs(try ipad.catalog(), .food, "f2", 1, "p:p1"), CarbResult(carbsG: 22, complete: true))
    }

    func testUsdaCopyKeepsGramsAndSendsNullCarbsKeys() throws {
        let dir = try temporaryDirectory()
        let path = dir.appendingPathComponent("usda.sqlite").path
        try makeUsdaBundle(at: path, version: "v1")
        let library = try UsdaLibrary(path: path)
        let store = try LocalStore(path: nil, now: { 1_000 })
        let id = try store.adoptUsdaFood(fdcId: 168878, library: library)
        let portions = try store.portions(foodId: id)
        XCTAssertEqual(portions.map(\.grams), [125, 158])
        XCTAssertEqual(portions.map(\.carbsG), [nil, nil])
        let record = try store.dbQueue.read { db in try store.change(db, table: "portion", id: "usda-portion-1")?.record }
        XCTAssertEqual(record?["carbs_g"], .null)
        XCTAssertEqual(record?["grams"], .number(158))
    }
}

/// Same shape as the API client's push body.
private struct PushRequestProbe: Encodable {
    let changes: [SyncChange]
}
