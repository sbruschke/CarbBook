import XCTest
@testable import CarbBookCore

final class CarbsTests: XCTestCase {
    let catalog = InMemoryCatalog(
        foods: [
            FoodData(id: "rice", name: "Rice", carbsPer100g: 28.2),
            FoodData(id: "corn", name: "Cream corn", carbsPer100g: 18.13),
            FoodData(id: "bread", name: "Bread", carbsPer100g: 49),
            FoodData(id: "mystery", name: "Mystery", carbsPer100g: nil),
        ],
        portions: [
            PortionData(id: "rice-cup", foodId: "rice", label: "cup", kind: "volume", quantity: 1, grams: 158),
            PortionData(id: "corn-cup", foodId: "corn", label: "cup", kind: "volume", quantity: 1, grams: 256),
            PortionData(id: "bread-slice", foodId: "bread", label: "slice", kind: "count", quantity: 1, grams: 25),
        ],
        meals: [
            MealData(id: "rice-corn", name: "Rice and corn", yieldServings: 2, totalWeightG: 414),
            MealData(id: "plate", name: "Plate", yieldServings: 1),
            MealData(id: "bad", name: "Bad", yieldServings: 1),
        ],
        mealItems: [
            MealItemData(id: "i2", mealId: "rice-corn", refType: .food, refId: "corn", amount: 1, unit: "cup", position: 1),
            MealItemData(id: "i1", mealId: "rice-corn", refType: .food, refId: "rice", amount: 1, unit: "cup", position: 0),
            MealItemData(id: "i3", mealId: "plate", refType: .meal, refId: "rice-corn", amount: 1.5, unit: "serving", position: 0),
            MealItemData(id: "i4", mealId: "plate", refType: .food, refId: "bread", amount: 1, unit: "p:bread-slice", position: 1),
            MealItemData(id: "i5", mealId: "bad", refType: .food, refId: "rice", amount: 100, unit: "g", position: 0),
            MealItemData(id: "i6", mealId: "bad", refType: .food, refId: "mystery", amount: 50, unit: "g", position: 1),
        ]
    )

    func testFoodCarbs() {
        let r = itemCarbs(catalog, .food, "rice", 1, "cup")
        XCTAssertTrue(r.complete)
        XCTAssertEqual(r.carbsG, 44.556, accuracy: 1e-6)
        XCTAssertEqual(itemCarbs(catalog, .food, "mystery", 50, "g"), .incomplete)
        XCTAssertEqual(itemCarbs(catalog, .food, "bread", 1, "cup"), .incomplete)
        XCTAssertEqual(itemCarbs(catalog, .food, "nope", 1, "g"), .incomplete)
    }

    func testMealServingsGramsAndNesting() {
        XCTAssertEqual(itemCarbs(catalog, .meal, "rice-corn", 1, "serving").carbsG, 45.4844, accuracy: 1e-6)
        XCTAssertEqual(itemCarbs(catalog, .meal, "rice-corn", 100, "g").carbsG, 21.97314, accuracy: 1e-5)
        let nested = itemCarbs(catalog, .meal, "plate", 1, "serving")
        XCTAssertTrue(nested.complete)
        XCTAssertEqual(nested.carbsG, 80.4766, accuracy: 1e-6)
        XCTAssertEqual(itemCarbs(catalog, .meal, "plate", 1, "g"), .incomplete)
        let bad = itemCarbs(catalog, .meal, "bad", 1, "serving")
        XCTAssertFalse(bad.complete)
        XCTAssertEqual(bad.carbsG, 28.2, accuracy: 1e-6)
    }

