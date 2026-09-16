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

    private let goal = CarbGoal(min: 50, max: 80)

    private func status(_ carbs: Double, complete: Bool = true, _ goal: CarbGoal?) -> GoalStatus {
        goalStatus(CarbResult(carbsG: carbs, complete: complete), goal)
    }

    func testInsideTheGoalIncludingBothEnds() {
        XCTAssertEqual(status(50, goal), .inGoal)
        XCTAssertEqual(status(65, goal), .inGoal)
        XCTAssertEqual(status(80, goal), .inGoal)
    }

    func testNearIsWithinFiveGramsOfEitherEnd() {
        XCTAssertEqual(status(45, goal), .near)
        XCTAssertEqual(status(85, goal), .near)
        XCTAssertEqual(status(44.9, goal), .off)
        XCTAssertEqual(status(85.1, goal), .off)
    }

    func testOffIsWithinTenGramsAndOutIsBeyond() {
        XCTAssertEqual(status(40, goal), .off)
        XCTAssertEqual(status(90, goal), .off)
        XCTAssertEqual(status(39.9, goal), .out)
        XCTAssertEqual(status(90.1, goal), .out)
    }

    func testNoGoalAndIncompleteCarbsHaveNoStatus() {
        XCTAssertEqual(status(65, nil), .none)
        XCTAssertEqual(status(65, complete: false, goal), .none)
        XCTAssertEqual(status(.nan, goal), .none)
    }

    func testDayGoalSumsOnlyWindowsThatHaveOne() {
        let windows = [
            DoseWindow(name: "Breakfast", start: "05:00", ratioGPerUnit: 8, carbGoal: CarbGoal(min: 30, max: 50)),
            DoseWindow(name: "AM Snack", start: "09:00", ratioGPerUnit: 10),
            DoseWindow(name: "Lunch", start: "11:00", ratioGPerUnit: 8, carbGoal: CarbGoal(min: 50, max: 80)),
        ]
        XCTAssertEqual(dayGoal(windows), CarbGoal(min: 80, max: 130))
    }

    func testDayGoalIsNilWhenNoWindowHasAGoal() {
        XCTAssertNil(dayGoal([DoseWindow(name: "Lunch", start: "11:00", ratioGPerUnit: 8)]))
        XCTAssertNil(dayGoal([]))
    }

    func testGoalTextShowsTheNumbersNotJustAColour() {
        XCTAssertEqual(goalText(CarbResult(carbsG: 68, complete: true), goal), "68 g · goal 50–80")
        XCTAssertEqual(goalText(CarbResult(carbsG: 68, complete: true), nil), "68 g")
        XCTAssertEqual(goalText(CarbResult(carbsG: 0, complete: false), goal), "missing data · goal 50–80")
    }

    func testEveryStatusHasAShortScreenReaderLabel() {
        XCTAssertEqual(GoalStatus.inGoal.label, "in goal")
        XCTAssertEqual(GoalStatus.near.label, "near goal")
        XCTAssertEqual(GoalStatus.off.label, "off goal")
        XCTAssertEqual(GoalStatus.out.label, "outside goal")
        XCTAssertEqual(GoalStatus.none.label, "no goal")
    }
}
