import XCTest
@testable import CarbBookCore

final class UnitsTests: XCTestCase {
    let rice = FoodData(id: "rice", name: "Rice", carbsPer100g: 28.2)
    let riceCup = PortionData(id: "rice-cup", foodId: "rice", label: "cup", kind: "volume", quantity: 1, grams: 158)
    let bread = FoodData(id: "bread", name: "Bread", carbsPer100g: 49)
    let slice = PortionData(id: "bread-slice", foodId: "bread", label: "slice", kind: "count", quantity: 1, grams: 25)
    let milk = FoodData(id: "milk", name: "Milk", carbsPer100g: 4.8, densityGPerMl: 1.03)

    func testDensityPrefersExplicitThenPortion() {
        XCTAssertEqual(densityOf(milk, []), 1.03)
        XCTAssertEqual(densityOf(rice, [riceCup])!, 158 / 236.5882365, accuracy: 1e-9)
        XCTAssertNil(densityOf(bread, [slice]))
        var infMilk = milk
        infMilk.densityGPerMl = .infinity
        XCTAssertEqual(densityOf(infMilk, [riceCup])!, 158 / 236.5882365, accuracy: 1e-9)
    }

    func testDensityUsesSmallestIdValidVolumePortion() {
        let cupB = PortionData(id: "b-cup", foodId: "rice", label: "cup", kind: "volume", quantity: 1, grams: 300)
        let cupA = PortionData(id: "a-cup", foodId: "rice", label: "cup", kind: "volume", quantity: 1, grams: 200)
        XCTAssertEqual(densityOf(rice, [cupB, cupA])!, 200 / 236.5882365, accuracy: 1e-9)
        let bad = PortionData(id: "a-cup", foodId: "rice", label: "cup", kind: "volume", quantity: 0, grams: 200)
        XCTAssertEqual(densityOf(rice, [bad, riceCup])!, 158 / 236.5882365, accuracy: 1e-9)
    }

    func testFoodAmountToGrams() {
        XCTAssertEqual(foodAmountToGrams(4, "oz", rice, [])!, 113.398093, accuracy: 1e-5)
        XCTAssertEqual(foodAmountToGrams(1, "kg", rice, []), 1000)
        XCTAssertEqual(foodAmountToGrams(2, "tbsp", rice, [riceCup])!, 19.75, accuracy: 1e-6)
        XCTAssertEqual(foodAmountToGrams(2, "p:bread-slice", bread, [slice]), 50)
        XCTAssertNil(foodAmountToGrams(1, "cup", bread, [slice]))
        XCTAssertNil(foodAmountToGrams(1, "handful", rice, []))
        XCTAssertNil(foodAmountToGrams(1, "p:missing", bread, [slice]))
        XCTAssertNil(foodAmountToGrams(-1, "g", rice, []))
        XCTAssertNil(foodAmountToGrams(.nan, "g", rice, []))
    }

    func testRejectsInvalidPortions() {
        for bad in [
            PortionData(id: "bread-slice", foodId: "bread", label: "slice", kind: "count", quantity: 1, grams: 0),
            PortionData(id: "bread-slice", foodId: "bread", label: "slice", kind: "count", quantity: -1, grams: 25),
            PortionData(id: "bread-slice", foodId: "bread", label: "slice", kind: "count", quantity: 1, grams: .infinity),
            PortionData(id: "bread-slice", foodId: "bread", label: "slice", kind: "count", quantity: .nan, grams: 25),
        ] {
            XCTAssertNil(foodAmountToGrams(2, "p:bread-slice", bread, [bad]))
        }
    }

    func testUnitLists() {
        XCTAssertEqual(foodUnits(rice, [riceCup]), ["g", "kg", "oz", "lb", "ml", "l", "tsp", "tbsp", "floz", "cup"])
        XCTAssertEqual(foodUnits(bread, [slice]), ["g", "kg", "oz", "lb", "p:bread-slice"])
        XCTAssertEqual(mealUnits(MealData(id: "m", name: "M", yieldServings: 2, totalWeightG: 414)), ["serving", "g", "kg", "oz", "lb"])
        XCTAssertEqual(mealUnits(MealData(id: "n", name: "N", yieldServings: 1, totalWeightG: nil)), ["serving"])
    }
}
