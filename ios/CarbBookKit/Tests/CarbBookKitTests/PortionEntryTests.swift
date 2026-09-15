import CarbBookCore
@testable import CarbBookKit
import XCTest

final class PortionEntryTests: XCTestCase {
    func testVolumeUnitWithWeightOnlySavesAVolumePortionAndNoCarbsPer100ml() {
        let out = PortionEntry.map(.init(unit: "cup", quantity: 1, grams: 244, carbs: nil))
        XCTAssertEqual(out.portion, FoodLabel.PortionPatch(label: "cup", kind: "volume", quantity: 1, grams: 244, carbsG: nil))
        XCTAssertNil(out.carbsPer100ml)
    }

    /// The user's reported case: "2/3 cup, carbs 30" → carbsPer100ml = 30 / (2/3 × 236.5882365) × 100.
    /// Node-verified: 19.02038776978669.
    func testVolumeUnitWithCarbsOnlySetsCarbsPer100mlAndSavesNoPortionRow() {
        let out = PortionEntry.map(.init(unit: "cup", quantity: 2.0 / 3.0, grams: nil, carbs: 30))
        XCTAssertNil(out.portion)
        XCTAssertEqual(try XCTUnwrap(out.carbsPer100ml), 19.02038776978669, accuracy: 1e-9)
    }

    func testVolumeUnitWithBothWeightAndCarbsSavesAPortionAndSetsCarbsPer100ml() {
        let out = PortionEntry.map(.init(unit: "cup", quantity: 1, grams: 244, carbs: 12))
        XCTAssertEqual(out.portion, FoodLabel.PortionPatch(label: "cup", kind: "volume", quantity: 1, grams: 244, carbsG: nil))
        XCTAssertEqual(try XCTUnwrap(out.carbsPer100ml), 5.07210340527645, accuracy: 1e-9)
    }

    func testNamedPieceKeepsGramsAndCarbsOnThePortionRow() {
        let out = PortionEntry.map(.init(unit: "bar", quantity: 1, grams: 40, carbs: 24))
        XCTAssertEqual(out.portion, FoodLabel.PortionPatch(label: "bar", kind: "count", quantity: 1, grams: 40, carbsG: 24))
        XCTAssertNil(out.carbsPer100ml)
    }

    func testNamedServingIsRecognizedCaseInsensitively() {
        let out = PortionEntry.map(.init(unit: "Serving", quantity: 1, grams: nil, carbs: 22))
        XCTAssertEqual(out.portion?.kind, "serving")
    }
}
