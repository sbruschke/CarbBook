import XCTest
@testable import CarbBookCore

final class QuickCarbsTests: XCTestCase {
    let catalog = InMemoryCatalog(
        foods: [FoodData(id: "tortilla", name: "Tortilla", carbsPer100g: 48)],
        meals: [MealData(id: "plate", name: "Plate", yieldServings: 2)],
        mealItems: [
            MealItemData(id: "m1", mealId: "plate", refType: .food, refId: "tortilla", amount: 100, unit: "g", position: 0),
            MealItemData(id: "m2", mealId: "plate", refType: .quick, refId: "m2", amount: 7, unit: Units.quick, position: 1,
                         label: "Salsa"),
        ])

    func testQuickRowsAreTheirOwnCarbs() {
        XCTAssertEqual(itemCarbs(catalog, .quick, "no-such-row", 7, Units.quick), CarbResult(carbsG: 7, complete: true))
        XCTAssertEqual(itemCarbs(catalog, .quick, "", 0, Units.quick), CarbResult(carbsG: 0, complete: true))
        XCTAssertEqual(itemCarbs(catalog, .quick, "q", 2000, Units.quick), CarbResult(carbsG: 2000, complete: true))
    }

    func testInvalidQuickRowsFailClosed() {
        let cases: [(Double, String)] = [
            (2001, Units.quick), (-1, Units.quick), (Double.nan, Units.quick), (Double.infinity, Units.quick), (7, "g"), (7, "serving"),
        ]
        for (amount, unit) in cases {
            XCTAssertEqual(itemCarbs(catalog, .quick, "q", amount, unit), .incomplete, "\(amount) \(unit)")
        }
    }

    func testMealsCountQuickComponentsAndNeverCycle() {
        XCTAssertEqual(itemCarbs(catalog, .meal, "plate", 1, Units.serving).carbsG, 27.5, accuracy: 1e-9)
        XCTAssertFalse(wouldCreateCycle(catalog, "plate", "m2"))
    }

    func testLabelsNamesUnitsAndRefIds() {
        XCTAssertEqual(Units.quick, "carbs")
        XCTAssertEqual(quickUnits(), ["carbs"])
        XCTAssertTrue(isValidQuickCarbs(0))
        XCTAssertTrue(isValidQuickCarbs(2000))
        XCTAssertFalse(isValidQuickCarbs(2000.01))
        XCTAssertFalse(isValidQuickCarbs(.nan))
        XCTAssertNil(normalizeQuickLabel("   "))
        XCTAssertNil(normalizeQuickLabel(nil))
        XCTAssertEqual(normalizeQuickLabel("  Ranch & salad "), "Ranch & salad")
        XCTAssertEqual(normalizeQuickLabel(String(repeating: "x", count: 90)), String(repeating: "x", count: 80))
        XCTAssertEqual(quickDisplayName(nil), "Extra carbs")
        XCTAssertEqual(quickDisplayName(" Salsa "), "Salsa")
        XCTAssertEqual(itemRefId(.quick, "", rowId: "row"), "row")
        XCTAssertEqual(itemRefId(.food, "rice", rowId: "row"), "rice")
    }

