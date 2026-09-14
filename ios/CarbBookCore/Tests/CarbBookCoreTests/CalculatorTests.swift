import XCTest
@testable import CarbBookCore

final class CalculatorTests: XCTestCase {
    let catalog = InMemoryCatalog(
        foods: [FoodData(id: "rice", name: "Rice", carbsPer100g: 28.2), FoodData(id: "mystery", name: "Mystery", carbsPer100g: nil)]
    )
    let utc: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "UTC")!
        return c
    }()
    // 2026-09-14 18:00 UTC
    let dinner = Date(timeIntervalSince1970: 1_789_408_800)

    func testSuggestsDoseWithBreakdown() {
        let lines = [CalculatorLine(id: "l1", refType: .food, refId: "rice", displayName: "Rice", amount: 255.3191489, unit: "g")]
        let result = evaluateCalculator(lines: lines, catalog: catalog, settingsVersions: [seedSettings], eatenAt: dinner,
                                        calendar: utc, windowOverride: nil, bg: .dexcom(mgdl: 263, trend: "Flat"),
                                        lastDoseAtMs: nil, nowMs: 1_789_408_800_000)
        XCTAssertEqual(result.estimate?.window?.name, "Dinner")
        XCTAssertEqual(result.breakdown, "72g ÷ 8 = 9.0 + BG 263 → 2u = 11.0 → 11u")
        XCTAssertNil(result.refusal)

        let (entry, items) = buildLogRecords(lines: lines, result: result, bg: .dexcom(mgdl: 263, trend: "Flat"),
                                             eatenAt: dinner, takenUnits: 10, notes: nil, newId: { "x" })
        XCTAssertEqual(entry.suggestedUnits, 11)
        XCTAssertEqual(entry.takenUnits, 10)
        XCTAssertEqual(entry.bgSource, "dexcom")
        XCTAssertEqual(entry.windowName, "Dinner")
        XCTAssertEqual(entry.settingsVersionId, "s1")
        XCTAssertEqual(entry.eatenAt, 1_789_408_800_000)
        XCTAssertEqual(items.first!.carbsG, 72, accuracy: 1e-6)
    }

    func testWindowOverrideAndRefusals() {
        let lines = [CalculatorLine(id: "l1", refType: .food, refId: "rice", displayName: "Rice", amount: 100, unit: "g")]
        let snack = evaluateCalculator(lines: lines, catalog: catalog, settingsVersions: [seedSettings], eatenAt: dinner,
                                       calendar: utc, windowOverride: "HS Snack", bg: .none, lastDoseAtMs: nil, nowMs: 0)
        XCTAssertEqual(snack.estimate?.window?.name, "HS Snack")

        let incomplete = evaluateCalculator(
            lines: lines + [CalculatorLine(id: "l2", refType: .food, refId: "mystery", displayName: "Mystery", amount: 10, unit: "g")],
            catalog: catalog, settingsVersions: [seedSettings], eatenAt: dinner, calendar: utc,
            windowOverride: nil, bg: .manual(mgdl: 120), lastDoseAtMs: 1_789_400_000_000, nowMs: 1_789_408_800_000)
        XCTAssertNil(incomplete.breakdown)
        XCTAssertEqual(incomplete.refusal, DoseRefusal.incompleteCarbs.message)
        XCTAssertTrue(incomplete.recentDoseWarning)

        let noSettings = evaluateCalculator(lines: lines, catalog: catalog, settingsVersions: [], eatenAt: dinner,
                                            calendar: utc, windowOverride: nil, bg: .none, lastDoseAtMs: nil, nowMs: 0)
        XCTAssertEqual(noSettings.refusal, noSettingsMessage)
    }

    func testBgFreshness() {
        let now: Int64 = 1_789_408_800_000
        XCTAssertTrue(isBgReadingUsable(readAtMs: now - 15 * 60_000, nowMs: now))
        XCTAssertFalse(isBgReadingUsable(readAtMs: now - 15 * 60_000 - 1, nowMs: now))
        XCTAssertTrue(isBgReadingUsable(readAtMs: now + 2 * 60_000, nowMs: now))
        XCTAssertFalse(isBgReadingUsable(readAtMs: now + 2 * 60_000 + 1, nowMs: now))
    }

    /// Item (d): a dose_settings version the server rejected must never be selected for a dose
    /// estimate, even when it is still present in the local `settingsVersions` list.
    func testRejectedSettingsVersionIsNeverSelected() {
        let lines = [CalculatorLine(id: "l1", refType: .food, refId: "rice", displayName: "Rice", amount: 100, unit: "g")]
        var newer = seedSettings
        newer.id = "s2"
        newer.effectiveFrom = 1_787_000_000_000 // newer than s1, still <= eatenMs

        let withOlderAccepted = evaluateCalculator(
            lines: lines, catalog: catalog, settingsVersions: [seedSettings, newer], eatenAt: dinner,
            calendar: utc, windowOverride: nil, bg: .none, lastDoseAtMs: nil, nowMs: 0,
            rejectedSettingsIds: ["s2"])
        XCTAssertEqual(withOlderAccepted.settings?.id, "s1")

        let (entry, _) = buildLogRecords(lines: lines, result: withOlderAccepted, bg: .none, eatenAt: dinner,
                                         takenUnits: nil, notes: nil, newId: { "x" })
        XCTAssertEqual(entry.settingsVersionId, "s1")

        let onlyRejected = evaluateCalculator(
            lines: lines, catalog: catalog, settingsVersions: [newer], eatenAt: dinner,
            calendar: utc, windowOverride: nil, bg: .none, lastDoseAtMs: nil, nowMs: 0,
            rejectedSettingsIds: ["s2"])
        XCTAssertNil(onlyRejected.settings)
        XCTAssertEqual(onlyRejected.refusal, noSettingsMessage)
    }

    func testBuildMealRecords() {
        let lines = [
            CalculatorLine(id: "a", refType: .food, refId: "rice", displayName: "Rice", amount: 1, unit: "cup"),
            CalculatorLine(id: "b", refType: .meal, refId: "m0", displayName: "Beans", amount: 0.5, unit: "serving"),
        ]
        var n = 0
        let (meal, items) = buildMealRecords(name: "Rice bowl", yieldServings: 2, totalWeightG: nil, lines: lines, newId: { n += 1; return "id\(n)" })
        XCTAssertEqual(meal, MealData(id: "id1", name: "Rice bowl", yieldServings: 2, totalWeightG: nil))
        XCTAssertEqual(items.map(\.position), [0, 1])
        XCTAssertEqual(items[1].refType, .meal)
    }
}
