import CarbBookCore
@testable import CarbBookKit
import Foundation
import GRDB
import XCTest

final class QuickCarbsKitTests: XCTestCase {
    let catalog = InMemoryCatalog(foods: [FoodData(id: "rice", name: "Rice", source: "custom", carbsPer100g: 28.2)])

    // MARK: - Store

    private func v3Store(at path: String) throws {
        let queue = try DatabaseQueue(path: path)
        var old = DatabaseMigrator()
        old.registerMigration("v1") { db in try db.execute(sql: Schema.v1) }
        old.registerMigration("v2-any-unit-foods") { db in try db.execute(sql: Schema.v2AnyUnitFoods) }
        old.registerMigration("v3-meal-plan") { db in try db.execute(sql: Schema.v3MealPlan) }
        try old.migrate(queue)
        try queue.write { db in
            try db.execute(sql: """
            INSERT INTO sync_state (key, value) VALUES ('device_id', 'ios-old'), ('pull_cursor', '42');
            INSERT INTO meal_item (id, meal_id, ref_type, ref_id, amount, unit, position, updated_at, updated_by, deleted, server_seq)
              VALUES ('mi1', 'm1', 'food', 'rice', 100, 'g', 0, 1000, 'ios-old', 0, 7);
            INSERT INTO plan_item (id, plan_entry_id, ref_type, ref_id, amount, unit, position, updated_at, updated_by, deleted, server_seq)
              VALUES ('pi1', 'p1', 'food', 'rice', 50, 'g', 0, 1000, 'ios-old', 0, NULL);
            INSERT INTO sync_pending (key, table_name, record_id, queued_at) VALUES ('plan_item/pi1', 'plan_item', 'pi1', 1000);
            """)
        }
        try queue.close()
    }

    func testMigratesAV3StoreAddingLabelsAndRepullingEverything() async throws {
        let path = try temporaryDirectory().appendingPathComponent("carbbook.sqlite").path
        try v3Store(at: path)
        let clock = TestClock(5_000)
        let store = try LocalStore(path: path, now: clock.now)

        XCTAssertEqual(store.deviceId, "ios-old")
        let items = try store.mealItems(mealId: "m1")
        XCTAssertEqual(items.map(\.id), ["mi1"])
        XCTAssertNil(items[0].label)
        let seq = try await store.dbQueue.read { db in try Int64.fetchOne(db, sql: "SELECT server_seq FROM meal_item WHERE id = 'mi1'") }
        XCTAssertEqual(seq, 7)
        let cursor = try await store.pullCursor()
        XCTAssertEqual(cursor, 0, "a full re-pull fills in labels an older app could not store")

        var pending = try await store.pendingChanges(limit: 500)
        XCTAssertEqual(pending.map(\.key), ["plan_item/pi1"])
        XCTAssertNil(pending[0].record["label"], "an edit made before the column existed must not clear the server's label")
        XCTAssertEqual(pending[0].record["amount"], .number(50))

        clock.ms = 6_000
        try store.save("plan_item", PlanItemData(id: "pi1", planEntryId: "p1", refType: .food, refId: "rice",
                                                 amount: 60, unit: "g", position: 0))
        pending = try await store.pendingChanges(limit: 500)
        XCTAssertEqual(pending[0].record["label"], .null, "a new edit carries every column")
    }

    func testQuickRowsSyncBetweenDevicesWithTheirLabel() async throws {
        let server = FakeServer()
        let deviceA = try LocalStore(path: nil, now: { 1_000 })
        let deviceB = try LocalStore(path: nil, now: { 1_000 })
        try deviceA.save("meal", MealData(id: "m1", name: "Plate", yieldServings: 1))
        try deviceA.save("meal_item", MealItemData(id: "q1", mealId: "m1", refType: .quick, refId: "q1", amount: 7,
                                                   unit: Units.quick, position: 0, label: "Salsa"))
        try deviceA.save("plan_item", PlanItemData(id: "q2", planEntryId: "p1", refType: .quick, refId: "q2", amount: 5,
                                                   unit: Units.quick, position: 0, label: "Ranch & salad"))
        try deviceA.save("log_item", LogItemData(id: "q3", logEntryId: "e1", refType: .quick, refId: "q3",
                                                 displayName: "Ranch & salad", amount: 7, unit: Units.quick, carbsG: 7))
        _ = try await SyncEngine(store: deviceA, transport: server).run { 1_000 }
        _ = try await SyncEngine(store: deviceB, transport: server).run { 1_000 }

        let catalog = try deviceB.catalog()
        XCTAssertEqual(catalog.mealItems("m1").first?.label, "Salsa")
        XCTAssertEqual(itemCarbs(catalog, .meal, "m1", 1, Units.serving), CarbResult(carbsG: 7, complete: true))
        let planItems: [PlanItemData] = try deviceB.records("plan_item")
        XCTAssertEqual(planItems.first?.label, "Ranch & salad")
        XCTAssertEqual(try deviceB.logItems(entryId: "e1").first?.displayName, "Ranch & salad")
    }