    func testItemsEncodeLabelAsExplicitNullAndDecodeQuickRows() throws {
        let food = MealItemData(id: "a", mealId: "m", refType: .food, refId: "f", amount: 1, unit: "g", position: 0)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(food)) as? [String: Any])
        XCTAssertTrue(json["label"] is NSNull, "label is sent as an explicit null, never omitted")
        let plan = PlanItemData(id: "p", planEntryId: "e", refType: .food, refId: "f", amount: 1, unit: "g", position: 0)
        let planJson = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(plan)) as? [String: Any])
        XCTAssertTrue(planJson["label"] is NSNull)

        let decoded = try JSONDecoder().decode(PlanItemData.self, from: Data("""
        {"id":"q","plan_entry_id":"p","ref_type":"quick","ref_id":"q","amount":7,"unit":"carbs","position":1,"label":"Ranch & salad"}
        """.utf8))
        XCTAssertEqual(decoded.refType, .quick)
        XCTAssertEqual(decoded.label, "Ranch & salad")
        let older = try JSONDecoder().decode(MealItemData.self, from: Data("""
        {"id":"a","meal_id":"m","ref_type":"food","ref_id":"f","amount":1,"unit":"g","position":0}
        """.utf8))
        XCTAssertNil(older.label)
        let log = try JSONDecoder().decode(LogItemData.self, from: Data("""
        {"id":"l","log_entry_id":"e","ref_type":"quick","ref_id":"l","display_name":"Ranch & salad","amount":7,"unit":"carbs","carbs_g":7}
        """.utf8))
        XCTAssertEqual(log.refType, .quick)
    }

    let utc: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "UTC")!
        return c
    }()
    // 2026-09-14 18:00 UTC → Dinner in seedSettings.
    let dinner = Date(timeIntervalSince1970: 1_789_408_800)

    func testLogAndMealRecordsSnapshotQuickLines() {
        let lines = [
            CalculatorLine(id: "l1", refType: .food, refId: "tortilla", displayName: "Tortilla", amount: 100, unit: "g"),
            CalculatorLine(id: "l2", refType: .quick, refId: "", displayName: "", amount: 7, unit: Units.quick,
                           label: " Ranch & salad "),
            CalculatorLine(id: "l3", refType: .quick, refId: "", displayName: "", amount: 3, unit: Units.quick),
        ]
        let result = evaluateCalculator(lines: lines, catalog: catalog, settingsVersions: [seedSettings], eatenAt: dinner,
                                        calendar: utc, windowOverride: nil, bg: .none, lastDoseAtMs: nil, nowMs: 0)
        XCTAssertEqual(result.total, CarbResult(carbsG: 58, complete: true))
        XCTAssertNotNil(result.breakdown, "quick rows count toward the dose like any other row")

        var n = 0
        let (entry, items) = buildLogRecords(lines: lines, result: result, bg: .none, eatenAt: dinner, takenUnits: nil,
                                             notes: nil, newId: { n += 1; return "id\(n)" })
        XCTAssertEqual(entry.totalCarbsG, 58)
        XCTAssertEqual(items.map(\.displayName), ["Tortilla", "Ranch & salad", "Extra carbs"])
        XCTAssertEqual(items.map(\.refId), ["tortilla", items[1].id, items[2].id])
        XCTAssertEqual(items.map(\.carbsG), [48, 7, 3])
        XCTAssertEqual(items[1].unit, Units.quick)

        let meal = buildMealRecords(name: "Taco", yieldServings: 1, totalWeightG: nil, lines: lines,
                                    newId: { n += 1; return "id\(n)" })
        XCTAssertEqual(meal.items.map(\.label), [nil, "Ranch & salad", nil])
        XCTAssertEqual(meal.items[1].refId, meal.items[1].id)
        XCTAssertEqual(meal.items[0].refId, "tortilla")
    }

    func testAnInvalidQuickLineRefusesTheDose() {
        let lines = [CalculatorLine(id: "l1", refType: .quick, refId: "", displayName: "", amount: 2001, unit: Units.quick)]
        let result = evaluateCalculator(lines: lines, catalog: catalog, settingsVersions: [seedSettings], eatenAt: dinner,
                                        calendar: utc, windowOverride: nil, bg: .none, lastDoseAtMs: nil, nowMs: 0)
        XCTAssertFalse(result.total.complete)
        XCTAssertNil(result.breakdown)
        XCTAssertNotNil(result.refusal)
    }

    func testRecalculationKeepsAQuickRowsLoggedName() {
        let entry = LogEntryData(id: "e1", eatenAt: 1_789_408_800_000, windowName: "Dinner", bgMgdl: nil, bgSource: "none",
                                 bgTrend: nil, totalCarbsG: 55, suggestedUnits: 7, takenUnits: 7, settingsVersionId: "s1", notes: nil)
        let items = [
            LogItemData(id: "x1", logEntryId: "e1", refType: .food, refId: "tortilla", displayName: "Old name", amount: 100, unit: "g", carbsG: 40),
            LogItemData(id: "x2", logEntryId: "e1", refType: .quick, refId: "x2", displayName: "Ranch & salad", amount: 7,
                        unit: Units.quick, carbsG: 7),
        ]
        let result = recalculateLogEntry(entry: entry, items: items, catalog: catalog, settingsVersions: [seedSettings])
        XCTAssertTrue(result.complete)
        XCTAssertEqual(result.items.map(\.displayName), ["Tortilla", "Ranch & salad"])
        XCTAssertEqual(result.items.map(\.carbsG), [48, 7])
        XCTAssertEqual(result.entry.totalCarbsG, 55)
    }
}
