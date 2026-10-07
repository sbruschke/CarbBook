import CarbBookCore
import Foundation

/// The printable log report as one HTML document (log export spec 2026-10-07). iOS turns it into
/// the PDF with a print renderer. Port of the web's `web/src/log/reportHtml.ts` — keep the two in
/// step: same layout, same words, same CSS.
public struct ReportLabels: Sendable {
    /// "Sep 30 – Oct 6, 2026"
    public var range: String
    /// "Oct 7, 2026 at 12:24 PM"
    public var generated: String
    /// Heading for a day key: "Tuesday, October 6".
    public var day: @Sendable (String) -> String

    public init(range: String, generated: String, day: @escaping @Sendable (String) -> String) {
        self.range = range; self.generated = generated; self.day = day
    }
}

/// CGM history pieces, already rendered (charts are `BgChartSvg`). Without history the report has
/// no CGM sections, only `note` saying why. Mirror of the web's `ReportBg`.
public struct ReportBg: Sendable {
    public var summaryHtml: String?
    /// Per day key: chart + stats line, shown above that day's table.
    public var dayHtml: [String: String]
    /// Per entry id: "BG 112 → peak 210 (+55 min) · 2 h after 180".
    public var mealText: [String: String]
    public var note: String?

    public init(summaryHtml: String?, dayHtml: [String: String], mealText: [String: String], note: String?) {
        self.summaryHtml = summaryHtml; self.dayHtml = dayHtml; self.mealText = mealText; self.note = note
    }
}

public enum LogReportHtml {
    /// Same words the web shows beside a goal (`GOAL_WORDS` in web `plan/goal.ts`).
    public static func goalWord(_ status: GoalStatus) -> String {
        switch status {
        case .none: ""
        case .inGoal: "on target"
        case .near: "just outside"
        case .off: "outside"
        case .out: "far outside"
        }
    }

