import CarbBookCore
@testable import CarbBookKit
import XCTest

/// Food editor save rules (mirrors web/test/food-editor.test.tsx behavior).
final class FoodFormTests: XCTestCase {
    private func ids() -> () -> Id {
        var n = 0
        return { n += 1; return "new\(n)" }
    }

    private func built(_ form: FoodForm) throws -> FoodForm.Output {
        switch form.build(newId: ids()) {
        case .success(let output): return output
        case .failure(let errors): XCTFail("unexpected errors: \(errors.messages)"); throw errors
        }
    }

    private func errors(_ form: FoodForm) -> [String] {
        if case .failure(let errors) = form.build(newId: ids()) { return errors.messages }
        return []
    }

    func testCalroseCupWithoutWeightSaves() throws {
        var form = FoodForm(food: nil, portions: [])
        form.name = "Calrose rice"
        form.carbsMode = .label
        form.labelUnit = "cup"
        form.labelAmount = "1"
        form.labelCarbs = "48"
        XCTAssertEqual(form.labelResultText, "= 20.29 g carbs per 100 ml")
        let out = try built(form)
        XCTAssertNil(out.food.carbsPer100g)
        XCTAssertEqual(try XCTUnwrap(out.food.carbsPer100ml), 20.2884136211058, accuracy: 1e-9)
        XCTAssertEqual(out.portions, [])
        XCTAssertEqual(out.food.source, "custom")
        XCTAssertEqual(FoodLabel.basisSummary(out.food, out.portions), "48 g carbs per cup")
        let carbs = itemCarbs(InMemoryCatalog(foods: [out.food]), .food, out.food.id, 1, "cup")
        XCTAssertEqual(carbs.carbsG, 48, accuracy: 1e-9)
    }

    func testPieceWithoutWeightSavesCarbsOnlyPortion() throws {
        var form = FoodForm(food: nil, portions: [])
        form.name = "Granola bar"
        form.carbsMode = .label
        form.labelUnit = "other"
        form.labelName = "bar"
        form.labelAmount = "1"
        form.labelCarbs = "22"
        let out = try built(form)
        XCTAssertEqual(out.portions, [PortionData(id: "new2", foodId: "new1", label: "bar", kind: "count", quantity: 1, grams: nil, carbsG: 22)])
        XCTAssertNil(out.food.carbsPer100g)
    }

    func testGramLabelSetsPer100gAndLabelServing() throws {
        var form = FoodForm(food: nil, portions: [])
        form.name = "Crackers"
        form.carbsMode = .label
        form.labelAmount = "30"
        form.labelCarbs = "22"
        let out = try built(form)
        XCTAssertEqual(out.food.carbsPer100g, 73.33)
        XCTAssertEqual(out.portions.map(\.label), ["label serving"])
        XCTAssertEqual(out.portions.first?.grams, 30)
    }

    func testSavingOneBasisKeepsTheOther() throws {
        let rice = FoodData(id: "f1", name: "Rice", source: "custom", carbsPer100g: 28.2, carbsPer100ml: 20.2884136211058)
        var form = FoodForm(food: rice, portions: [])
        XCTAssertEqual(form.carbsMode, .per100g)
        XCTAssertEqual(form.keptMl, 20.2884136211058)
        form.carbsText = "30"
        var out = try built(form)
        XCTAssertEqual(out.food.carbsPer100g, 30)
        XCTAssertEqual(out.food.carbsPer100ml, 20.2884136211058)

        form.carbsMode = .label
        form.labelUnit = "cup"
        form.labelAmount = "1"
        form.labelCarbs = "50"
        XCTAssertEqual(form.keptG, 28.2)
        out = try built(form)
        XCTAssertEqual(out.food.carbsPer100g, 28.2)
        XCTAssertEqual(try XCTUnwrap(out.food.carbsPer100ml), 50 / Units.volumeMl["cup"]! * 100, accuracy: 1e-9)

        form.removedBaseG = true
        out = try built(form)
        XCTAssertNil(out.food.carbsPer100g)
        XCTAssertNotNil(out.food.carbsPer100ml)
    }

    func testOpensInTheModeTheBasisWasEnteredIn() {
        let rice = FoodData(id: "f1", name: "Rice", carbsPer100g: nil, carbsPer100ml: 20.5)
        let form = FoodForm(food: rice, portions: [])
        XCTAssertEqual(form.carbsMode, .label)
        XCTAssertEqual(form.labelUnit, "ml")
        XCTAssertEqual(form.labelAmount, "100")
        XCTAssertEqual(form.labelCarbs, "20.5")

        let bar = PortionData(id: "p1", foodId: "f2", label: "bar", kind: "count", quantity: 1, grams: nil, carbsG: 22)
        let piece = FoodForm(food: FoodData(id: "f2", name: "Bar", carbsPer100g: nil), portions: [bar])
        XCTAssertEqual(piece.labelUnit, "other")
        XCTAssertEqual(piece.labelName, "bar")
        XCTAssertEqual(piece.portions.first?.grams, "")
    }

