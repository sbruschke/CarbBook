import CarbBookCore
@testable import CarbBookKit
import Foundation
import XCTest

final class StoreTests: XCTestCase {
    func testSaveStampsQueuesAndFeedsTheCatalog() throws {
        let clock = TestClock(1_000)
        let store = try LocalStore(path: nil, now: clock.now)
        let rice = FoodData(id: "f1", name: "Rice", source: "custom", carbsPer100g: 28.2)
        let saved = try store.save("food", rice)
        XCTAssertEqual(saved.version, RecordVersion(updatedAt: 1_000, updatedBy: store.deviceId))
        XCTAssertEqual(saved.record["brand"], .null)
        XCTAssertTrue(store.deviceId.hasPrefix("ios-"))
        clock.ms = 2_000
        try store.save("food", rice)
        XCTAssertEqual(try store.pendingCount(), 1)
        XCTAssertEqual(try store.catalog().food("f1")?.carbsPer100g, 28.2)
    }

    func testSoftDeleteHidesRowsButQueuesTheDelete() throws {
        let store = try LocalStore(path: nil, now: { 1_000 })
        try store.save("food", FoodData(id: "f1", name: "Tortilla", source: "custom", carbsPer100g: 48))
        try store.softDelete("food", id: "f1")
        XCTAssertNil(try store.catalog().food("f1"))
        XCTAssertEqual(try store.pendingCount(), 1)
    }

    func testDoseSettingsJSONColumnsRoundTrip() throws {
        let store = try LocalStore(path: nil, now: { 1_000 })
        var settings = DoseSettingsData(
            id: "s1", effectiveFrom: 1_786_492_800_000,
            windows: [DoseWindow(name: "Breakfast", start: "05:00", ratioGPerUnit: 8)],
            correction: CorrectionRule(threshold: 200, step: 50, unitsPerStep: 1, mode: "started"),
            rounding: RoundingRule(increment: 1, roundDownBelowBg: nil)
        )
        let saved = try store.save("dose_settings", settings)
        // Nil cutoff is an explicit null, never a missing key (server requires the key).
        XCTAssertEqual(saved.record["rounding"], .object(["increment": .number(1), "round_down_below_bg": .null]))
        settings.deleted = 0
        XCTAssertEqual(try store.doseSettingsVersions(), [settings])
    }

    /// The wire JSON for a record with a nil `round_down_below_bg` carries `"round_down_below_bg":null`,
    /// including after a round trip through the SQLite JSON column.
    func testNilRoundDownBelowBgEncodesAsExplicitJSONNull() throws {
        let store = try LocalStore(path: nil, now: { 1_000 })
        try store.save("dose_settings", DoseSettingsData(
            id: "s1", effectiveFrom: 0,
            windows: [DoseWindow(name: "All", start: "00:00", ratioGPerUnit: 10)],
            correction: CorrectionRule(threshold: 200, step: 50, unitsPerStep: 1, mode: "started"),
            rounding: RoundingRule(increment: 0.5, roundDownBelowBg: nil)))
        let row = try XCTUnwrap(store.dbQueue.read { db in
            try String.fetchOne(db, sql: "SELECT rounding FROM dose_settings WHERE id = 's1'")
        })
        XCTAssertTrue(row.contains(#""round_down_below_bg":null"#), row)
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        let change = try store.dbQueue.read { db in try store.change(db, table: "dose_settings", id: "s1") }
        let wire = String(decoding: try encoder.encode(try XCTUnwrap(change)), as: UTF8.self)
        XCTAssertTrue(wire.contains(#""rounding":{"increment":0.5,"round_down_below_bg":null}"#), wire)
    }

    func testChildRowsSaveBeforeTheirParentsExist() throws {
        let store = try LocalStore(path: nil, now: { 1_000 })
        // No foreign keys: a portion, barcode and meal item may arrive before the food/meal they reference.
        try store.save("portion", PortionData(id: "p1", foodId: "missing-food", label: "cup", kind: "volume", quantity: 1, grams: 100))
        try store.save("barcode", BarcodeData(id: "b1", code: "123456", foodId: "missing-food"))
        try store.save("meal_item", MealItemData(id: "i1", mealId: "missing-meal", refType: .food, refId: "missing-food",
                                                 amount: 1, unit: "g", position: 0))
        XCTAssertEqual(try store.pendingCount(), 3)
        let fkCount = try store.dbQueue.read { db in
            try Int.fetchOne(db, sql: "SELECT count(*) FROM sqlite_master WHERE sql LIKE '%REFERENCES%'")
        }
        XCTAssertEqual(fkCount, 0)
    }

    func testLastDoseAtMsExcludingOneEntry() throws {
        let store = try LocalStore(path: nil, now: { 1_000 })
        try store.save("log_entry", LogEntryData(id: "e1", eatenAt: 1_000, windowName: nil, bgMgdl: nil, bgSource: "none",
                                                  bgTrend: nil, totalCarbsG: 40, suggestedUnits: nil, takenUnits: 4,
                                                  settingsVersionId: nil, notes: nil))
        try store.save("log_entry", LogEntryData(id: "e2", eatenAt: 2_000, windowName: nil, bgMgdl: nil, bgSource: "none",
                                                  bgTrend: nil, totalCarbsG: 30, suggestedUnits: nil, takenUnits: nil,
                                                  settingsVersionId: nil, notes: nil))
        XCTAssertEqual(try store.lastDoseAtMs(), 1_000)
        XCTAssertNil(try store.lastDoseAtMs(excluding: "e1"))
        XCTAssertEqual(try store.lastDoseAtMs(excluding: "e2"), 1_000)
    }

    func testBarcodeLookupMatchesZeroPaddedCodesAndQueue() throws {
        let store = try LocalStore(path: nil, now: { 1_000 })
        try store.save("food", FoodData(id: "f1", name: "Granola", source: "off", carbsPer100g: 64))
        try store.save("barcode", BarcodeData(id: "b1", code: "0737628064502", foodId: "f1"))
        XCTAssertEqual(try store.foodForBarcode("737628064502")?.food.id, "f1")
        XCTAssertNil(try store.foodForBarcode("123456"))
        try store.queueBarcode("123456", note: "offline")
        XCTAssertEqual(try store.queuedBarcodes().map(\.code), ["123456"])
    }
}
