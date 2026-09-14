import XCTest
@testable import CarbBookCore

final class FoodBuildersTests: XCTestCase {
    func testCarbsPer100gFromLabel() {
        XCTAssertEqual(carbsPer100gFromLabel(servingGrams: 30, carbsPerServing: 22)!, 73.3333333, accuracy: 1e-6)
        XCTAssertNil(carbsPer100gFromLabel(servingGrams: 0, carbsPerServing: 5))
        XCTAssertNil(carbsPer100gFromLabel(servingGrams: 30, carbsPerServing: -1))
        XCTAssertNil(carbsPer100gFromLabel(servingGrams: 30, carbsPerServing: 31))
    }

    func testValidateFood() {
        XCTAssertNil(validateFood(FoodData(id: "f", name: "Oats", carbsPer100g: 66, fiberPer100g: 10)))
        XCTAssertNil(validateFood(FoodData(id: "f", name: "Unlabeled", carbsPer100g: nil)))
        XCTAssertEqual(validateFood(FoodData(id: "f", name: " ", carbsPer100g: 1)), "name must not be empty")
        XCTAssertEqual(validateFood(FoodData(id: "f", name: "Sugar", carbsPer100g: 100.5)), "carbs_per_100g must be between 0 and 100")
        XCTAssertEqual(validateFood(FoodData(id: "f", name: "Bran", carbsPer100g: 60, fiberPer100g: -1)), "fiber_per_100g must be between 0 and 100")
        XCTAssertEqual(validateFood(FoodData(id: "f", name: "Milk", carbsPer100g: 5, densityGPerMl: 0)), "density_g_per_ml must be > 0")
    }

    // Ids must be byte-identical to the web client's deterministic scheme (carbbook-web-data plan,
    // decision 1 / web/src/lib/ids.ts `usdaFoodId`/`usdaPortionId`): `usda-<fdc_id>` and
    // `usda-portion-<usda portion row id>`, not fresh UUIDv7s, so two devices copying the same
    // USDA food converge on one row via LWW instead of creating duplicates.
    func testCopyUsdaFood() {
        let usda = UsdaFood(fdcId: 168878, name: "Rice, white, cooked", carbsPer100g: 28.2, fiberPer100g: 0.4)
        let portion = UsdaPortion(id: 9, fdcId: 168878, label: "cup", kind: "volume", quantity: 1, grams: 158, description: "1 cup")
        let copy = copyUsdaFood(usda, portions: [portion])
        XCTAssertEqual(copy.food, FoodData(id: "usda-168878", name: "Rice, white, cooked", source: "usda", sourceRef: "168878", carbsPer100g: 28.2, fiberPer100g: 0.4))
        XCTAssertEqual(copy.portions, [PortionData(id: "usda-portion-9", foodId: "usda-168878", label: "cup", kind: "volume", quantity: 1, grams: 158)])
    }

    func testRecordsFromOffDraft() throws {
        let json = #"{"food":{"name":"Granola","brand":"Acme","source":"off","source_ref":"0737628064502","carbs_per_100g":64,"fiber_per_100g":null},"portions":[{"label":"label serving","kind":"serving","quantity":1,"grams":52}],"barcode":"0737628064502","serving_size":"1/2 cup (52 g)"}"#
        let draft = try JSONDecoder().decode(OffDraft.self, from: Data(json.utf8))
        var n = 0
        var edited = draft.food
        edited.name = "Acme granola"
        let records = recordsFromOffDraft(draft, confirmed: edited, newId: { n += 1; return "id\(n)" })
        XCTAssertEqual(records.food.name, "Acme granola")
        XCTAssertEqual(records.food.source, "off")
        XCTAssertEqual(records.portions.first?.grams, 52)
        XCTAssertEqual(records.barcode, BarcodeData(id: "id3", code: "0737628064502", foodId: "id1"))
    }
}