    static func esc(_ text: String) -> String {
        text.replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "'", with: "&#39;")
    }

    static func trim(_ n: Double, _ digits: Int) -> String {
        JS.numberString(Double(JS.toFixed(n, digits)) ?? n)
    }

    static func grams(_ n: Double) -> String { "\(n.isFinite ? trim(n, 1) : "–") g" }
    static func units(_ n: Double?) -> String {
        guard let n, n.isFinite else { return "–" }
        return "\(trim(n, 2)) u"
    }
    static func bg(_ n: Double?) -> String {
        guard let n, n.isFinite else { return "–" }
        return trim(n, 0)
    }

    public static let css = """
    @page { size: letter; margin: 0.6in 0.55in; }
    * { box-sizing: border-box; }
    body { margin: 0; color: #1c2419; background: #fff; font: 10.5pt/1.35 -apple-system, 'Helvetica Neue', 'Segoe UI', Roboto, Arial, sans-serif;
      -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    header { border-bottom: 2px solid #1b5e20; padding-bottom: 8px; margin-bottom: 14px; }
    h1 { font-size: 18pt; margin: 0; color: #1b5e20; }
    .sub { color: #5d6b59; margin-top: 2px; }
    .summary { display: table; width: 100%; border-collapse: separate; border-spacing: 6px 0; margin: 0 -6px 16px; }
    .tile { display: table-cell; width: 25%; border: 1px solid #d7ddd3; border-radius: 8px; padding: 8px 10px; vertical-align: top; }
    .tile .k { font-size: 8.5pt; text-transform: uppercase; letter-spacing: 0.04em; color: #5d6b59; }
    .tile .v { font-size: 15pt; font-weight: 700; }
    .tile .d { font-size: 8.5pt; color: #5d6b59; }
    section.day { margin-bottom: 14px; }
    .day h2 { font-size: 12pt; margin: 0 0 4px; padding: 5px 8px; background: #e8f5e9; border-radius: 6px; page-break-after: avoid; break-after: avoid; }
    .day h2 .tot { float: right; font-weight: 400; color: #1c2419; }
    .empty { color: #5d6b59; font-style: italic; padding: 2px 8px; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    col.c-time { width: 12%; } col.c-meal { width: 19%; } col.c-bg { width: 8%; } col.c-carbs { width: 31%; } col.c-sug { width: 15%; } col.c-taken { width: 15%; }
    th { text-align: left; font-size: 8.5pt; text-transform: uppercase; letter-spacing: 0.04em; color: #5d6b59; font-weight: 600; padding: 3px 8px; border-bottom: 1px solid #d7ddd3; }
    td { padding: 5px 8px 1px; vertical-align: top; }
    td.n, th.n { text-align: right; white-space: nowrap; }
    tbody { page-break-inside: avoid; break-inside: avoid; border-bottom: 1px solid #eceee9; }
    tr.items td, tr.note td { padding-top: 0; padding-bottom: 5px; font-size: 9pt; color: #3d4a39; }
    tr.note td { font-style: italic; }
    .time { white-space: nowrap; font-weight: 600; }
    .goal { display: inline-block; padding: 0 6px; border-radius: 4px; white-space: nowrap; }
    .goal .w { font-size: 8pt; }
    .goal-in { color: #0f6b3a; background: #e6f4ec; }
    .goal-near { color: #6b5200; background: #fbf3d5; }
    .goal-off { color: #8a3f00; background: #fbe9dc; }
    .goal-out { color: #8a1418; background: #fbe3e4; }
    .it { white-space: nowrap; }
    .it:not(:last-child)::after { content: ' ·'; color: #9aa596; }
    .cgm { border: 1px solid #d7ddd3; border-radius: 8px; padding: 8px 10px 6px; margin: 0 0 16px; page-break-inside: avoid; break-inside: avoid; }
    .cgm h3 { font-size: 10pt; margin: 0 0 6px; }
    .cgm .line { margin: 6px 0 2px; }
    .daybg { margin: 2px 0 4px; page-break-inside: avoid; break-inside: avoid; }
    .daybg svg { display: block; width: 100%; height: auto; }
    .daybg .line, .cgm .line { font-size: 8.5pt; color: #3d4a39; }
    tr.bgrow td { padding-top: 0; padding-bottom: 5px; font-size: 8.5pt; color: #1b5e20; }
    .tir-bar { display: flex; height: 12px; border-radius: 4px; overflow: hidden; background: #eceee9; }
    .tir-bar span { display: block; min-width: 2px; }
    .tir-legend { margin-top: 4px; font-size: 8.5pt; color: #3d4a39; }
    .tir-key { margin-right: 12px; white-space: nowrap; }
    .tir-key i { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 4px; }
    footer { margin-top: 18px; font-size: 8.5pt; color: #5d6b59; border-top: 1px solid #d7ddd3; padding-top: 6px; }
    """

    static func goalCell(_ entry: ReportEntry) -> String {
        let e = entry.input
        let range = e.goal.map { " <span class=\"w\">/ \(trim($0.min, 1))–\(trim($0.max, 1))</span>" } ?? ""
        let word = goalWord(entry.goalStatus)
        let wordHtml = word.isEmpty ? "" : " <span class=\"w\">\(esc(word))</span>"
        return "<span class=\"goal goal-\(entry.goalStatus.rawValue)\">\(grams(e.carbsG))\(range)\(wordHtml)</span>"
    }

    static func entryRows(_ entry: ReportEntry, bgText: String?) -> String {
        let e = entry.input
        let items = e.items.map { item in
            "<span class=\"it\">\(esc(item.name))\(item.amount.isEmpty ? "" : " \(esc(item.amount))") — \(grams(item.carbsG))</span>"
        }.joined(separator: " ") // a real space: the only place a long list of items can wrap
        return [
            "<tbody>",
            "<tr><td class=\"time\">\(esc(e.time))</td><td>\(esc(e.windowName ?? "—"))</td><td class=\"n\">\(bg(e.bgMgdl))</td>",
            "<td class=\"n\">\(goalCell(entry))</td><td class=\"n\">\(units(e.suggestedUnits))</td><td class=\"n\"><strong>\(units(e.takenUnits))</strong></td></tr>",
            items.isEmpty ? "" : "<tr class=\"items\"><td></td><td colspan=\"5\">\(items)</td></tr>",
            bgText.map { "<tr class=\"bgrow\"><td></td><td colspan=\"5\">After: \(esc($0))</td></tr>" } ?? "",
            (e.notes?.isEmpty ?? true) ? "" : "<tr class=\"note\"><td></td><td colspan=\"5\">Note: \(esc(e.notes!))</td></tr>",
            "</tbody>",
        ].joined()
    }

    static func tile(_ key: String, _ value: String, _ detail: String) -> String {
        "<div class=\"tile\"><div class=\"k\">\(esc(key))</div><div class=\"v\">\(esc(value))</div><div class=\"d\">\(esc(detail))</div></div>"
    }

    public static func html(_ report: LogReport, labels: ReportLabels, cgm: ReportBg? = nil) -> String {
        let s = report.summary
        let count = { (status: GoalStatus) in s.goalCounts[status] ?? 0 }
        let withGoal = s.entries - count(.none)
        let offGoal = [GoalStatus.near, .off, .out].filter { count($0) > 0 }.map { "\(count($0)) \(goalWord($0))" }.joined(separator: " · ")
        let tiles = [
            tile("Entries", String(s.entries), "\(s.loggedDays) of \(s.days) \(s.days == 1 ? "day" : "days") logged"),
            tile("Carbs", grams(s.carbsG), s.avgCarbsPerLoggedDay.map { "avg \(grams($0)) / logged day" } ?? "no days logged"),
            tile("Insulin taken", units(s.takenUnits), s.avgTakenPerLoggedDay.map { "avg \(units($0)) / logged day" } ?? "no days logged"),
            tile("BG at meals", s.avgBg.map { "avg \(bg($0))" } ?? "–",
                 s.avgBg == nil ? "no readings"
                     : "range \(bg(s.minBg))–\(bg(s.maxBg)) · \(s.bgReadings) \(s.bgReadings == 1 ? "reading" : "readings")"),
        ].joined()
        let goalLine = withGoal > 0
            ? "<p class=\"sub\">Carb goals: \(count(.inGoal)) of \(withGoal) on target\(offGoal.isEmpty ? "" : " · \(esc(offGoal))")</p>"
            : ""
        let cgmHtml = cgm?.summaryHtml.map { "<section class=\"cgm\">\($0)</section>" }
            ?? cgm?.note.map { "<p class=\"sub\">\(esc($0))</p>" } ?? ""
        let days = report.days.map { day -> String in
            let totals = day.entries.isEmpty ? ""
                : "<span class=\"tot\">\(grams(day.carbsG)) carbs · \(units(day.takenUnits)) taken</span>"
            let heading = "<h2>\(esc(labels.day(day.day)))\(totals)</h2>"
            let chart = cgm?.dayHtml[day.day].map { "<div class=\"daybg\">\($0)</div>" } ?? ""
            if day.entries.isEmpty { return "<section class=\"day\">\(heading)\(chart)<div class=\"empty\">Nothing logged</div></section>" }
            return "<section class=\"day\">\(heading)\(chart)<table><colgroup><col class=\"c-time\"><col class=\"c-meal\"><col class=\"c-bg\"><col class=\"c-carbs\"><col class=\"c-sug\"><col class=\"c-taken\"></colgroup><thead><tr><th>Time</th><th>Meal</th><th class=\"n\">BG</th>"
                + "<th class=\"n\">Carbs / goal</th><th class=\"n\">Suggested</th><th class=\"n\">Taken</th></tr></thead>"
                + day.entries.map { entryRows($0, bgText: cgm?.mealText[$0.input.id]) }.joined() + "</table></section>"
        }.joined()
        return "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>CarbBook log \(esc(labels.range))</title>"
            + "<style>\(css)</style></head><body><header><h1>CarbBook log</h1><div class=\"sub\">\(esc(labels.range))</div></header>"
            + "<div class=\"summary\">\(tiles)</div>\(goalLine)\(cgmHtml)\(days)<footer>Generated \(esc(labels.generated)) by CarbBook. "
            + "Suggested doses are what the app estimated at the time; Taken is what was recorded.</footer></body></html>"
    }
}

