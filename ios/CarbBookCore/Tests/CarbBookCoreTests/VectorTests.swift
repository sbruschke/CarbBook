import XCTest
@testable import CarbBookCore

/// Runs the shared vectors in testdata/ (copied into Resources/ by scripts/sync-testdata.sh).
final class VectorTests: XCTestCase {
    struct UnitsVectors: Decodable {
        struct GramsCase: Decodable { let name: String; let food_id: String; let amount: Double; let unit: String; let expect: Double? }
        struct CarbExpect: Decodable { let carbs_g: Double; let complete: Bool }
        struct CarbCase: Decodable { let name: String; let ref_type: RefType; let ref_id: String; let amount: Double; let unit: String; let expect: CarbExpect }
        struct UnitListCase: Decodable { let ref_type: RefType; let ref_id: String; let expect: [String] }
        struct CycleCase: Decodable { let meal_id: String; let candidate: String; let expect: Bool }
        let tolerance: Double
        let foods: [FoodData]
        let portions: [PortionData]
        let meals: [MealData]
        let meal_items: [MealItemData]
        let grams_cases: [GramsCase]
        let carb_cases: [CarbCase]
        let unit_list_cases: [UnitListCase]
        let cycle_cases: [CycleCase]
    }

    struct DoseVectors: Decodable {
        struct Expect: Decodable {
            let ok: Bool
            let window: String?
            let reason: String?
            let meal_units: Double?
            let correction_units: Double?
            let raw_units: Double?
            let units: Double?
            let rounded_down: Bool?
            let breakdown: String?
        }
        struct Case: Decodable {
            let name: String
            let time: String
            let carbs: Double
            let complete: Bool?
            let bg: Double?
            let correction: CorrectionRule?
            let rounding: RoundingRule?
            let expect: Expect
        }
        let tolerance: Double
        let settings: DoseSettingsData
        let cases: [Case]
    }

    struct GoalVectors: Decodable {
        struct StatusCase: Decodable {
            let name: String
            let carbs: Double
            let complete: Bool?
            let goal: CarbGoal?
            let expect: GoalStatus
        }
        struct DayCase: Decodable {
            let name: String
            let windows: [DoseWindow]
            let expect: CarbGoal?
        }
        struct DayStatusCase: Decodable {
            let name: String
            let carbs: Double
            let complete: Bool?
            let day_goal: CarbGoal?
            let expect: GoalStatus
        }
        struct ValidCase: Decodable {
            let name: String
            let goal: CarbGoal?
            let expect: Bool
        }
        let tolerance: Double
        let status_cases: [StatusCase]
        let day_cases: [DayCase]
        let day_status_cases: [DayStatusCase]
        let valid_cases: [ValidCase]
    }

