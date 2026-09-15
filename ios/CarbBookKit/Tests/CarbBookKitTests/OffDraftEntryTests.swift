import CarbBookCore
@testable import CarbBookKit
import XCTest

/// Confirming Open Food Facts drafts (mirrors web/test/food-editor.test.tsx draft cases).
final class OffDraftEntryTests: XCTestCase {
    private func ids() -> () -> Id {
        var n = 0
        return { n += 1; return "id\(n)" }
    }

    private func draft(carbs: String = "68.5714285714286", fiber: String = "5.71428571428571", portions: String = #"[{"label":"label serving","kind":"serving","quantity":1,"grams":35}]"#) throws -> OffDraft {
        // Open Food Facts 0016000358447 as fetched 2026-09-15: 24 g carbs per 35 g serving.
        let json = #"{"food":{"name":"Chewy Trail Mix Bar","brand":"Nature Valley","source":"off","source_ref":"0016000358447","carbs_per_100g":\#(carbs),"fiber_per_100g":\#(fiber)},"portions":\#(portions),"barcode":"0016000358447","serving_size":"35g"}"#
        return try JSONDecoder().decode(OffDraft.self, from: Data(json.utf8))
    }

    private func errors(_ entry: OffDraftEntry) -> [String] {
        if case .failure(let errors) = entry.build(newId: ids()) { return errors.messages }
        return []
    }

    func testServingDraftIsEnteredPerServingAndLogsTheLabelNumber() throws {
        let entry = OffDraftEntry(draft: try draft())
        XCTAssertEqual(entry.servingGrams, 35)
        XCTAssertEqual(entry.carbs, "24")
        XCTAssertEqual(entry.per100gText, "= 68.57 g carbs per 100 g")
        let out = try entry.build(newId: ids()).get()
        XCTAssertEqual(out.food.carbsPer100g, 68.57)
        XCTAssertEqual(out.food.source, "off")
        XCTAssertEqual(entry.fiber, "5.71", "fiber prefill is shown to 2 decimals, as before")
        XCTAssertEqual(out.food.fiberPer100g, 5.71)
        XCTAssertEqual(out.portions, [PortionData(id: "id2", foodId: "id1", label: "serving", kind: "serving", quantity: 1, grams: 35, carbsG: 24)])
        XCTAssertEqual(out.barcode, BarcodeData(id: "id3", code: "0016000358447", foodId: "id1"))
        let catalog = InMemoryCatalog(foods: [out.food], portions: out.portions)
        XCTAssertEqual(itemCarbs(catalog, .food, "id1", 1, "p:id2"), CarbResult(carbsG: 24, complete: true))
        XCTAssertEqual(itemCarbs(catalog, .food, "id1", 35, "g").carbsG, 24, accuracy: 0.01)
    }

    func testEditedServingCarbsAndMissingCarbs() throws {
        var entry = OffDraftEntry(draft: try draft(carbs: "null"))
        XCTAssertTrue(entry.carbsMissing)
        XCTAssertEqual(errors(entry), ["Carbs are missing: enter them from the label."])
        entry.carbs = "20"
        XCTAssertEqual(try entry.build(newId: ids()).get().food.carbsPer100g, 57.14)
        entry.carbs = "36"
        XCTAssertEqual(errors(entry), ["Carbs per serving can't be more than the serving weight (35 g)."])
        entry.carbs = "5/2"
        XCTAssertEqual(errors(entry), ["Carbs isn't a valid number."])
        entry.carbs = "3"
        entry.fiber = "10"
        XCTAssertEqual(errors(entry), ["Fiber per 100 g cannot be more than carbs per 100 g."])
    }

    func testDraftWithoutServingWeightStaysPer100g() throws {
        var entry = OffDraftEntry(draft: try draft(portions: "[]"))
        XCTAssertNil(entry.servingGrams)
        XCTAssertNil(entry.per100gText)
        XCTAssertEqual(entry.carbs, "68.57")
        let out = try entry.build(newId: ids()).get()
        XCTAssertEqual(out.food.carbsPer100g, 68.57)
        XCTAssertEqual(out.portions, [])
        entry.carbs = "120"
        XCTAssertEqual(errors(entry), ["Carbs per 100 g must be a number from 0 to 100."])
    }
}
