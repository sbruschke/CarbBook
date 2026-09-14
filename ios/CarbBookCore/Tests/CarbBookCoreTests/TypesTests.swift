import XCTest
@testable import CarbBookCore

final class TypesTests: XCTestCase {
    func testJSONValueDecodesEveryKind() throws {
        let json = #"{"a":null,"b":true,"c":1,"d":"x","e":[1.5],"f":{"g":false}}"#
        let value = try JSONDecoder().decode(JSONValue.self, from: Data(json.utf8))
        XCTAssertEqual(value, .object([
            "a": .null, "b": .bool(true), "c": .number(1), "d": .string("x"),
            "e": .array([.number(1.5)]), "f": .object(["g": .bool(false)]),
        ]))
        let roundTrip = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(value))
        XCTAssertEqual(roundTrip, value)
    }

    func testFoodDecodesColumnNamesAndMissingOptionals() throws {
        let json = #"{"id":"milk","name":"Milk","carbs_per_100g":4.8,"density_g_per_ml":1.03}"#
        let food = try JSONDecoder().decode(FoodData.self, from: Data(json.utf8))
        XCTAssertEqual(food, FoodData(id: "milk", name: "Milk", carbsPer100g: 4.8, densityGPerMl: 1.03))
        XCTAssertNil(food.deleted)
        let nullCarbs = try JSONDecoder().decode(FoodData.self, from: Data(#"{"id":"m","name":"M","carbs_per_100g":null}"#.utf8))
        XCTAssertNil(nullCarbs.carbsPer100g)
    }

    func testDoseSettingsRoundTripThroughJSONValue() throws {
        let settings = DoseSettingsData(
            id: "s1", effectiveFrom: 1_786_492_800_000,
            windows: [DoseWindow(name: "Breakfast", start: "05:00", ratioGPerUnit: 8)],
            correction: CorrectionRule(threshold: 200, step: 50, unitsPerStep: 1, mode: "started"),
            rounding: RoundingRule(increment: 1, roundDownBelowBg: 130)
        )
        let value = try JSONValue.from(settings)
        guard case .object(let object) = value else { return XCTFail("not an object") }
        XCTAssertEqual(object["effective_from"], .number(1_786_492_800_000))
        XCTAssertEqual(try value.decode(DoseSettingsData.self), settings)
    }

    /// Item 5: the server rejects a missing `round_down_below_bg` key; a nil value must encode
    /// as an explicit JSON null, not be omitted.
    func testNilRoundDownBelowBgEncodesAsExplicitNull() throws {
        var settings = seedSettings
        settings.rounding.roundDownBelowBg = nil
        let value = try JSONValue.from(settings)
        guard case .object(let object) = value, case .object(let rounding)? = object["rounding"] else {
            return XCTFail("not an object")
        }
        XCTAssertEqual(rounding["round_down_below_bg"], .null)

        let data = try JSONEncoder().encode(settings.rounding)
        let jsonString = String(data: data, encoding: .utf8)!
        XCTAssertTrue(jsonString.contains("\"round_down_below_bg\":null"), jsonString)
    }
}
