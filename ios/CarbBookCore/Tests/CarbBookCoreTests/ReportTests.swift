import XCTest
@testable import CarbBookCore

/// Runs `testdata/log-report-vectors.json` — the same cases as the TS core's report.test.ts.
final class ReportTests: XCTestCase {
    struct Vectors: Decodable {
        struct Input: Decodable { let days: [String]; let entries: [ReportEntryInput] }
        struct Day: Decodable {
            let day: String; let entry_ids: [String]; let carbs_g: Double; let taken_units: Double; let goal_statuses: [GoalStatus]
        }
        struct Summary: Decodable {
            let days: Int; let logged_days: Int; let entries: Int; let carbs_g: Double; let avg_carbs_per_logged_day: Double?
            let taken_units: Double; let avg_taken_per_logged_day: Double?; let bg_readings: Int
            let avg_bg: Double?; let min_bg: Double?; let max_bg: Double?; let goal_counts: [String: Int]
        }
        struct Expect: Decodable { let days: [Day]; let summary: Summary }
        struct ReportCase: Decodable { let name: String; let input: Input; let expect: Expect }
        struct ClipLogItem: Decodable { let ref_type: RefType; let ref_id: String; let amount: Double; let unit: String; let display_name: String }
        struct ClipCase: Decodable { let name: String; let items: [ClipLogItem]; let expect: [ClipItem] }
        let tolerance: Double
        let report_cases: [ReportCase]
        let clip_cases: [ClipCase]
    }

    private func vectors() throws -> Vectors {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "log-report-vectors", withExtension: "json", subdirectory: "Resources"))
        return try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url))
    }

    private func close(_ actual: Double?, _ expected: Double?, _ tolerance: Double, _ label: String) {
        guard let expected else { return XCTAssertNil(actual, label) }
        XCTAssertEqual(actual ?? .nan, expected, accuracy: tolerance, label)
    }

    func testReportVectors() throws {
        let v = try vectors()
        XCTAssertFalse(v.report_cases.isEmpty)
        for c in v.report_cases {
            let report = buildLogReport(days: c.input.days, entries: c.input.entries)
            XCTAssertEqual(report.days.map(\.day), c.expect.days.map(\.day), c.name)
            for (day, want) in zip(report.days, c.expect.days) {
                XCTAssertEqual(day.entries.map(\.input.id), want.entry_ids, "\(c.name) \(day.day)")
                XCTAssertEqual(day.entries.map(\.goalStatus), want.goal_statuses, "\(c.name) \(day.day)")
                close(day.carbsG, want.carbs_g, v.tolerance, "\(c.name) \(day.day) carbs")
                close(day.takenUnits, want.taken_units, v.tolerance, "\(c.name) \(day.day) taken")
            }
            let s = report.summary, w = c.expect.summary
            XCTAssertEqual([s.days, s.loggedDays, s.entries, s.bgReadings], [w.days, w.logged_days, w.entries, w.bg_readings], c.name)
            close(s.carbsG, w.carbs_g, v.tolerance, "\(c.name) carbs")
            close(s.avgCarbsPerLoggedDay, w.avg_carbs_per_logged_day, v.tolerance, "\(c.name) avg carbs")
            close(s.takenUnits, w.taken_units, v.tolerance, "\(c.name) taken")
            close(s.avgTakenPerLoggedDay, w.avg_taken_per_logged_day, v.tolerance, "\(c.name) avg taken")
            close(s.avgBg, w.avg_bg, v.tolerance, "\(c.name) avg bg")
            close(s.minBg, w.min_bg, v.tolerance, "\(c.name) min bg")
            close(s.maxBg, w.max_bg, v.tolerance, "\(c.name) max bg")
            XCTAssertEqual(Dictionary(uniqueKeysWithValues: s.goalCounts.map { ($0.key.rawValue, $0.value) }), w.goal_counts, c.name)
        }
    }

    func testClipVectors() throws {
        let v = try vectors()
        XCTAssertFalse(v.clip_cases.isEmpty)
        for c in v.clip_cases {
            let items = c.items.enumerated().map { index, item in
                LogItemData(id: "row\(index)", logEntryId: "entry", refType: item.ref_type, refId: item.ref_id,
                            displayName: item.display_name, amount: item.amount, unit: item.unit, carbsG: 0)
            }
            XCTAssertEqual(clipItemsFromLog(items), c.expect, c.name)
        }
    }

    func testNonFiniteFiguresCountAsNothing() {
        let entry = { (id: String, bg: Double?, carbs: Double, taken: Double?) in
            ReportEntryInput(id: id, day: "d", eatenAt: 0, time: "", windowName: nil, bgMgdl: bg, carbsG: carbs,
                             suggestedUnits: nil, takenUnits: taken, notes: nil, goal: nil, items: [])
        }
        let report = buildLogReport(days: ["d"], entries: [entry("x", .nan, .nan, .infinity), entry("y", 100, 10, 1)])
        XCTAssertEqual(report.days[0].carbsG, 10)
        XCTAssertEqual(report.days[0].takenUnits, 1)
        XCTAssertEqual(report.summary.avgBg, 100)
        // Equal times keep their input order, as the TS sort does.
        XCTAssertEqual(report.days[0].entries.map(\.input.id), ["x", "y"])
    }
}
