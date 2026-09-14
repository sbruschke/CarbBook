import CarbBookCore
@testable import CarbBookKit
import XCTest

/// Ports of web/test/label.test.ts plus the unit display helpers.
final class FoodLabelTests: XCTestCase {
    private func basis(_ unit: String, _ amount: Double?, _ carbs: Double?, weight: Double? = nil, label: String = "") throws -> FoodLabel.Basis {
        try FoodLabel.basis(unit: unit, amount: amount, carbs: carbs, weight: weight, label: label).get()
    }

    private func isError(_ unit: String, _ amount: Double?, _ carbs: Double?, weight: Double? = nil, label: String = "") -> Bool {
        if case .failure = FoodLabel.basis(unit: unit, amount: amount, carbs: carbs, weight: weight, label: label) { return true }
        return false
    }

    func testGramLabelMapsToCarbsPer100g() throws {
        XCTAssertEqual(try basis("g", 40, 20), FoodLabel.Basis(carbsPer100g: 50, carbsPer100ml: nil, portion: nil))
        XCTAssertEqual(try basis("g", 30, 22).carbsPer100g, 73.33)
    }

    func testCalroseCupMapsToCarbsPer100ml() throws {
        let r = try basis("cup", 1, 48)
        XCTAssertEqual(try XCTUnwrap(r.carbsPer100ml), 20.2884136211058, accuracy: 1e-9)
        XCTAssertNil(r.carbsPer100g)
        XCTAssertNil(r.portion)
        XCTAssertEqual(try XCTUnwrap(try basis("tbsp", 2, 7).carbsPer100ml), 23.6698158912901, accuracy: 1e-9)
    }

    func testVolumeLabelWithWeightAddsVolumePortion() throws {
        XCTAssertEqual(try basis("cup", 1, 48, weight: 158).portion,
                       FoodLabel.PortionPatch(label: "cup", kind: "volume", quantity: 1, grams: 158, carbsG: nil))
    }

    func testPieceLabels() throws {
        let bar = try basis("other", 1, 22, label: "bar")
        XCTAssertEqual(bar, FoodLabel.Basis(carbsPer100g: nil, carbsPer100ml: nil,
                                            portion: FoodLabel.PortionPatch(label: "bar", kind: "count", quantity: 1, grams: nil, carbsG: 22)))
        let cookie = try basis("other", 1, 20, weight: 30, label: " cookie ")
        XCTAssertEqual(cookie.carbsPer100g, 66.67)
        XCTAssertEqual(cookie.portion, FoodLabel.PortionPatch(label: "cookie", kind: "count", quantity: 1, grams: 30, carbsG: 20))
        XCTAssertEqual(try basis("other", 1, 20, label: "Serving").portion?.kind, "serving")
        XCTAssertEqual(try basis("other", 1, 20, label: "servings").portion?.kind, "count", "serving kind only for the literal label")
    }

    func testRejections() {
        XCTAssertTrue(isError("g", 0, 20))
        XCTAssertTrue(isError("cup", -1, 20))
        XCTAssertTrue(isError("g", nil, 20))
        XCTAssertTrue(isError("g", 40, nil))
        XCTAssertTrue(isError("g", 10, 20), "over 100 g per 100 g")
        XCTAssertTrue(isError("other", 1, 22, label: "  "))
        XCTAssertTrue(isError("ml", 1, 2), "200 g per 100 ml is over the 150 max")
        XCTAssertTrue(isError("other", 1, 501, label: "cake"))
        XCTAssertTrue(isError("kg", 1, 5), "not a label unit")
    }

