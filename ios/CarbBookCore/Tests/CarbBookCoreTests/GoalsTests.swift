import Foundation
import XCTest
@testable import CarbBookCore

final class GoalsTests: XCTestCase {
    private func encoded(_ window: DoseWindow) throws -> [String: JSONValue] {
        guard case .object(let fields) = try JSONValue.from(window) else { return [:] }
        return fields
    }

    func testWindowDecodesACarbGoal() throws {
        let json = #"{"name":"Lunch","start":"11:00","ratio_g_per_unit":8,"carb_goal":{"min":50,"max":80}}"#
        let window = try JSONDecoder().decode(DoseWindow.self, from: Data(json.utf8))
        XCTAssertEqual(window.carbGoal, CarbGoal(min: 50, max: 80))
    }

    func testWindowWithoutACarbGoalKeyDecodesAsNoGoal() throws {
        let json = #"{"name":"Lunch","start":"11:00","ratio_g_per_unit":8}"#
        let window = try JSONDecoder().decode(DoseWindow.self, from: Data(json.utf8))
        XCTAssertNil(window.carbGoal)
    }

    func testNoGoalEncodesAsAnExplicitNull() throws {
        let window = DoseWindow(name: "Lunch", start: "11:00", ratioGPerUnit: 8)
        XCTAssertEqual(try encoded(window)["carb_goal"], .null)
    }

    func testGoalEncodesAsMinAndMax() throws {
        let window = DoseWindow(name: "Lunch", start: "11:00", ratioGPerUnit: 8, carbGoal: CarbGoal(min: 50, max: 80))
        XCTAssertEqual(try encoded(window)["carb_goal"], .object(["min": .number(50), "max": .number(80)]))
    }
}