    private func load<T: Decodable>(_ name: String, as type: T.Type) throws -> T {
        let url = try XCTUnwrap(Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Resources"))
        return try JSONDecoder().decode(T.self, from: Data(contentsOf: url))
    }

    func testUnitsVectors() throws {
        let u = try load("units-vectors", as: UnitsVectors.self)
        XCTAssertFalse(u.grams_cases.isEmpty)
        XCTAssertFalse(u.carb_cases.isEmpty)
        XCTAssertFalse(u.unit_list_cases.isEmpty)
        XCTAssertFalse(u.cycle_cases.isEmpty)
        let catalog = InMemoryCatalog(foods: u.foods, portions: u.portions, meals: u.meals, mealItems: u.meal_items)
        for c in u.grams_cases {
            let food = try XCTUnwrap(catalog.food(c.food_id), c.name)
            let grams = foodAmountToGrams(c.amount, c.unit, food, catalog.portions(c.food_id))
            if let expected = c.expect {
                XCTAssertEqual(try XCTUnwrap(grams, c.name), expected, accuracy: u.tolerance, "grams: \(c.name)")
            } else {
                XCTAssertNil(grams, "grams: \(c.name)")
            }
        }
        for c in u.carb_cases {
            let r = itemCarbs(catalog, c.ref_type, c.ref_id, c.amount, c.unit)
            XCTAssertEqual(r.complete, c.expect.complete, "carbs: \(c.name)")
            XCTAssertEqual(r.carbsG, c.expect.carbs_g, accuracy: u.tolerance, "carbs: \(c.name)")
        }
        for c in u.unit_list_cases {
            let units = c.ref_type == .food
                ? foodUnits(try XCTUnwrap(catalog.food(c.ref_id)), catalog.portions(c.ref_id))
                : mealUnits(try XCTUnwrap(catalog.meal(c.ref_id)))
            XCTAssertEqual(units, c.expect, "unit list: \(c.ref_id)")
        }
        for c in u.cycle_cases {
            XCTAssertEqual(wouldCreateCycle(catalog, c.meal_id, c.candidate), c.expect, "cycle: \(c.candidate) into \(c.meal_id)")
        }
    }

    func testDoseVectors() throws {
        let d = try load("dose-vectors", as: DoseVectors.self)
        XCTAssertFalse(d.cases.isEmpty)
        for c in d.cases {
            var settings = d.settings
            if let correction = c.correction { settings.correction = correction }
            if let rounding = c.rounding { settings.rounding = rounding }
            let r = estimateDose(DoseInput(
                settings: settings, minutes: try parseHHMM(c.time),
                carbs: CarbResult(carbsG: c.carbs, complete: c.complete ?? true), bg: c.bg
            ))
            let e = c.expect
            XCTAssertEqual(r.window?.name, e.window, "window: \(c.name)")
            switch r {
            case .refused(let reason, _):
                XCTAssertFalse(e.ok, "unexpected refusal \(reason.rawValue): \(c.name)")
                XCTAssertEqual(reason.rawValue, e.reason, c.name)
            case .ok(let s):
                XCTAssertTrue(e.ok, "unexpected dose: \(c.name)")
                XCTAssertEqual(s.mealUnits, try XCTUnwrap(e.meal_units), accuracy: d.tolerance, "meal_units: \(c.name)")
                XCTAssertEqual(s.correctionUnits, try XCTUnwrap(e.correction_units), accuracy: d.tolerance, "correction_units: \(c.name)")
                XCTAssertEqual(s.rawUnits, try XCTUnwrap(e.raw_units), accuracy: d.tolerance, "raw_units: \(c.name)")
                XCTAssertEqual(s.units, try XCTUnwrap(e.units), accuracy: d.tolerance, "units: \(c.name)")
                XCTAssertEqual(s.roundedDown, e.rounded_down, "rounded_down: \(c.name)")
                if let breakdown = e.breakdown { XCTAssertEqual(formatBreakdown(s), breakdown, c.name) }
            }
        }
    }

    func testGoalVectors() throws {
        let g = try load("goal-vectors", as: GoalVectors.self)
        XCTAssertFalse(g.status_cases.isEmpty)
        XCTAssertFalse(g.day_cases.isEmpty)
        XCTAssertFalse(g.day_status_cases.isEmpty)
        XCTAssertFalse(g.valid_cases.isEmpty)
        for c in g.status_cases {
            let result = goalStatus(CarbResult(carbsG: c.carbs, complete: c.complete ?? true), c.goal)
            XCTAssertEqual(result, c.expect, "goal status: \(c.name)")
        }
        for c in g.day_cases {
            let result = dayGoal(c.windows)
            guard let expected = c.expect else {
                XCTAssertNil(result, "day goal: \(c.name)")
                continue
            }
            let actual = try XCTUnwrap(result, "day goal: \(c.name)")
            XCTAssertEqual(actual.min, expected.min, accuracy: g.tolerance, "day goal min: \(c.name)")
            XCTAssertEqual(actual.max, expected.max, accuracy: g.tolerance, "day goal max: \(c.name)")
        }
        for c in g.day_status_cases {
            let result = goalStatus(CarbResult(carbsG: c.carbs, complete: c.complete ?? true), c.day_goal)
            XCTAssertEqual(result, c.expect, "day status: \(c.name)")
        }
        for c in g.valid_cases {
            XCTAssertEqual(c.goal?.isValid ?? false, c.expect, "goal validity: \(c.name)")
        }
    }
}