    // MARK: - Inputs, names, plans

    func testQuickCarbsInputIsADecimalWithinTheLimit() {
        XCTAssertEqual(QuickCarbsInput.parse("7"), 7)
        XCTAssertEqual(QuickCarbsInput.parse(" 7,5 "), 7.5)
        XCTAssertEqual(QuickCarbsInput.parse("2000"), 2000)
        for bad in ["", " ", "2001", "1/2", "½", "-1", "1e3", "abc"] {
            XCTAssertNil(QuickCarbsInput.parse(bad), bad)
            XCTAssertTrue(QuickCarbsInput.isInvalid(bad), bad)
        }
        XCTAssertTrue(QuickCarbsInput.modelAmount("abc").isNaN)
        XCTAssertEqual(QuickCarbsInput.rowText(label: " Ranch & salad ", amount: 7), "Ranch & salad — 7 g carbs")
        XCTAssertEqual(QuickCarbsInput.rowText(label: nil, amount: 7.26), "Extra carbs — 7.3 g carbs")
        XCTAssertEqual(QuickCarbsInput.rowText(label: "", amount: .nan), "Extra carbs — enter grams of carbs")
        XCTAssertEqual(QuickCarbsInput.rowText(label: "Big", amount: 2001), "Big — enter grams of carbs")
    }

    func testInvalidQuickAmountsBlockSavingAndLogging() {
        let over = CalculatorLine(id: "l", refType: .quick, refId: "", displayName: "", amount: 2001, unit: Units.quick)
        let fine = CalculatorLine(id: "l", refType: .quick, refId: "", displayName: "", amount: 7, unit: Units.quick)
        XCTAssertTrue(AmountInput.hasInvalidAmount([over]))
        XCTAssertFalse(AmountInput.hasInvalidAmount([fine]))
        let bigFood = CalculatorLine(id: "f", refType: .food, refId: "rice", displayName: "Rice", amount: 5000, unit: "g")
        XCTAssertFalse(AmountInput.hasInvalidAmount([bigFood]), "the 2000 g cap applies to quick carbs only")
        let mealItem = MealItemData(id: "m", mealId: "x", refType: .quick, refId: "m", amount: 2001, unit: Units.quick, position: 0)
        XCTAssertTrue(AmountInput.hasInvalidAmount([mealItem]))
    }

    func testDisplayNamesUnitsAndDayTotals() {
        XCTAssertEqual(itemDisplayName(.quick, "q", label: "Salsa", catalog: catalog), "Salsa")
        XCTAssertEqual(itemDisplayName(.quick, "q", label: "  ", catalog: catalog), "Extra carbs")
        XCTAssertEqual(itemDisplayName(.food, "rice", label: nil, catalog: catalog), "Rice")
        XCTAssertEqual(itemDisplayName(.meal, "gone", label: nil, catalog: catalog), "Unknown item")
        XCTAssertEqual(itemUnits(.quick, "q", currentUnit: Units.quick, catalog: catalog), ["carbs"])
        XCTAssertEqual(itemUnits(.food, "gone", currentUnit: "cup", catalog: catalog), ["cup"])
        XCTAssertEqual(displayUnitName(Units.quick, portions: []), "g carbs")
        XCTAssertEqual(PlanEditing.dayTotalText(CarbResult(carbsG: 72, complete: true)), "72 g")
        XCTAssertEqual(PlanEditing.dayTotalText(CarbResult(carbsG: 80.4167, complete: true)), "80.4 g")
        XCTAssertEqual(PlanEditing.dayTotalText(CarbResult(carbsG: 12, complete: false)), "missing data")
    }

