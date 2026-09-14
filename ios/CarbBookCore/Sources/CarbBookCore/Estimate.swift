import Foundation

/// Mirrors estimateDose, its validation and formatBreakdown in packages/core/src/dose.ts.
public struct DoseInput: Sendable {
    public var settings: DoseSettingsData
    /// Minutes since local midnight when the food is eaten.
    public var minutes: Int
    public var carbs: CarbResult
    public var bg: Double?

    public init(settings: DoseSettingsData, minutes: Int, carbs: CarbResult, bg: Double?) {
        self.settings = settings; self.minutes = minutes; self.carbs = carbs; self.bg = bg
    }
}

/// Sanity limits for dose estimates; same values as TS `DOSE_LIMITS`. Values above these are refused:
/// inputs → `invalidInput`, settings → `invalidSettings`, raw units → `exceedsLimit`.
public enum DoseLimits {
    public static let maxCarbsG: Double = 2000
    public static let maxBg: Double = 1000
    public static let maxRatioGPerUnit: Double = 1000
    public static let maxCorrectionThreshold: Double = 1000
    public static let maxCorrectionStep: Double = 1000
    public static let maxUnitsPerStep: Double = 50
    public static let maxRoundingIncrement: Double = 10
    public static let maxRoundDownBelowBg: Double = 1000
    /// Largest raw (meal + correction, before rounding) dose that is still estimated.
    public static let maxRawUnits: Double = 50
}

public enum DoseRefusal: String, Sendable {
    case noWindow = "no_window"
    case invalidRatio = "invalid_ratio"
    case incompleteCarbs = "incomplete_carbs"
    case invalidInput = "invalid_input"
    case invalidSettings = "invalid_settings"
    case exceedsLimit = "exceeds_limit"

    /// Shown in place of a dose. iOS-only text; the reason codes match the TS core.
    public var message: String {
        switch self {
        case .noWindow: "No dose estimate: the dose settings have no meal windows."
        case .invalidRatio: "No dose estimate: this meal window's carb ratio is not above zero."
        case .incompleteCarbs: "No dose estimate: at least one item is missing carb data or uses a unit it can't convert."
        case .invalidInput: "No dose estimate: the carbs, BG or time entered are not valid numbers."
        case .invalidSettings: "No dose estimate: the dose settings are invalid. Fix them in Settings."
        case .exceedsLimit: "No dose estimate: the calculated dose is over 50 units. Check the carbs and BG entered."
        }
    }
}

public struct DoseSuggestion: Equatable, Sendable {
    public var window: DoseWindow
    public var carbsG: Double
    public var bg: Double?
    public var mealUnits: Double
    public var correctionUnits: Double
    public var rawUnits: Double
    public var units: Double
    public var roundedDown: Bool
    public var roundDownBelowBg: Double?
}

public enum DoseEstimate: Equatable, Sendable {
    case ok(DoseSuggestion)
    case refused(DoseRefusal, window: DoseWindow?)

    public var window: DoseWindow? {
        switch self {
        case .ok(let s): s.window
        case .refused(_, let window): window
        }
    }
}

private func hasInvalidInput(_ input: DoseInput) -> Bool {
    if input.minutes < 0 || input.minutes > 1439 { return true }
    if !input.carbs.carbsG.isFinite || input.carbs.carbsG < 0 || input.carbs.carbsG > DoseLimits.maxCarbsG { return true }
    if let bg = input.bg, !bg.isFinite || bg < 0 || bg > DoseLimits.maxBg { return true }
    return false
}

private let validCorrectionModes: Set<String> = ["started", "full", "proportional"]

/// Same order and rules as TS `hasInvalidSettings`.
public func hasInvalidSettings(_ settings: DoseSettingsData) -> Bool {
    var starts: [Int] = []
    for window in settings.windows {
        guard let start = try? parseHHMM(window.start) else { return true }
        if starts.contains(start) { return true }
        starts.append(start)
        if window.ratioGPerUnit > DoseLimits.maxRatioGPerUnit { return true }
    }
    let c = settings.correction
    if !c.threshold.isFinite || c.threshold > DoseLimits.maxCorrectionThreshold { return true }
    if !c.step.isFinite || c.step <= 0 || c.step > DoseLimits.maxCorrectionStep { return true }
    if !c.unitsPerStep.isFinite || c.unitsPerStep < 0 || c.unitsPerStep > DoseLimits.maxUnitsPerStep { return true }
    if !validCorrectionModes.contains(c.mode) { return true }
    let r = settings.rounding
    if !r.increment.isFinite || r.increment <= 0 || r.increment > DoseLimits.maxRoundingIncrement { return true }
    if let below = r.roundDownBelowBg, !below.isFinite || below > DoseLimits.maxRoundDownBelowBg { return true }
    return false
}

public func estimateDose(_ input: DoseInput) -> DoseEstimate {
    if hasInvalidInput(input) { return .refused(.invalidInput, window: nil) }
    if hasInvalidSettings(input.settings) { return .refused(.invalidSettings, window: nil) }
    guard let window = pickWindow(input.settings.windows, input.minutes) else { return .refused(.noWindow, window: nil) }
    if !(window.ratioGPerUnit > 0) { return .refused(.invalidRatio, window: window) }
    if !input.carbs.complete { return .refused(.incompleteCarbs, window: window) }
    let mealUnits = input.carbs.carbsG / window.ratioGPerUnit
    let correction = correctionUnits(input.settings.correction, input.bg)
    let raw = mealUnits + correction
    if raw > DoseLimits.maxRawUnits { return .refused(.exceedsLimit, window: window) }
    let rounded = roundDose(raw, input.settings.rounding, input.bg)
    return .ok(DoseSuggestion(
        window: window, carbsG: input.carbs.carbsG, bg: input.bg, mealUnits: mealUnits,
        correctionUnits: correction, rawUnits: raw, units: rounded.units, roundedDown: rounded.roundedDown,
        roundDownBelowBg: input.settings.rounding.roundDownBelowBg
    ))
}

private func trim(_ n: Double, _ digits: Int) -> String {
    JS.numberString(Double(JS.toFixed(n, digits))!)
}

/// e.g. "72g ÷ 8 = 9.0 + BG 263 → 2u = 11.0 → 11u". Same format as the TS core.
public func formatBreakdown(_ e: DoseSuggestion) -> String {
    var text = "\(trim(e.carbsG, 1))g ÷ \(trim(e.window.ratioGPerUnit, 2)) = \(JS.toFixed(e.mealUnits, 1))"
    if let bg = e.bg {
        text += " + BG \(trim(bg, 0)) → \(trim(e.correctionUnits, 2))u = \(JS.toFixed(e.rawUnits, 1))"
    }
    text += " → \(trim(e.units, 2))u"
    if e.roundedDown {
        text += " (rounded down: BG under \(e.roundDownBelowBg.map(JS.numberString) ?? "null"))"
    }
    return text
}
