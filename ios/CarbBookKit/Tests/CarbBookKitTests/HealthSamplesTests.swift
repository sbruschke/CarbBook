import CarbBookCore
@testable import CarbBookKit
import XCTest

final class HealthSamplesTests: XCTestCase {
    private func entry(carbs: Double, taken: Double?, id: String = "e1", at: Int64 = 1_700_000_000_000) -> LogEntryData {
        LogEntryData(id: id, eatenAt: at, windowName: "Lunch", bgMgdl: nil, bgSource: "none", bgTrend: nil,
                     totalCarbsG: carbs, suggestedUnits: 6, takenUnits: taken, settingsVersionId: nil, notes: nil)
    }

    func testCarbsAndBolus() {
        let samples = healthSamples(for: entry(carbs: 48, taken: 6))
        XCTAssertEqual(samples, [
            HealthSample(kind: .carbohydrates, value: 48, at: 1_700_000_000_000, externalId: "e1"),
            HealthSample(kind: .insulinBolus, value: 6, at: 1_700_000_000_000, externalId: "e1"),
        ])
    }

    /// A blank taken dose writes carbs and no insulin: the estimate is never written, because Health
    /// must not record insulin that may not have been injected (spec §1).
    func testBlankTakenDoseWritesCarbsOnly() {
        XCTAssertEqual(healthSamples(for: entry(carbs: 30, taken: nil)).map(\.kind), [.carbohydrates])
    }

    /// A correction-only entry: insulin with no food.
    func testCorrectionOnlyWritesBolusOnly() {
        XCTAssertEqual(healthSamples(for: entry(carbs: 0, taken: 2)).map(\.kind), [.insulinBolus])
    }

    func testZeroesWriteNothing() {
        XCTAssertEqual(healthSamples(for: entry(carbs: 0, taken: 0)), [])
        XCTAssertEqual(healthSamples(for: entry(carbs: 0, taken: nil)), [])
    }

    /// Non-finite or negative numbers are data corruption, not a zero: they must never reach Health.
    func testNonFiniteAndNegativeValuesAreDropped() {
        XCTAssertEqual(healthSamples(for: entry(carbs: .nan, taken: 4)).map(\.kind), [.insulinBolus])
        XCTAssertEqual(healthSamples(for: entry(carbs: 20, taken: .infinity)).map(\.kind), [.carbohydrates])
        XCTAssertEqual(healthSamples(for: entry(carbs: -5, taken: -1)), [])
    }
}