    func testBasisSummary() {
        let food = FoodData(id: "f", name: "x", carbsPer100g: 48)
        XCTAssertEqual(FoodLabel.basisSummary(food, []), "48 g carbs per 100 g")
        let rice = FoodData(id: "f", name: "Calrose", carbsPer100g: nil, carbsPer100ml: 20.2884136211058)
        let cup = PortionData(id: "p", foodId: "f", label: "cup", kind: "volume", quantity: 1, grams: 158)
        XCTAssertEqual(FoodLabel.basisSummary(rice, [cup]), "48 g carbs per cup")
        XCTAssertEqual(FoodLabel.basisSummary(rice, []), "48 g carbs per cup")
        let halfCup = PortionData(id: "p", foodId: "f", label: "cup", kind: "volume", quantity: 0.5, grams: 79)
        XCTAssertEqual(FoodLabel.basisSummary(rice, [halfCup]), "24 g carbs per 0.5 cup")
        let bar = PortionData(id: "p", foodId: "f", label: "bar", kind: "count", quantity: 1, grams: nil, carbsG: 22)
        XCTAssertEqual(FoodLabel.basisSummary(FoodData(id: "f", name: "x", carbsPer100g: nil), [bar]), "22 g carbs per bar")
        XCTAssertNil(FoodLabel.basisSummary(FoodData(id: "f", name: "x", carbsPer100g: nil), []))
        XCTAssertNil(FoodLabel.basisSummary(FoodData(id: "f", name: "x", carbsPer100g: 250), []), "invalid basis is not shown as valid")
    }

    func testUnitDisplayAndPickerOptions() {
        let slice = PortionData(id: "s", foodId: "f", label: "slice", kind: "count", quantity: 2, grams: 60)
        let bar = PortionData(id: "b", foodId: "f", label: "bar", kind: "count", quantity: 1, grams: nil, carbsG: 22)
        XCTAssertEqual(displayUnitName("p:s", portions: [slice, bar]), "slice (30 g)")
        XCTAssertEqual(displayUnitName("p:b", portions: [slice, bar]), "bar")
        XCTAssertEqual(displayUnitName("p:zz", portions: [slice]), "missing portion")
        XCTAssertEqual(displayUnitName("floz", portions: []), "fl oz")
        XCTAssertEqual(FoodLabel.unitName("other"), "piece / serving")

        XCTAssertEqual(unitPickerOptions(units: ["g", "cup"], current: "cup").map(\.valid), [true, true])
        let stale = unitPickerOptions(units: [], current: "g")
        XCTAssertEqual(stale.map(\.unit), ["g"])
        XCTAssertEqual(stale.map(\.valid), [false])
    }

    func testDefaultAmountAndUnit() {
        let rice = FoodData(id: "f", name: "Calrose", carbsPer100g: nil, carbsPer100ml: 20.29)
        XCTAssertEqual(defaultFoodAmountAndUnit(rice, []).unit, "cup")
        XCTAssertEqual(defaultFoodAmountAndUnit(rice, []).amount, 1)
        let bar = PortionData(id: "b", foodId: "f", label: "bar", kind: "count", quantity: 1, grams: nil, carbsG: 22)
        XCTAssertEqual(defaultFoodAmountAndUnit(FoodData(id: "f", name: "x", carbsPer100g: nil), [bar]).unit, "p:b")
        XCTAssertEqual(defaultFoodAmountAndUnit(FoodData(id: "f", name: "x", carbsPer100g: 50), []).unit, "g")
    }

    func testSearchHitBasisText() {
        XCTAssertEqual(SearchHit(kind: .food, id: "f", name: "x", brand: nil, source: nil, carbsPer100g: 28.2).basisText, "28.2 g/100 g")
        XCTAssertEqual(SearchHit(kind: .food, id: "f", name: "x", brand: nil, source: nil, carbsPer100g: nil,
                                 carbsPer100ml: 20.2884136211058).basisText, "48 g/cup")
        XCTAssertEqual(SearchHit(kind: .food, id: "f", name: "x", brand: nil, source: nil, carbsPer100g: nil, hasPortionCarbs: true).basisText,
                       "per piece")
        XCTAssertNil(SearchHit(kind: .food, id: "f", name: "x", brand: nil, source: nil, carbsPer100g: nil).basisText)
    }

    func testEditTextRoundTripsThroughStrictParsing() {
        XCTAssertEqual(NumberParsing.editText(1000), "1000")
        XCTAssertEqual(NumberParsing.parseAmount(NumberParsing.editText(1200.5)), 1200.5)
        XCTAssertEqual(NumberParsing.editText(20.2884136211058, maxFractionDigits: 2), "20.29")
        XCTAssertEqual(NumberParsing.editText(0.1), "0.1")
        XCTAssertEqual(NumberParsing.editText(nil), "")
        XCTAssertEqual(NumberParsing.editText(1e-12), "0")
    }
}