    func testSlotSaveStoresQuickRowsWithLabelAndOwnRefId() throws {
        var n = 0
        let draft = PlanEditing.Draft(date: "2026-09-16", windowName: "Dinner", note: nil, items: [
            PlanEditing.DraftItem(id: nil, refType: .food, refId: "rice", amount: 100, unit: "g"),
            PlanEditing.DraftItem(id: nil, refType: .quick, refId: "", amount: 7, unit: Units.quick, label: "  Ranch & salad "),
        ])
        let changes = try PlanEditing.saveChanges(draft: draft, existing: nil, existingItems: [],
                                                  newId: { n += 1; return "new\(n)" })
        XCTAssertEqual(changes.map(\.table), ["plan_entry", "plan_item", "plan_item"])
        XCTAssertEqual(changes[1].record["label"], .null)
        XCTAssertEqual(changes[1].record["ref_id"], .string("rice"))
        XCTAssertEqual(changes[2].record["ref_type"], .string("quick"))
        XCTAssertEqual(changes[2].record["ref_id"], changes[2].record["id"])
        XCTAssertEqual(changes[2].record["label"], .string("Ranch & salad"))
        XCTAssertEqual(changes[2].record["unit"], .string("carbs"))
    }

    func testSlotSaveRefusesAnOverLimitQuickRow() {
        let draft = PlanEditing.Draft(date: "2026-09-16", windowName: "Dinner", note: nil, items: [
            PlanEditing.DraftItem(id: nil, refType: .quick, refId: "", amount: 2001, unit: Units.quick),
        ])
        XCTAssertThrowsError(try PlanEditing.saveChanges(draft: draft, existing: nil, existingItems: [], newId: { "x" })) {
            XCTAssertEqual($0 as? PlanEditing.EditError, .invalidAmount)
        }
    }

    func testCopyKeepsTheLabelAndRepointsRefId() throws {
        var n = 0
        let source = PlanEntryData(id: "src", date: "2026-09-16", windowName: "Dinner", status: .logged, logEntryId: "l1")
        let quick = PlanItemData(id: "q1", planEntryId: "src", refType: .quick, refId: "q1", amount: 7, unit: Units.quick,
                                 position: 0, label: "Ranch & salad")
        let changes = try PlanEditing.copyChanges(
            sourceEntries: [source], targetEntries: [], itemsByEntry: ["src": [quick]],
            dayOffsets: ["2026-09-16": "2026-09-17"], mode: .skip, newId: { n += 1; return "new\(n)" })
        let item = try XCTUnwrap(changes.first { $0.table == "plan_item" })
        XCTAssertEqual(item.record["id"], .string("new2"))
        XCTAssertEqual(item.record["ref_id"], .string("new2"))
        XCTAssertEqual(item.record["label"], .string("Ranch & salad"))
        XCTAssertEqual(item.record["amount"], .number(7))
    }

    func testSuggestionNamesAndLoadsQuickRows() throws {
        let entry = PlanEntryData(id: "p1", date: "2026-09-16", windowName: "Dinner", status: .planned)
        let items = [
            PlanItemData(id: "i1", planEntryId: "p1", refType: .food, refId: "rice", amount: 100, unit: "g", position: 0),
            PlanItemData(id: "i2", planEntryId: "p1", refType: .quick, refId: "i2", amount: 7, unit: Units.quick, position: 1,
                         label: "Ranch & salad"),
        ]
        let suggestion = try XCTUnwrap(PlanSuggestion.make(entry: entry, items: items, catalog: catalog, dismissed: []))
        XCTAssertEqual(suggestion.itemNames, ["Rice", "Ranch & salad"])
        XCTAssertEqual(suggestion.carbs.carbsG, 35.2, accuracy: 0.001)
        let lines = PlanSuggestion.lines(for: items, catalog: catalog, newLineId: { "line" })
        XCTAssertEqual(lines[1].refType, .quick)
        XCTAssertEqual(lines[1].label, "Ranch & salad")
        XCTAssertEqual(lines[1].displayName, "Ranch & salad")
        XCTAssertEqual(lines[1].unit, Units.quick)
    }
}
