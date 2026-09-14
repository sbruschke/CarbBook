import Foundation

/// One row on the Calculator screen.
public struct CalculatorLine: Equatable, Sendable, Identifiable {
    public var id: String
    public var refType: RefType
    public var refId: Id
    public var displayName: String
    public var amount: Double
    public var unit: String

    public init(id: String, refType: RefType, refId: Id, displayName: String, amount: Double, unit: String) {
        self.id = id; self.refType = refType; self.refId = refId
        self.displayName = displayName; self.amount = amount; self.unit = unit
    }
}

public enum BgInput: Equatable, Sendable {
    case none
    case dexcom(mgdl: Double, trend: String?)
    case manual(mgdl: Double)

    public var mgdl: Double? {
        switch self {
        case .none: nil
        case .dexcom(let mgdl, _), .manual(let mgdl): mgdl
        }
    }

    /// §3 `bg_source`
    public var source: String {
        switch self {
        case .none: "none"
        case .dexcom: "dexcom"
        case .manual: "manual"
        }
    }

    public var trend: String? { if case .dexcom(_, let trend) = self { trend } else { nil } }
}

public struct CalculatorResult: Equatable, Sendable {
    public var lineCarbs: [CarbResult]
    public var total: CarbResult
    public var settings: DoseSettingsData?
    public var estimate: DoseEstimate?
    /// Breakdown text when a dose is suggested.
    public var breakdown: String?
    /// Why there is no dose, when there is none.
    public var refusal: String?
    public var recentDoseWarning: Bool
}

/// A Dexcom reading prefills BG only when it is at most 15 minutes old and not more than
/// 2 minutes in the future (server /api/bg rule); otherwise the user enters BG manually.
public func isBgReadingUsable(readAtMs: Int64, nowMs: Int64) -> Bool {
    let age = nowMs - readAtMs
    return age <= 15 * 60_000 && age >= -2 * 60_000
}

public let noSettingsMessage = "No dose estimate: no dose settings are in effect yet."

/// Everything the Calculator shows, computed from the current lines and inputs.
/// `windowOverride` is a window name chosen by the user; the dose uses that window's start time.
public func evaluateCalculator(
    lines: [CalculatorLine],
    catalog: Catalog,
    settingsVersions: [DoseSettingsData],
    eatenAt: Date,
    calendar: Calendar = .current,
    windowOverride: String?,
    bg: BgInput,
    lastDoseAtMs: Int64?,
    nowMs: Int64,
    rejectedSettingsIds: Set<Id> = []
) -> CalculatorResult {
    let lineCarbs = lines.map { itemCarbs(catalog, $0.refType, $0.refId, $0.amount, $0.unit) }
    let total = sumCarbs(lineCarbs)
    let eatenMs = Int64((eatenAt.timeIntervalSince1970 * 1000).rounded())
    let usableSettings = rejectedSettingsIds.isEmpty
        ? settingsVersions
        : settingsVersions.filter { !rejectedSettingsIds.contains($0.id) }
    let settings = activeSettings(usableSettings, eatenMs)
    var result = CalculatorResult(lineCarbs: lineCarbs, total: total, settings: settings, estimate: nil,
                                  breakdown: nil, refusal: nil,
                                  recentDoseWarning: recentDoseWarning(lastDoseAtMs, nowMs))
    guard let settings else {
        result.refusal = noSettingsMessage
        return result
    }
    var minutes = minutesOfDay(eatenAt, calendar: calendar)
    if let name = windowOverride, let window = settings.windows.first(where: { $0.name == name }),
       let start = try? parseHHMM(window.start) {
        minutes = start
    }
    let estimate = estimateDose(DoseInput(settings: settings, minutes: minutes, carbs: total, bg: bg.mgdl))
    result.estimate = estimate
    switch estimate {
    case .ok(let suggestion): result.breakdown = formatBreakdown(suggestion)
    case .refused(let reason, _): result.refusal = reason.message
    }
    return result
}

/// The log_entry + log_item records for "Log it".
public func buildLogRecords(
    lines: [CalculatorLine],
    result: CalculatorResult,
    bg: BgInput,
    eatenAt: Date,
    takenUnits: Double?,
    notes: String?,
    newId: () -> Id
) -> (entry: LogEntryData, items: [LogItemData]) {
    var suggested: Double?
    if case .ok(let s) = result.estimate { suggested = s.units }
    let entry = LogEntryData(
        id: newId(),
        eatenAt: Int64((eatenAt.timeIntervalSince1970 * 1000).rounded()),
        windowName: result.estimate?.window?.name,
        bgMgdl: bg.mgdl,
        bgSource: bg.source,
        bgTrend: bg.trend,
        totalCarbsG: result.total.carbsG,
        suggestedUnits: suggested,
        takenUnits: takenUnits,
        settingsVersionId: result.settings?.id,
        notes: notes
    )
    let items = zip(lines, result.lineCarbs).map { line, carbs in
        LogItemData(id: newId(), logEntryId: entry.id, refType: line.refType, refId: line.refId,
                    displayName: line.displayName, amount: line.amount, unit: line.unit, carbsG: carbs.carbsG)
    }
    return (entry, items)
}

/// The meal + meal_item records for "Save as meal".
public func buildMealRecords(
    name: String,
    yieldServings: Double,
    totalWeightG: Double?,
    lines: [CalculatorLine],
    newId: () -> Id
) -> (meal: MealData, items: [MealItemData]) {
    let meal = MealData(id: newId(), name: name, yieldServings: yieldServings, totalWeightG: totalWeightG)
    let items = lines.enumerated().map { index, line in
        MealItemData(id: newId(), mealId: meal.id, refType: line.refType, refId: line.refId,
                     amount: line.amount, unit: line.unit, position: index)
    }
    return (meal, items)
}