    func testInvalidStoredValuesAreIncomplete() {
        let invalid = InMemoryCatalog(foods: [
            FoodData(id: "neg", name: "Neg", carbsPer100g: -1),
            FoodData(id: "huge", name: "Huge", carbsPer100g: 101),
            FoodData(id: "inf", name: "Inf", carbsPer100g: .infinity),
            FoodData(id: "nan", name: "NaN", carbsPer100g: .nan),
            FoodData(id: "edge0", name: "Edge0", carbsPer100g: 0),
            FoodData(id: "edge100", name: "Edge100", carbsPer100g: 100),
        ])
        for id in ["neg", "huge", "inf", "nan"] {
            XCTAssertFalse(itemCarbs(invalid, .food, id, 50, "g").complete, id)
        }
        XCTAssertEqual(itemCarbs(invalid, .food, "edge0", 50, "g"), CarbResult(carbsG: 0, complete: true))
        XCTAssertEqual(itemCarbs(invalid, .food, "edge100", 50, "g"), CarbResult(carbsG: 50, complete: true))
    }

    func testEmptyMealAndNonFiniteMealFieldsAreIncomplete() {
        XCTAssertEqual(itemCarbs(InMemoryCatalog(meals: [MealData(id: "empty", name: "Empty", yieldServings: 1)]), .meal, "empty", 1, "serving"), .incomplete)
        let badMeal = InMemoryCatalog(
            foods: [FoodData(id: "rice", name: "Rice", carbsPer100g: 28.2)],
            meals: [
                MealData(id: "inf-yield", name: "InfYield", yieldServings: .infinity),
                MealData(id: "inf-weight", name: "InfWeight", yieldServings: 1, totalWeightG: .infinity),
            ],
            mealItems: [
                MealItemData(id: "i1", mealId: "inf-yield", refType: .food, refId: "rice", amount: 100, unit: "g", position: 0),
                MealItemData(id: "i2", mealId: "inf-weight", refType: .food, refId: "rice", amount: 100, unit: "g", position: 0),
            ]
        )
        XCTAssertFalse(itemCarbs(badMeal, .meal, "inf-yield", 1, "serving").complete)
        XCTAssertFalse(itemCarbs(badMeal, .meal, "inf-weight", 100, "g").complete)
    }

    func testSoftDeletedRowsAreSkipped() {
        let c = InMemoryCatalog(
            foods: [
                FoodData(id: "rice", name: "Rice", carbsPer100g: 28.2),
                FoodData(id: "ghost-food", name: "Ghost", carbsPer100g: 10, deleted: 1),
            ],
            portions: [
                PortionData(id: "rice-cup", foodId: "rice", label: "cup", kind: "volume", quantity: 1, grams: 158),
                PortionData(id: "ghost-portion", foodId: "rice", label: "tbsp", kind: "volume", quantity: 1, grams: 10, deleted: 1),
            ],
            meals: [
                MealData(id: "plate", name: "Plate", yieldServings: 1),
                MealData(id: "ghost-meal", name: "Ghost meal", yieldServings: 1, deleted: 1),
            ],
            mealItems: [
                MealItemData(id: "i1", mealId: "plate", refType: .food, refId: "rice", amount: 100, unit: "g", position: 0),
                MealItemData(id: "ghost-item", mealId: "plate", refType: .food, refId: "rice", amount: 999, unit: "g", position: 1, deleted: 1),
            ]
        )
        XCTAssertNil(c.food("ghost-food"))
        XCTAssertNil(c.meal("ghost-meal"))
        XCTAssertEqual(c.portions("rice").map(\.id), ["rice-cup"])
        XCTAssertEqual(c.mealItems("plate").map(\.id), ["i1"])
        XCTAssertEqual(itemCarbs(c, .meal, "plate", 1, "serving").carbsG, 28.2, accuracy: 1e-9)
    }

    func testCycles() {
        XCTAssertTrue(wouldCreateCycle(catalog, "plate", "plate"))
        XCTAssertTrue(wouldCreateCycle(catalog, "rice-corn", "plate"))
        XCTAssertFalse(wouldCreateCycle(catalog, "plate", "bad"))
        let cyclic = InMemoryCatalog(
            meals: [MealData(id: "a", name: "A", yieldServings: 1), MealData(id: "b", name: "B", yieldServings: 1)],
            mealItems: [
                MealItemData(id: "x", mealId: "a", refType: .meal, refId: "b", amount: 1, unit: "serving", position: 0),
                MealItemData(id: "y", mealId: "b", refType: .meal, refId: "a", amount: 1, unit: "serving", position: 0),
            ]
        )
        XCTAssertFalse(itemCarbs(cyclic, .meal, "a", 1, "serving").complete)
    }

