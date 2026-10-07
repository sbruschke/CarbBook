import CarbBookCore
@testable import CarbBookKit
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest

final class BgHistoryKitTests: XCTestCase {
    private let minute: Int64 = 60_000
    private let base = URL(string: "https://recipes.dxshdw.dev")!

    func testReadingsAskInChunksOfNinetyDays() async throws {
        let stub = StubTransport { _ in (200, json(#"{"readings":[{"at":5,"mgdl":120}],"earliest_at":1}"#)) }
        let day: Int64 = 86_400_000
        let history = try await APIClient(baseURL: base, transport: stub, token: { "t" }).bgReadings(fromMs: 0, toMs: 100 * day)
        XCTAssertEqual(history.readings.count, 2)
        XCTAssertEqual(history.earliestAt, 1)
        let queries = stub.requests.map { $0.url!.query ?? "" }
        XCTAssertEqual(queries, ["from=0&to=\(90 * day)", "from=\(90 * day)&to=\(100 * day)"])
        XCTAssertTrue(stub.requests.allSatisfy { $0.url!.path == "/api/bg/readings" })
    }

    func testDayChartBreaksAcrossGapsAndDotsOutliers() {
        let svg = BgChartSvg.day(start: 0, end: 3 * 3_600_000, points: [
            BgPoint(at: 0, mgdl: 100), BgPoint(at: 5 * minute, mgdl: 110), BgPoint(at: 60 * minute, mgdl: 300),
            BgPoint(at: 120 * minute, mgdl: 120), BgPoint(at: 125 * minute, mgdl: 50),
        ], meals: [BgChartSvg.Meal(at: 1, label: "<b>")], hourLabel: { _ in "h" })
        XCTAssertEqual(svg.components(separatedBy: "<polyline").count - 1, 2)
        XCTAssertEqual(svg.components(separatedBy: "<circle").count - 1, 2)
        XCTAssertTrue(svg.contains("&lt;b&gt;"))
        XCTAssertTrue(BgChartSvg.pattern([], hourLabel: { _ in "" }).contains("Not enough readings yet"))
    }

    func testTextMatchesTheWeb() {
        XCTAssertNil(BgText.mealResponse(MealResponse(before: nil, twoHour: nil, peak: nil, peakMinutes: nil, rise: nil)))
        XCTAssertEqual(BgText.mealResponse(MealResponse(before: nil, twoHour: 150, peak: 180, peakMinutes: 40, rise: nil)),
                       "peak 180 (+40 min) · 2 h after 150")
        XCTAssertEqual(BgText.mealResponse(MealResponse(before: 163, twoHour: 116, peak: 163, peakMinutes: 5, rise: 0)),
                       "BG 163 → no rise · 2 h after 116")
        XCTAssertEqual(BgText.mealResponse(MealResponse(before: 110, twoHour: 220, peak: 220, peakMinutes: 10, rise: 110)),
                       "BG 110 → peak 220 (+10 min) · 2 h after 220")
        let stats = BgStats(count: 10, coverage: 1, mean: 150.4, sd: 0, cv: 0, gmi: 0, min: 0, max: 0,
                            bands: [.veryLow: 0.1, .low: 0, .inRange: 0.7, .high: 0.1, .veryHigh: 0.1])
        XCTAssertEqual(BgText.statsLine(stats), "In range 70% · avg 150 · low 10% · high 20% · 10 readings")
    }

    func testReportGetsCgmSectionsOrANote() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/Chicago")!
        let day = calendar.date(from: DateComponents(year: 2026, month: 9, day: 14))!
        let dayStart = Int64(day.timeIntervalSince1970 * 1000)
        let eaten = dayStart + 11 * 60 * minute
        let points = (0..<288).map { i -> BgPoint in
            let at = dayStart + Int64(i) * 5 * minute
            let since = (at - eaten) / minute
            return BgPoint(at: at, mgdl: since > 5 && since <= 125 ? 220 : 110)
        }
        let report = buildLogReport(days: ["2026-09-14"], entries: [ReportEntryInput(
            id: "lunch", day: "2026-09-14", eatenAt: eaten, time: "11:00", windowName: "Lunch", bgMgdl: 110, carbsG: 60,
            suggestedUnits: 7, takenUnits: 7, notes: nil, goal: nil, items: [])])
        let labels = ReportLabels(range: "r", generated: "g", day: { $0 })
        let cgm = LogReportBuilder.reportBg(history: BgHistory(readings: points, earliestAt: dayStart), failure: nil, report: report,
                                            from: day, to: day, hourLabelAt: { _ in "h" }, hourLabel: { _ in "h" },
                                            earliestLabel: { _ in "e" }, calendar: calendar)
        let html = LogReportHtml.html(report, labels: labels, cgm: cgm)
        XCTAssertTrue(html.contains("Blood sugar (CGM)"))
        XCTAssertTrue(html.contains("<div class=\"daybg\"><svg"))
        XCTAssertTrue(html.contains("After: BG 110 → peak 220 (+10 min) · 2 h after 220"))
        XCTAssertTrue(html.contains("BG at meals"))

        let offline = LogReportBuilder.reportBg(history: nil, failure: "BG history needs a connection.", report: report, from: day, to: day,
                                                hourLabelAt: { _ in "" }, hourLabel: { _ in "" }, earliestLabel: { _ in "" }, calendar: calendar)
        let plain = LogReportHtml.html(report, labels: labels, cgm: offline)
        XCTAssertTrue(plain.contains("No CGM section: BG history needs a connection."))
        XCTAssertFalse(plain.contains("class=\"daybg\""))
    }
}
