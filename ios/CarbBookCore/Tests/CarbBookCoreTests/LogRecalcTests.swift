import XCTest
@testable import CarbBookCore

final class LogRecalcTests: XCTestCase {
    func testRefreshesSnapshotFromCurrentCatalog() {
        let catalog = InMemoryCatalog(
            foods: [FoodData(id: "rice", name: "Rice, jasmine", carbsPer100g: 30)],
            meals: [MealData(id: "bowl", name: "Bowl", yieldServings: 2)],
            mealItems: [MealItemData(id: "i1", mealId: "bowl", refType: .food, refId: "rice", amount: 200, unit: "g", position: 0)]
        )
        let entry = LogEntryData(id: "e1", eatenAt: 1_789_408_800_000, windowName: "Dinner", bgMgdl: 150, bgSource: "manual",
                                 bgTrend: nil, totalCarbsG: 50, suggestedUnits: 6, takenUnits: 6, settingsVersionId: "s1", notes: nil)
        let items = [
            LogItemData(id: "x1", logEntryId: "e1", refType: .food, refId: "rice", displayName: "Rice", amount: 100, unit: "g", carbsG: 28),
            LogItemData(id: "x2", logEntryId: "e1", refType: .meal, refId: "bowl", displayName: "Old bowl", amount: 1, unit: "serving", carbsG: 22),
        ]
        let result = recalculateLogEntry(entry: entry, items: items, catalog: catalog, settingsVersions: [seedSettings])
        XCTAssertTrue(result.complete)
        XCTAssertEqual(result.items.map(\.displayName), ["Rice, jasmine", "Bowl"])
        XCTAssertEqual(result.items.map(\.carbsG), [30, 30])
        XCTAssertEqual(result.entry.totalCarbsG, 60)
        XCTAssertEqual(result.entry.suggestedUnits, 8) // Dinner 1:8 → 7.5 → half-up 8
        XCTAssertEqual(result.entry.takenUnits, 6)
        XCTAssertEqual(result.entry.settingsVersionId, "s1")
    }

    func testIncompleteItemsClearTheSuggestion() {
        let entry = LogEntryData(id: "e1", eatenAt: 1_789_408_800_000, windowName: "Dinner", bgMgdl: nil, bgSource: "none",
                                 bgTrend: nil, totalCarbsG: 10, suggestedUnits: 1, takenUnits: 1, settingsVersionId: "s1", notes: nil)
        let items = [LogItemData(id: "x1", logEntryId: "e1", refType: .food, refId: "gone", displayName: "Gone", amount: 1, unit: "g", carbsG: 10)]
        let result = recalculateLogEntry(entry: entry, items: items, catalog: InMemoryCatalog(), settingsVersions: [seedSettings])
        XCTAssertFalse(result.complete)
        XCTAssertNil(result.entry.suggestedUnits)
        XCTAssertEqual(result.items[0].displayName, "Gone")
    }
}