/// Builds the report input from the device's own log: entries in `[from, to]` by local day, each
/// with its window goal, logged items and formatted time.
public enum LogReportBuilder {
    /// Every day key from `from` to `to`, inclusive (capped at 400 days); empty when backwards.
    public static func days(from: Date, to: Date, calendar: Calendar = .current) -> [Date] {
        var result: [Date] = []
        var day = calendar.startOfDay(for: from)
        let last = calendar.startOfDay(for: to)
        while day <= last && result.count < 400 {
            result.append(day)
            guard let next = calendar.date(byAdding: .day, value: 1, to: day) else { break }
            day = next
        }
        return result
    }

    public static func dayKey(_ date: Date, calendar: Calendar = .current) -> String {
        let c = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    private static let months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

    /// "Sep 30 – Oct 6, 2026", "Oct 6, 2026", or both years when the range crosses one — same as the web.
    public static func rangeLabel(from: Date, to: Date, calendar: Calendar = .current) -> String {
        let f = calendar.dateComponents([.year, .month, .day], from: from)
        let t = calendar.dateComponents([.year, .month, .day], from: to)
        let fm = months[(f.month ?? 1) - 1], tm = months[(t.month ?? 1) - 1]
        let fd = f.day ?? 0, td = t.day ?? 0, fy = f.year ?? 0, ty = t.year ?? 0
        if dayKey(from, calendar: calendar) == dayKey(to, calendar: calendar) { return "\(fm) \(fd), \(fy)" }
        return fy == ty ? "\(fm) \(fd) – \(tm) \(td), \(ty)" : "\(fm) \(fd), \(fy) – \(tm) \(td), \(ty)"
    }

    /// The CGM parts of the report — mirror of the web's `reportBg`. `history` nil means it could
    /// not be fetched; `failure` says why.
    public static func reportBg(history: BgHistory?, failure: String?, report: LogReport, from: Date, to: Date,
                                hourLabelAt: (Int64) -> String, hourLabel: (Int) -> String, earliestLabel: (Int64) -> String,
                                calendar: Calendar = .current) -> ReportBg {
        guard let history else {
            return ReportBg(summaryHtml: nil, dayHtml: [:], mealText: [:], note: "No CGM section: \(failure ?? "BG history unavailable.")")
        }
        guard !history.readings.isEmpty else {
            return ReportBg(summaryHtml: nil, dayHtml: [:], mealText: [:], note: "No CGM readings stored for this range.")
        }
        let ms = { (d: Date) in Int64((d.timeIntervalSince1970 * 1000).rounded()) }
        let start = ms(calendar.startOfDay(for: from))
        let end = ms(calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: to))!)
        let covered = max(start, min(end, history.earliestAt ?? end))
        let stats = bgStats(history.readings, spanMs: Double(end - covered))!
        var line = "avg \(BgText.mg(stats.mean)) mg/dL · GMI \(JS.toFixed(stats.gmi, 1))% · CV \(BgText.mg(stats.cv))% · sensor data \(BgChartSvg.pct(stats.coverage))"
        if let earliest = history.earliestAt, earliest > start { line += " · history starts \(earliestLabel(earliest))" }
        var summary = "<h3>Blood sugar (CGM) · time in range 70–180</h3>" + BgChartSvg.tirBar(stats) + "<p class=\"line\">\(line)</p>"
        if report.days.count >= 3 {
            let pattern = dailyPattern(history.readings) { calendar.component(.hour, from: Date(timeIntervalSince1970: Double($0) / 1000)) }
            summary += BgChartSvg.pattern(pattern, hourLabel: hourLabel, height: 150)
        }
        var dayHtml: [String: String] = [:]
        var mealText: [String: String] = [:]
        for day in report.days {
            let parts = day.day.split(separator: "-").compactMap { Int($0) }
            guard parts.count == 3, let date = calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2])) else { continue }
            let dStart = ms(date), dEnd = ms(calendar.date(byAdding: .day, value: 1, to: date)!)
            let points = history.readings.filter { $0.at >= dStart && $0.at < dEnd }
            guard let dayStats = bgStats(points, spanMs: Double(dEnd - dStart)) else { continue }
            let meals = day.entries.map { BgChartSvg.Meal(at: $0.input.eatenAt, label: "\(JS.toFixed($0.input.carbsG, 0)) g") }
            dayHtml[day.day] = BgChartSvg.day(start: dStart, end: dEnd, points: points, meals: meals, hourLabel: hourLabelAt, height: 120)
                + "<div class=\"line\">\(BgText.statsLine(dayStats))</div>"
            for entry in day.entries {
                if let text = BgText.mealResponse(mealResponse(history.readings, eatenAt: entry.input.eatenAt)) { mealText[entry.input.id] = text }
            }
        }
        return ReportBg(summaryHtml: summary, dayHtml: dayHtml, mealText: mealText, note: nil)
    }

    /// `goal` resolves an entry's window goal with the same settings precedence as the Log screen;
    /// `time` formats an entry's local time.
    public static func report(
        from: Date, to: Date, entries: [LogEntryData], itemsByEntry: [Id: [LogItemData]], catalog: Catalog,
        goal: (LogEntryData) -> CarbGoal?, time: (Date) -> String, calendar: Calendar = .current
    ) -> LogReport {
        let days = days(from: from, to: to, calendar: calendar)
        let inputs = entries.map { entry -> ReportEntryInput in
            let eaten = Date(timeIntervalSince1970: Double(entry.eatenAt) / 1000)
            let items = webhookItemLines(for: itemsByEntry[entry.id] ?? [], catalog: catalog).map {
                ReportItemInput(name: $0.name, amount: $0.amount, carbsG: $0.carbsG)
            }
            return ReportEntryInput(
                id: entry.id, day: dayKey(eaten, calendar: calendar), eatenAt: entry.eatenAt, time: time(eaten),
                windowName: entry.windowName, bgMgdl: entry.bgMgdl, carbsG: entry.totalCarbsG,
                suggestedUnits: entry.suggestedUnits, takenUnits: entry.takenUnits, notes: entry.notes,
                goal: goal(entry), items: items)
        }
        return buildLogReport(days: days.map { dayKey($0, calendar: calendar) }, entries: inputs)
    }
}
