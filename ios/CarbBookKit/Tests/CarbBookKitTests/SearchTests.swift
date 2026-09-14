import CarbBookCore
@testable import CarbBookKit
import XCTest

final class SearchTests: XCTestCase {
    func testSearchRanksMealsAndCustomFoodsFirstThenRecentlyLogged() throws {
        let store = try LocalStore(path: nil, now: { 1_000 })
        try store.save("food", FoodData(id: "off-old", name: "Tortilla wrap", source: "off", carbsPer100g: 50))
        try store.save("food", FoodData(id: "off-new", name: "Tortilla chips", source: "off", carbsPer100g: 60))
        try store.save("food", FoodData(id: "custom", name: "Homemade tortilla", source: "custom", carbsPer100g: 45))
        try store.save("meal", MealData(id: "meal", name: "Tortilla soup", yieldServings: 4))
        try store.save("log_entry", LogEntryData(id: "e1", eatenAt: 900, windowName: nil, bgMgdl: nil, bgSource: "none", bgTrend: nil,
                                                 totalCarbsG: 30, suggestedUnits: nil, takenUnits: nil, settingsVersionId: nil, notes: nil))
        try store.save("log_item", LogItemData(id: "x1", logEntryId: "e1", refType: .food, refId: "off-new", displayName: "Tortilla chips",
                                               amount: 50, unit: "g", carbsG: 30))
        let hits = try store.search("tort", limit: 10, usda: nil)
        XCTAssertEqual(Set(hits.prefix(2).map(\.id)), ["custom", "meal"])
        XCTAssertEqual(hits.dropFirst(2).map(\.id), ["off-new", "off-old"])
    }

    func testDeletedRowsAreNotSearchable() throws {
        let store = try LocalStore(path: nil, now: { 1_000 })
        try store.save("food", FoodData(id: "f1", name: "Tortilla", source: "custom", carbsPer100g: 48))
        XCTAssertEqual(try store.search("tortilla", limit: 10, usda: nil).map(\.id), ["f1"])
        try store.softDelete("food", id: "f1")
        XCTAssertEqual(try store.search("tortilla", limit: 10, usda: nil), [])
    }
}