    func testReenteringAPieceLabelUpdatesThePortion() throws {
        let bar = PortionData(id: "p1", foodId: "f2", label: "bar", kind: "count", quantity: 1, grams: nil, carbsG: 22)
        var form = FoodForm(food: FoodData(id: "f2", name: "Bar", source: "custom", carbsPer100g: nil), portions: [bar])
        form.labelCarbs = "24"
        form.labelWeight = "40"
        let out = try built(form)
        XCTAssertEqual(out.portions, [PortionData(id: "p1", foodId: "f2", label: "bar", kind: "count", quantity: 1, grams: 40, carbsG: 24)])
        XCTAssertEqual(out.food.carbsPer100g, 60)
        XCTAssertEqual(out.removedPortionIds, [])
    }

    func testNoBasisAndMalformedFieldsAreErrors() {
        var form = FoodForm(food: nil, portions: [])
        form.name = "Mystery"
        XCTAssertEqual(errors(form), ["Carbs are missing: enter them from the label.", "Enter carbs: per 100 g, per cup/etc., or for a piece."])

        form.carbsText = "0x10"
        XCTAssertTrue(errors(form).contains("Carbs per 100 g must be a number from 0 to 100."))

        form.carbsText = "50"
        form.fiber = "1e1"
        form.density = "abc"
        XCTAssertEqual(errors(form), ["Fiber per 100 g must be a number from 0 to 100.", "Density must be greater than 0."])

        form.fiber = ""
        form.density = ""
        form.carbsMode = .label
        form.labelUnit = "cup"
        form.labelAmount = "1"
        form.labelCarbs = "48"
        form.labelWeight = "Infinity"
        XCTAssertEqual(errors(form), ["Weight isn't a valid number.", "Enter carbs: per 100 g, per cup/etc., or for a piece."])
    }

    func testPortionRules() {
        var form = FoodForm(food: nil, portions: [])
        form.name = "Bread"
        form.carbsText = "50"
        form.portions = [
            FoodForm.Portion(id: "a", label: "slice", kind: "count", quantity: "1", grams: "", carbsG: ""),
            FoodForm.Portion(id: "b", label: "cup", kind: "volume", quantity: "1", grams: "", carbsG: ""),
            FoodForm.Portion(id: "c", label: "loaf", kind: "count", quantity: "1", grams: "1,0,0", carbsG: "600"),
        ]
        XCTAssertEqual(errors(form), [
            "Portion 1 needs grams or carbs.",
            "Portion 2 needs grams above 0.",
            "Portion 3: grams must be a number above 0.",
            "Portion 3: carbs must be a number from 0 to 500.",
        ])
    }

    func testVolumePortionNeverSavesCarbs() throws {
        var form = FoodForm(food: nil, portions: [])
        form.name = "Milk"
        form.carbsText = "5"
        form.portions = [FoodForm.Portion(id: "a", label: "cup", kind: "volume", quantity: "1", grams: "244", carbsG: "12")]
        XCTAssertNil(try built(form).portions.first?.carbsG)
    }

    func testUsdaEditMakesCustomCopyWithNewPortionIds() throws {
        let usda = FoodData(id: "usda-1", name: "Rice", source: "usda", sourceRef: "1", carbsPer100g: 28.2)
        let cup = PortionData(id: "usda-portion-1", foodId: "usda-1", label: "cup", kind: "volume", quantity: 1, grams: 158)
        var form = FoodForm(food: usda, portions: [cup])
        form.name = "My rice"
        let out = try built(form)
        XCTAssertEqual(out.food.id, "new1")
        XCTAssertEqual(out.food.source, "custom")
        XCTAssertNil(out.food.sourceRef)
        XCTAssertEqual(out.food.derivedFrom, "usda-1")
        XCTAssertEqual(out.portions.map(\.id), ["new2"])
        XCTAssertEqual(out.portions.map(\.foodId), ["new1"])
        XCTAssertEqual(out.removedPortionIds, [])
    }

    func testRemovedExistingPortionIsReported() throws {
        let slice = PortionData(id: "p1", foodId: "f1", label: "slice", kind: "count", quantity: 1, grams: 30)
        var form = FoodForm(food: FoodData(id: "f1", name: "Bread", source: "custom", carbsPer100g: 50), portions: [slice])
        form.portions = []
        XCTAssertEqual(try built(form).removedPortionIds, ["p1"])
    }

    func testLargeGramsRoundTripWithoutLocaleGrouping() throws {
        let loaf = PortionData(id: "p1", foodId: "f1", label: "loaf", kind: "count", quantity: 1, grams: 1200)
        let form = FoodForm(food: FoodData(id: "f1", name: "Bread", source: "custom", carbsPer100g: 50), portions: [loaf])
        XCTAssertEqual(form.portions.first?.grams, "1200")
        XCTAssertEqual(try built(form).portions.first?.grams, 1200)
    }
}
