import Foundation

/// The printable log report (log export spec 2026-10-07) — mirror of TS core `buildLogReport`
/// (shared vectors: `testdata/log-report-vectors.json`). Which day an entry falls on, its time and
/// the day headings are platform work done before this; this is only the arithmetic.
public struct ReportItemInput: Codable, Equatable, Sendable {
    public var name: String
    /// Already formatted, e.g. "1 cup"; empty for a quick-carbs row (its amount IS its carbs).
    public var amount: String
    public var carbsG: Double

    public init(name: String, amount: String, carbsG: Double) {
        self.name = name; self.amount = amount; self.carbsG = carbsG
    }

    enum CodingKeys: String, CodingKey {
        case name, amount
        case carbsG = "carbs_g"
    }
}

public struct ReportEntryInput: Codable, Equatable, Sendable {
    public var id: Id
    /// Local day key "YYYY-MM-DD" the entry falls on.
    public var day: String
    public var eatenAt: Int64
    /// Already formatted local time.
    public var time: String
    public var windowName: String?
    public var bgMgdl: Double?
    public var carbsG: Double
    public var suggestedUnits: Double?
    public var takenUnits: Double?
    public var notes: String?
    public var goal: CarbGoal?
    public var items: [ReportItemInput]

    public init(id: Id, day: String, eatenAt: Int64, time: String, windowName: String?, bgMgdl: Double?, carbsG: Double,
                suggestedUnits: Double?, takenUnits: Double?, notes: String?, goal: CarbGoal?, items: [ReportItemInput]) {
        self.id = id; self.day = day; self.eatenAt = eatenAt; self.time = time; self.windowName = windowName
        self.bgMgdl = bgMgdl; self.carbsG = carbsG; self.suggestedUnits = suggestedUnits; self.takenUnits = takenUnits
        self.notes = notes; self.goal = goal; self.items = items
    }

    enum CodingKeys: String, CodingKey {
        case id, day, time, notes, goal, items
        case eatenAt = "eaten_at"
        case windowName = "window_name"
        case bgMgdl = "bg_mgdl"
        case carbsG = "carbs_g"
        case suggestedUnits = "suggested_units"
        case takenUnits = "taken_units"
    }
}

public struct ReportEntry: Equatable, Sendable {
    public var input: ReportEntryInput
    public var goalStatus: GoalStatus
}

public struct ReportDay: Equatable, Sendable {
    public var day: String
    public var entries: [ReportEntry]
    public var carbsG: Double
    public var takenUnits: Double
}

public struct ReportSummary: Equatable, Sendable {
    public var days: Int
    public var loggedDays: Int
    public var entries: Int
    public var carbsG: Double
    /// Per day with at least one entry — an unlogged day is missing data, not a 0 g day.
    public var avgCarbsPerLoggedDay: Double?
    public var takenUnits: Double
    public var avgTakenPerLoggedDay: Double?
    public var bgReadings: Int
    public var avgBg: Double?
    public var minBg: Double?
    public var maxBg: Double?
    /// Entries per goal band; `.none` counts entries whose window has no goal.
    public var goalCounts: [GoalStatus: Int]
}

public struct LogReport: Equatable, Sendable {
    public var days: [ReportDay]
    public var summary: ReportSummary
}

private func finite(_ value: Double?) -> Double? {
    guard let value, value.isFinite else { return nil }
    return value
}

/// Groups entries onto `days` (entries on any other day are dropped), orders each day by time and
/// totals. A non-finite carb or dose figure counts as nothing rather than poisoning a total.
public func buildLogReport(days dayKeys: [String], entries input: [ReportEntryInput]) -> LogReport {
    var goalCounts: [GoalStatus: Int] = [.none: 0, .inGoal: 0, .near: 0, .off: 0, .out: 0]
    var bgs: [Double] = []
    let days = dayKeys.map { day -> ReportDay in
        // Decorated with the original index: Swift's sort is not stable, the TS one is.
        let entries = input.enumerated()
            .filter { $0.element.day == day }
            .sorted { ($0.element.eatenAt, $0.offset) < ($1.element.eatenAt, $1.offset) }
            .map { ReportEntry(input: $0.element,
                               goalStatus: goalStatus(CarbResult(carbsG: $0.element.carbsG, complete: true), $0.element.goal)) }
        for entry in entries {
            goalCounts[entry.goalStatus, default: 0] += 1
            if let bg = finite(entry.input.bgMgdl) { bgs.append(bg) }
        }
        return ReportDay(day: day, entries: entries,
                         carbsG: entries.reduce(0) { $0 + (finite($1.input.carbsG) ?? 0) },
                         takenUnits: entries.reduce(0) { $0 + (finite($1.input.takenUnits) ?? 0) })
    }
    let logged = days.filter { !$0.entries.isEmpty }
    let carbs = logged.reduce(0) { $0 + $1.carbsG }
    let taken = logged.reduce(0) { $0 + $1.takenUnits }
    let count = Double(logged.count)
    return LogReport(days: days, summary: ReportSummary(
        days: days.count,
        loggedDays: logged.count,
        entries: logged.reduce(0) { $0 + $1.entries.count },
        carbsG: carbs,
        avgCarbsPerLoggedDay: logged.isEmpty ? nil : carbs / count,
        takenUnits: taken,
        avgTakenPerLoggedDay: logged.isEmpty ? nil : taken / count,
        bgReadings: bgs.count,
        avgBg: bgs.isEmpty ? nil : bgs.reduce(0, +) / Double(bgs.count),
        minBg: bgs.min(),
        maxBg: bgs.max(),
        goalCounts: goalCounts))
}

/// One row on the in-app clipboard (log copy spec 2026-10-07) — mirror of TS core `ClipItem`. No id
/// and no carb snapshot: pasted rows recompute their carbs from today's food data.
public struct ClipItem: Codable, Equatable, Sendable {
    public var refType: RefType
    public var refId: Id
    public var amount: Double
    public var unit: String
    /// Quick-carbs rows only; nil means the default label.
    public var label: String?

    public init(refType: RefType, refId: Id, amount: Double, unit: String, label: String?) {
        self.refType = refType; self.refId = refId; self.amount = amount; self.unit = unit; self.label = label
    }

    enum CodingKeys: String, CodingKey {
        case amount, unit, label
        case refType = "ref_type"
        case refId = "ref_id"
    }
}

/// Clipboard rows for logged items. A quick row whose logged name is just the default goes back to
/// "no label", so pasting does not freeze the default wording into a real label.
public func clipItemsFromLog(_ items: [LogItemData]) -> [ClipItem] {
    items.map { item in
        ClipItem(refType: item.refType, refId: item.refId, amount: item.amount, unit: item.unit,
                 label: item.refType == .quick && item.displayName != quickDisplayName(nil) ? item.displayName : nil)
    }
}