    func testSumCarbs() {
        XCTAssertEqual(sumCarbs([CarbResult(carbsG: 10, complete: true), CarbResult(carbsG: 5, complete: false)]), CarbResult(carbsG: 15, complete: false))
        XCTAssertEqual(sumCarbs([]), CarbResult(carbsG: 0, complete: true))
    }

    // Mirrors packages/core/test/carbs.test.ts "any-unit foods: carbs".
    func testAnyUnitFoodsCarbs() {
        let c = InMemoryCatalog(
            foods: [
                FoodData(id: "vol-fallback", name: "Per-100 ml invalid, per-100 g + density", carbsPer100g: 50, carbsPer100ml: 151, densityGPerMl: 2),
                FoodData(id: "ml-edges", name: "Edges", carbsPer100g: nil, carbsPer100ml: 150),
                FoodData(id: "ml-nan", name: "NaN", carbsPer100g: nil, carbsPer100ml: .nan, densityGPerMl: 1),
                FoodData(id: "ml-neg", name: "Neg", carbsPer100g: nil, carbsPer100ml: -1),
                FoodData(id: "portion-fallback", name: "Portion carbs invalid, grams valid", carbsPer100g: 40),
                FoodData(id: "portion-none", name: "Portion carbs, no basis", carbsPer100g: nil),
            ],
            portions: [
                PortionData(id: "big", foodId: "portion-fallback", label: "big", kind: "count", quantity: 2, grams: 50, carbsG: 501),
                PortionData(id: "zero-q", foodId: "portion-none", label: "zq", kind: "count", quantity: 0, grams: nil, carbsG: 10),
                PortionData(id: "serv", foodId: "portion-none", label: "serving", kind: "serving", quantity: 2, grams: nil, carbsG: 500),
                PortionData(id: "grams-only", foodId: "portion-none", label: "g", kind: "count", quantity: 1, grams: 30, carbsG: nil),
            ]
        )

        let volFallback = itemCarbs(c, .food, "vol-fallback", 10, "ml")
        XCTAssertTrue(volFallback.complete)
        XCTAssertEqual(volFallback.carbsG, 10, accuracy: 1e-9)

        XCTAssertEqual(itemCarbs(c, .food, "ml-edges", 100, "ml"), CarbResult(carbsG: 150, complete: true))
        XCTAssertFalse(itemCarbs(c, .food, "ml-nan", 100, "ml").complete)
        XCTAssertFalse(itemCarbs(c, .food, "ml-nan", 100, "g").complete)
        XCTAssertFalse(itemCarbs(c, .food, "ml-neg", 100, "ml").complete)

        let portionFallback = itemCarbs(c, .food, "portion-fallback", 1, "p:big")
        XCTAssertTrue(portionFallback.complete)
        XCTAssertEqual(portionFallback.carbsG, 10, accuracy: 1e-9)

        XCTAssertEqual(itemCarbs(c, .food, "portion-none", 1, "p:zero-q"), CarbResult(carbsG: 0, complete: false))
        XCTAssertEqual(itemCarbs(c, .food, "portion-none", 1, "p:serv"), CarbResult(carbsG: 250, complete: true))
        XCTAssertEqual(itemCarbs(c, .food, "portion-none", 1, "p:grams-only"), CarbResult(carbsG: 0, complete: false))
        XCTAssertFalse(itemCarbs(c, .food, "portion-none", -1, "p:serv").complete)
        XCTAssertFalse(itemCarbs(c, .food, "portion-none", .nan, "p:serv").complete)
    }
}
