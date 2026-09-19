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

    func testServingCarbsNotesShowPer100gPerServing() {
        let bar = FoodData(id: "f", name: "Bar", carbsPer100g: 68.57)
        let serving = PortionData(id: "s", foodId: "f", label: "label serving", kind: "serving", quantity: 1, grams: 35)
        let cup = PortionData(id: "c", foodId: "f", label: "cup", kind: "volume", quantity: 1, grams: 120)
        let piece = PortionData(id: "p", foodId: "f", label: "piece", kind: "count", quantity: 1, grams: 10, carbsG: 6.86)
        var form = FoodForm(food: bar, portions: [serving, cup, piece])
        XCTAssertEqual(form.carbsMode, .per100g)
        XCTAssertEqual(form.servingCarbsNotes, ["= 24 g carbs per label serving (35 g)", "= 6.86 g carbs per piece (10 g)"])
        XCTAssertNil(form.servingCarbsConflict)
        form.carbsText = "50"
        XCTAssertEqual(form.servingCarbsNotes, ["= 17.5 g carbs per label serving (35 g)", "= 6.86 g carbs per piece (10 g)"])
        XCTAssertEqual(form.servingCarbsConflict, "piece (10 g) has 6.86 g carbs, but 50 g per 100 g gives 5 g. Fix one so they match.")
        form.carbsText = "150"
        XCTAssertEqual(form.servingCarbsNotes, [])
        XCTAssertNil(form.servingCarbsConflict)
        form.carbsText = "50"
        form.carbsMode = .label
        XCTAssertEqual(form.servingCarbsNotes, [])
    }

    func testPieceLabelWithWeightIsCheckedAgainstOtherRowsAndToleratesRounding() throws {
        var form = FoodForm(food: nil, portions: [])
        form.name = "Bars"
        form.carbsMode = .label
        form.labelUnit = FoodLabel.other
        form.labelName = "bar"
        form.labelAmount = "1"
        form.labelCarbs = "24"
        form.labelWeight = "35"
        form.portions = [FoodForm.Portion(id: "s", label: "slice", kind: "count", quantity: "1", grams: "30", carbsG: "20")]
        XCTAssertEqual(errors(form), ["slice (30 g) has 20 g carbs, but 68.57 g per 100 g gives 20.57 g. Fix one so they match."])

        var greens = FoodForm(food: nil, portions: [])
        greens.name = "Greens"
        greens.carbsMode = .label
        greens.labelUnit = FoodLabel.other
        greens.labelName = "bag"
        greens.labelAmount = "1"
        greens.labelCarbs = "1"
        greens.labelWeight = "1500"
        XCTAssertEqual(try built(greens).food.carbsPer100g, 0.07, "per 100 g rounding alone must not block (1500 g bag = 1 g carbs)")
    }

    func testPer100gEditThatDisagreesWithAServingsOwnCarbsBlocksSave() throws {
        let bar = FoodData(id: "f", name: "Bar", source: "off", carbsPer100g: 68.57)
        let serving = PortionData(id: "s", foodId: "f", label: "serving", kind: "serving", quantity: 1, grams: 35, carbsG: 24)
        var form = FoodForm(food: bar, portions: [serving])
        XCTAssertNoThrow(try built(form), "the scanned food as saved is consistent")
        form.carbsText = "85.71"
        XCTAssertEqual(errors(form), ["serving (35 g) has 24 g carbs, but 85.71 g per 100 g gives 30 g. Fix one so they match."])
        form.portions[0].carbsG = "30"
        XCTAssertEqual(try built(form).portions.first?.carbsG, 30)
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
            "Portion 2 needs grams or carbs.",
            "Portion 3: grams must be a number above 0.",
            "Portion 3: carbs must be a number from 0 to 500.",
        ])
    }

    func testVolumePortionWithWeightAndCarbsSavesTheWeightAndSetsCarbsPer100ml() throws {
        var form = FoodForm(food: nil, portions: [])
        form.name = "Milk"
        form.carbsText = "5"
        form.portions = [FoodForm.Portion(id: "a", label: "cup", kind: "volume", quantity: "1", grams: "244", carbsG: "12")]
        let out = try built(form)
        XCTAssertNil(out.portions.first?.carbsG)
        XCTAssertEqual(out.portions.first?.grams, 244)
        // Node-verified: 12 / (1 * 236.5882365) * 100 = 5.07210340527645.
        XCTAssertEqual(try XCTUnwrap(out.food.carbsPer100ml), 5.07210340527645, accuracy: 1e-9)
    }

    /// The user's reported case: a 2/3 cup portion labelled "carbs 30" sets carbsPer100ml and saves
    /// no portion row (no weight was entered); core `itemCarbs` then reads back 15 g at 1/3 cup and
    /// 2.8125 g at 1 tbsp (node-verified).
    func testVolumeCarbsOnlyPortionSetsCarbsPer100mlAndItemCarbsRoundTrips() throws {
        var form = FoodForm(food: nil, portions: [])
        form.name = "Juice"
        form.carbsText = "0" // per-100g mode still requires its own field; the portion sets carbsPer100ml separately.
        form.portions = [FoodForm.Portion(id: "a", label: "cup", kind: "volume", quantity: "2/3", grams: "", carbsG: "30")]
        let out = try built(form)
        XCTAssertEqual(out.portions, [])
        XCTAssertEqual(try XCTUnwrap(out.food.carbsPer100ml), 19.02038776978669, accuracy: 1e-9)
        let catalog = InMemoryCatalog(foods: [out.food])
        XCTAssertEqual(itemCarbs(catalog, .food, out.food.id, 1.0 / 3.0, "cup").carbsG, 15, accuracy: 1e-9)
        XCTAssertEqual(itemCarbs(catalog, .food, out.food.id, 1, "tbsp").carbsG, 2.8125, accuracy: 1e-9)
    }

    /// Base food has both bases (per100g mode stays selected, so the label entry isn't a second fresh
    /// source) and a single portion row supplies the only fresh carbsPer100ml: no conflict, just a note.
    func testVolumePortionReplacesADifferentSavedCarbsPer100mlWithANote() throws {
        let rice = FoodData(id: "f1", name: "Rice", source: "custom", carbsPer100g: 28.2, carbsPer100ml: 20.2884136211058)
        var form = FoodForm(food: rice, portions: [])
        XCTAssertEqual(form.carbsMode, .per100g)
        XCTAssertNil(form.portionVolumeCarbsNote)
        form.portions = [FoodForm.Portion(id: "a", label: "cup", kind: "volume", quantity: "1", grams: "", carbsG: "30")]
        XCTAssertEqual(form.portionVolumeCarbsNote, "This replaces saved carbs per volume (20.29 g per 100 ml).")
        let out = try built(form)
        XCTAssertNotEqual(out.food.carbsPer100ml, rice.carbsPer100ml)
    }

    /// Two fresh sources this edit (the label entry pre-filled from a saved ml basis, and a new
    /// portion row) disagreeing by more than 1% blocks save, naming both, instead of one winning.
    func testConflictingLabelEntryAndPortionRowBlocksSave() {
        let rice = FoodData(id: "f1", name: "Rice", source: "custom", carbsPer100g: nil, carbsPer100ml: 20.2884136211058)
        var form = FoodForm(food: rice, portions: [])
        XCTAssertEqual(form.carbsMode, .label)
        form.portions = [FoodForm.Portion(id: "a", label: "cup", kind: "volume", quantity: "1", grams: "", carbsG: "30")]
        XCTAssertEqual(errors(form), ["the label entry and Portion 1 imply different carbs per 100 ml; enter it in one place only."])
    }

    /// Two portion rows disagreeing by more than 1% blocks save, naming both.
    func testConflictingPortionRowsBlockSave() {
        var form = FoodForm(food: nil, portions: [])
        form.name = "Juice"
        form.carbsText = "0"
        form.portions = [
            FoodForm.Portion(id: "a", label: "cup", kind: "volume", quantity: "2/3", grams: "", carbsG: "30"),
            FoodForm.Portion(id: "b", label: "tbsp", kind: "volume", quantity: "1", grams: "", carbsG: "5"),
        ]
        XCTAssertEqual(errors(form), ["Portion 1 and Portion 2 imply different carbs per 100 ml; enter it in one place only."])
    }

    private func mlRow(_ id: String, _ quantity: String, _ carbs: String) -> FoodForm.Portion {
        FoodForm.Portion(id: id, label: "ml", kind: "volume", quantity: quantity, grams: "", carbsG: carbs)
    }

    /// Pairwise, like web: 100 and 99.2 are each within 1% of the first reading (100), but 100.9 vs
    /// 99.2 is 1.68% apart, so save is blocked naming that pair.
    func testEveryPairOfVolumeReadingsMustAgree() {
        var form = FoodForm(food: nil, portions: [])
        form.name = "Juice"
        form.carbsText = "0"
        form.portions = [mlRow("a", "1000", "100"), mlRow("b", "1000", "100.9"), mlRow("c", "1000", "99.2")]
        XCTAssertEqual(errors(form), ["Portion 2 and Portion 3 imply different carbs per 100 ml; enter it in one place only."])
    }

    func testAgreeingLabelEntryAndRowUseTheLabelEntry() throws {
        var form = FoodForm(food: nil, portions: [])
        form.name = "Juice"
        form.carbsMode = .label
        form.labelUnit = "ml"
        form.labelAmount = "100"
        form.labelCarbs = "10"
        form.portions = [FoodForm.Portion(id: "a", label: "cup", kind: "volume", quantity: "1", grams: "", carbsG: "23.8")] // 10.06 / 100 ml
        XCTAssertEqual(try XCTUnwrap(try built(form).food.carbsPer100ml), 10, accuracy: 1e-9)
    }

    func testAgreeingRowsUseTheFirstRow() throws {
        var form = FoodForm(food: nil, portions: [])
        form.name = "Juice"
        form.carbsText = "0"
        form.portions = [mlRow("a", "1000", "100"), mlRow("b", "500", "50.4")] // 10 and 10.08 / 100 ml
        XCTAssertEqual(try XCTUnwrap(try built(form).food.carbsPer100ml), 10, accuracy: 1e-9)
    }

    func testVolumeRowCarbsUseThePortionCarbsRange() {
        var form = FoodForm(food: nil, portions: [])
        form.name = "Syrup"
        form.carbsText = "0"
        form.portions = [FoodForm.Portion(id: "a", label: "l", kind: "volume", quantity: "1", grams: "", carbsG: "600")]
        XCTAssertTrue(errors(form).contains("Portion 1: carbs must be a number from 0 to 500."), "\(errors(form))")
    }

    /// Carbs, fiber, grams and label carbs/weight are decimal fields: "1/2" and "5/2" are errors, never 0.5 / 2.5.
    func testCarbsFieldsRejectFractions() {
        for fraction in ["1/2", "5/2"] {
            var per100 = FoodForm(food: nil, portions: [])
            per100.name = "Bread"
            per100.carbsText = fraction
            XCTAssertTrue(errors(per100).contains("Carbs per 100 g must be a number from 0 to 100."), fraction)

            per100.carbsText = "50"
            per100.fiber = fraction
            per100.portions = [FoodForm.Portion(id: "a", label: "slice", kind: "count", quantity: "1/2", grams: fraction, carbsG: fraction)]
            XCTAssertEqual(errors(per100), [
                "Fiber per 100 g must be a number from 0 to 100.",
                "Portion 1: grams must be a number above 0.",
                "Portion 1: carbs must be a number from 0 to 500.",
            ], fraction)

            var label = FoodForm(food: nil, portions: [])
            label.name = "Cereal"
            label.carbsMode = .label
            label.labelUnit = "cup"
            label.labelAmount = "2/3" // label amount is an amount: fractions are fine here
            label.labelCarbs = fraction
            XCTAssertEqual(label.labelResultText, "Carbs isn't a valid number.", fraction)
            label.labelCarbs = "30"
            label.labelUnit = FoodLabel.other
            label.labelWeight = fraction
            XCTAssertEqual(label.labelResultText, "Weight isn't a valid number.", fraction)
        }
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

    /// The editor rebuilds `FoodData` from scratch on save, so without this the food's image would
    /// be dropped by any ordinary edit (and `LocalStore.writeLocal` would push `image_id: null`).
    func testEditingKeepsTheStoredImage() throws {
        let hash = String(repeating: "b", count: 64)
        var form = FoodForm(food: FoodData(id: "f1", name: "Bread", source: "custom", carbsPer100g: 50, imageId: hash), portions: [])
        XCTAssertEqual(form.imageId, hash)
        form.name = "Sourdough"
        XCTAssertEqual(try built(form).food.imageId, hash)
    }

    /// Removing the image is a deliberate choice, so nil must reach the record and clear the column.
    func testRemovingTheImageClearsIt() throws {
        var form = FoodForm(food: FoodData(id: "f1", name: "Bread", source: "custom", carbsPer100g: 50,
                                           imageId: String(repeating: "b", count: 64)), portions: [])
        form.imageId = nil
        XCTAssertNil(try built(form).food.imageId)
    }

    func testLargeGramsRoundTripWithoutLocaleGrouping() throws {
        let loaf = PortionData(id: "p1", foodId: "f1", label: "loaf", kind: "count", quantity: 1, grams: 1200)
        let form = FoodForm(food: FoodData(id: "f1", name: "Bread", source: "custom", carbsPer100g: 50), portions: [loaf])
        XCTAssertEqual(form.portions.first?.grams, "1200")
        XCTAssertEqual(try built(form).portions.first?.grams, 1200)
    }
}
