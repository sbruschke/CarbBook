import CarbBookCore
import XCTest
@testable import CarbBookKit

final class LogClipboardTests: XCTestCase {
    private let catalog = InMemoryCatalog(foods: [FoodData(id: "rice", name: "Calrose Rice", carbsPer100g: 28.2)])
    private var defaults: UserDefaults!

    override func setUp() {
        defaults = UserDefaults(suiteName: "LogClipboardTests")!
        defaults.removePersistentDomain(forName: "LogClipboardTests")
    }

    private let clip = LogClipboard(source: "Lunch · Tue 6 Oct", items: [
        ClipItem(refType: .food, refId: "rice", amount: 150, unit: "g", label: nil),
        ClipItem(refType: .quick, refId: "old-log-row", amount: 6, unit: Units.quick, label: "Salsa"),
    ])

    func testSavesLoadsAndClears() {
        XCTAssertNil(LogClipboard.load(from: defaults))
        LogClipboard.save(clip, to: defaults)
        XCTAssertEqual(LogClipboard.load(from: defaults), clip)
        LogClipboard.save(nil, to: defaults)
        XCTAssertNil(LogClipboard.load(from: defaults))
    }

    func testMalformedDataIsAnEmptyClipboard() {
        defaults.set(Data("{not json".utf8), forKey: LogClipboard.key)
        XCTAssertNil(LogClipboard.load(from: defaults))
        LogClipboard.save(LogClipboard(source: "x", items: []), to: defaults)
        XCTAssertNil(LogClipboard.load(from: defaults))
    }

    func testCalculatorLinesAreFreshAndRecomputable() {
        var n = 0
        let lines = clip.calculatorLines(catalog: catalog) { n += 1; return "line\(n)" }
        XCTAssertEqual(lines.map(\.id), ["line1", "line2"])
        XCTAssertEqual(lines[0].displayName, "Calrose Rice")
        XCTAssertEqual(lines[0].amount, 150)
        // A pasted quick row never points at the log row it came from.
        XCTAssertEqual(lines[1].refId, "")
        XCTAssertEqual(lines[1].label, "Salsa")
        XCTAssertEqual(itemCarbs(catalog, lines[0].refType, lines[0].refId, lines[0].amount, lines[0].unit).carbsG, 42.3, accuracy: 1e-9)
    }

    func testPlanItemsSaveAsNewRows() throws {
        var n = 0
        let draft = PlanEditing.Draft(date: "2026-10-08", windowName: "Lunch", note: nil, items: clip.planItems())
        let changes = try PlanEditing.saveChanges(draft: draft, existing: nil, existingItems: []) { n += 1; return "id\(n)" }
        XCTAssertEqual(changes.count, 3)
        let quick = try XCTUnwrap(changes.last).record
        XCTAssertEqual(quick["ref_id"], quick["id"])
        XCTAssertNotEqual(quick["ref_id"], .string("old-log-row"))
    }

    func testText() {
        let items = [
            LogItemData(id: "a", logEntryId: "e", refType: .food, refId: "rice", displayName: "Calrose Rice", amount: 1.5, unit: "g", carbsG: 0.4),
            LogItemData(id: "b", logEntryId: "e", refType: .quick, refId: "b", displayName: "Salsa", amount: 6, unit: Units.quick, carbsG: 6),
        ]
        XCTAssertEqual(LogClipboard.text(source: "Lunch · Tue 6 Oct", items: items, catalog: catalog),
                       "Lunch · Tue 6 Oct\n- Calrose Rice · 1.5 g · 0.4 g\n- Salsa · 6 g")
    }
}

final class LogReportHtmlTests: XCTestCase {
    private var calendar: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "America/Chicago")!
        return c
    }()

    private func date(_ y: Int, _ m: Int, _ d: Int, _ h: Int = 0) -> Date {
        calendar.date(from: DateComponents(year: y, month: m, day: d, hour: h))!
    }

    func testDaysAndRangeLabel() {
        let days = LogReportBuilder.days(from: date(2026, 9, 29, 15), to: date(2026, 10, 2), calendar: calendar)
        XCTAssertEqual(days.map { LogReportBuilder.dayKey($0, calendar: calendar) }, ["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"])
        XCTAssertTrue(LogReportBuilder.days(from: date(2026, 10, 2), to: date(2026, 10, 1), calendar: calendar).isEmpty)
        XCTAssertEqual(LogReportBuilder.rangeLabel(from: date(2026, 9, 30), to: date(2026, 10, 6), calendar: calendar), "Sep 30 – Oct 6, 2026")
        XCTAssertEqual(LogReportBuilder.rangeLabel(from: date(2025, 12, 30), to: date(2026, 1, 2), calendar: calendar), "Dec 30, 2025 – Jan 2, 2026")
        XCTAssertEqual(LogReportBuilder.rangeLabel(from: date(2026, 10, 6), to: date(2026, 10, 6, 9), calendar: calendar), "Oct 6, 2026")
    }

    func testReportFromLogRendersEntriesItemsGoalsAndEscapedNotes() {
        let catalog = InMemoryCatalog(foods: [FoodData(id: "rice", name: "Calrose Rice", carbsPer100g: 28.2)])
        let ms = { (d: Date) in Int64(d.timeIntervalSince1970 * 1000) }
        let lunch = LogEntryData(id: "l", eatenAt: ms(date(2026, 10, 6, 12)), windowName: "Lunch", bgMgdl: 140, bgSource: "manual",
                                 bgTrend: nil, totalCarbsG: 54, suggestedUnits: 7, takenUnits: 6, settingsVersionId: nil, notes: "tacos <3")
        let outside = LogEntryData(id: "x", eatenAt: ms(date(2026, 10, 9, 12)), windowName: "Lunch", bgMgdl: 300, bgSource: "manual",
                                   bgTrend: nil, totalCarbsG: 99, suggestedUnits: 9, takenUnits: 9, settingsVersionId: nil, notes: nil)
        let items = ["l": [
            LogItemData(id: "a", logEntryId: "l", refType: .food, refId: "rice", displayName: "Calrose Rice", amount: 170, unit: "g", carbsG: 48),
            LogItemData(id: "b", logEntryId: "l", refType: .quick, refId: "b", displayName: "Salsa", amount: 6, unit: Units.quick, carbsG: 6),
        ]]
        let report = LogReportBuilder.report(
            from: date(2026, 10, 5), to: date(2026, 10, 6), entries: [lunch, outside], itemsByEntry: items, catalog: catalog,
            goal: { _ in CarbGoal(min: 50, max: 80) }, time: { _ in "12:00 PM" }, calendar: calendar)
        XCTAssertEqual(report.days.map { $0.entries.map(\.input.id) }, [[], ["l"]])
        XCTAssertEqual(report.days[1].entries[0].goalStatus, .inGoal)
        let html = LogReportHtml.html(report, labels: ReportLabels(range: "Oct 5 – Oct 6, 2026", generated: "now", day: { "Day \($0)" }))
        XCTAssertTrue(html.contains("Calrose Rice 170 g — 48 g"))
        XCTAssertTrue(html.contains("Salsa — 6 g"))
        XCTAssertTrue(html.contains("tacos &lt;3"))
        XCTAssertFalse(html.contains("tacos <3"))
        XCTAssertTrue(html.contains("Nothing logged"))
        XCTAssertTrue(html.contains("goal goal-in"))
        XCTAssertTrue(html.contains("<strong>6 u</strong>"))
        XCTAssertTrue(html.contains("Carb goals: 1 of 1 on target"))
    }
}
