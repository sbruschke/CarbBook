import CarbBookCore
import Foundation

/// Decision logic behind the Calculator, Meal editor and Log entry screens, kept out of the UI
/// target so it is unit tested on Linux. The SwiftUI views only wire text fields and timers to these.

// MARK: - Amount fields

/// Item amount fields are `String`-backed and parsed strictly with `NumberParsing.parseAmount`
/// (never SwiftUI's locale-dependent `TextField(value:format:)`, which keeps the previous value when
/// the text is invalid). An amount is required, so empty or malformed text maps to NaN: core's
/// `itemCarbs` then reports the item incomplete and `estimateDose` refuses, instead of computing a
/// dose on a number the screen doesn't show.
public enum AmountInput {
    public static let invalidMessage = "Invalid amount"

    public static func modelAmount(_ text: String) -> Double {
        NumberParsing.parseAmount(text) ?? .nan
    }

    /// True for empty (the amount is required) or malformed text.
    public static func isInvalid(_ text: String) -> Bool {
        NumberParsing.parseAmount(text) == nil
    }

    /// Locale-independent text for a stored amount that parses back to (almost exactly) the same
    /// value; non-finite amounts show as empty, which is itself flagged invalid.
    public static func text(for amount: Double) -> String {
        guard amount.isFinite, amount >= 0 else { return "" }
        var text = String(format: "%.10f", amount)
        while text.hasSuffix("0") { text.removeLast() }
        if text.hasSuffix(".") { text.removeLast() }
        return text
    }

    /// True when any line's amount came from invalid text; saving or logging must be blocked.
    /// Quick carbs rows must also be inside the dose limit (quick-carbs spec §2: fail closed).
    public static func hasInvalidAmount(_ lines: [CalculatorLine]) -> Bool {
        lines.contains { isInvalid(amount: $0.amount, refType: $0.refType) }
    }

    /// An equality key for `onChange`: compares amounts by bit pattern so a NaN amount equals itself.
    public static func changeKey(_ lines: [CalculatorLine]) -> [String] {
        lines.map { "\($0.id)|\($0.refType.rawValue)|\($0.refId)|\($0.amount.bitPattern)|\($0.unit)" }
    }

    public static func hasInvalidAmount(_ items: [MealItemData]) -> Bool {
        items.contains { isInvalid(amount: $0.amount, refType: $0.refType) }
    }

    static func isInvalid(amount: Double, refType: RefType) -> Bool {
        !amount.isFinite || amount < 0 || (refType == .quick && !isValidQuickCarbs(amount))
    }
}

// MARK: - Quick carbs rows

/// "+ Carbs" rows (quick-carbs spec §2): grams of carbs typed as a plain decimal — never a fraction —
/// within `DoseLimits.maxCarbsG`. Invalid text maps to NaN so the row is incomplete and saving is blocked.
public enum QuickCarbsInput {
    public static let invalidMessage = "Enter grams of carbs (0–2000)"

    public static func parse(_ text: String) -> Double? {
        guard let value = NumberParsing.parseNonNegative(text), isValidQuickCarbs(value) else { return nil }
        return value
    }

    public static func modelAmount(_ text: String) -> Double { parse(text) ?? .nan }

    public static func isInvalid(_ text: String) -> Bool { parse(text) == nil }

    /// "Ranch & salad — 7 g carbs".
    public static func rowText(label: String?, amount: Double) -> String {
        let grams = isValidQuickCarbs(amount) ? "\(formatCarbs(amount)) g carbs" : "enter grams of carbs"
        return "\(quickDisplayName(label)) — \(grams)"
    }
}

// MARK: - Taken dose

public enum TakenDoseError: Error, Equatable {
    case malformed

    public var message: String { "Taken dose must be a number" }
}

public enum TakenDoseInput {
    /// "Log it": empty means carbs only (nil); malformed text blocks the save.
    public static func unitsForLog(_ text: String) throws -> Double? {
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return nil }
        guard let value = NumberParsing.parseNonNegative(text) else { throw TakenDoseError.malformed }
        return value
    }

    /// Typed-but-invalid "Taken" text (decimal only: a fraction is never a dose entry).
    public static func isMalformed(_ text: String) -> Bool {
        NumberParsing.isMalformed(text, using: NumberParsing.parseNonNegative)
    }

    /// Log entry edit: an unedited field keeps the stored value verbatim (display rounding must not
    /// change it); an edited field is parsed, and malformed text blocks the save rather than wiping
    /// the stored `takenUnits`.
    public static func unitsForEdit(text: String, loadedText: String, stored: Double?) throws -> Double? {
        guard text != loadedText else { return stored }
        return try unitsForLog(text)
    }
}

/// The Calculator's "Taken" field: prefilled from the estimate until the user types in it. Once the
/// user has typed, it is theirs (even if the text happens to equal a later estimate) until `reset`.
public struct TakenField: Equatable, Sendable {
    public private(set) var text = ""
    public private(set) var editedByUser = false

    public init() {}

    public mutating func userTyped(_ newText: String) {
        text = newText
        editedByUser = true
    }

    /// `auto` is the formatted ok-estimate, or "" when there is none.
    public mutating func applyEstimate(_ auto: String) {
        if !editedByUser { text = auto }
    }

    public mutating func reset() {
        text = ""
        editedByUser = false
    }
}

// MARK: - BG freshness and recompute

public enum DexcomFetch: Equatable, Sendable {
    case notLoaded
    case failed
    case reading(BgReading)
}

public enum BgStatus: Equatable, Sendable {
    case checking
    case usable(minutesAgo: Int64)
    case future
    case stale(minutesOld: Int64)
    case unavailable
}

public struct CalculatorInputs: Sendable {
    public var lines: [CalculatorLine]
    public var catalog: InMemoryCatalog
    public var settingsVersions: [DoseSettingsData]
    public var useNow: Bool
    public var eatenAt: Date
    public var windowOverride: String?
    public var manualBg: String
    public var lastDoseAtMs: Int64?
    public var rejectedSettingsIds: Set<Id>

    public init(lines: [CalculatorLine], catalog: InMemoryCatalog, settingsVersions: [DoseSettingsData], useNow: Bool,
                eatenAt: Date, windowOverride: String?, manualBg: String, lastDoseAtMs: Int64?, rejectedSettingsIds: Set<Id>) {
        self.lines = lines; self.catalog = catalog; self.settingsVersions = settingsVersions; self.useNow = useNow
        self.eatenAt = eatenAt; self.windowOverride = windowOverride; self.manualBg = manualBg
        self.lastDoseAtMs = lastDoseAtMs; self.rejectedSettingsIds = rejectedSettingsIds
    }
}

public struct CalculatorSnapshot: Equatable, Sendable {
    /// `.dexcom` only while the reading is usable at `nowMs`, otherwise `.none`.
    public var dexcomBg: BgInput
    /// What the estimate used: usable Dexcom, else manual BG (non-finite when malformed), else none.
    public var bg: BgInput
    public var bgStatus: BgStatus
    public var eatenAt: Date
    public var result: CalculatorResult
}

/// The typed BG when no usable Dexcom reading: blank → none; malformed → a non-finite manual BG so
/// core refuses with `invalid_input` rather than acting as if no BG was entered.
public func manualBgInput(_ text: String) -> BgInput {
    if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return .none }
    if let value = NumberParsing.parseWholeNumber(text) { return .manual(mgdl: value) }
    return .manual(mgdl: .infinity)
}

public func bgStatus(_ dexcom: DexcomFetch, nowMs: Int64) -> BgStatus {
    switch dexcom {
    case .notLoaded: return .checking
    case .failed: return .unavailable
    case .reading(let reading):
        if reading.isUsable(nowMs: nowMs) { return .usable(minutesAgo: max(0, nowMs - reading.readAt) / 60_000) }
        if reading.readAt > nowMs { return .future }
        return .stale(minutesOld: (nowMs - reading.readAt) / 60_000)
    }
}

/// Everything time-dependent on the Calculator, evaluated at `nowMs`: re-validates the Dexcom reading
/// (a reading that has gone stale stops feeding the estimate), moves "eating now" to `nowMs`, and
/// recomputes the estimate and recent-dose warning. Called on input changes and on a ticking clock.
public func recomputeCalculator(_ inputs: CalculatorInputs, dexcom: DexcomFetch, nowMs: Int64,
                                calendar: Calendar = .current) -> CalculatorSnapshot {
    let status = bgStatus(dexcom, nowMs: nowMs)
    var dexcomBg = BgInput.none
    if case .usable = status, case .reading(let reading) = dexcom {
        dexcomBg = .dexcom(mgdl: reading.mgdl, trend: reading.trend)
    }
    let bg = dexcomBg == .none ? manualBgInput(inputs.manualBg) : dexcomBg
    let eatenAt = inputs.useNow ? Date(timeIntervalSince1970: Double(nowMs) / 1000) : inputs.eatenAt
    let result = evaluateCalculator(
        lines: inputs.lines, catalog: inputs.catalog, settingsVersions: inputs.settingsVersions, eatenAt: eatenAt,
        calendar: calendar, windowOverride: inputs.windowOverride, bg: bg, lastDoseAtMs: inputs.lastDoseAtMs,
        nowMs: nowMs, rejectedSettingsIds: inputs.rejectedSettingsIds)
    return CalculatorSnapshot(dexcomBg: dexcomBg, bg: bg, bgStatus: status, eatenAt: eatenAt, result: result)
}

// MARK: - Cached user

/// The signed-in user cached in UserDefaults for offline launches. Cleared on sign-out (local data stays).
public enum UserCache {
    public static let key = "user"

    public static func save(_ user: ApiUser, to defaults: UserDefaults = .standard) throws {
        defaults.set(try JSONEncoder().encode(user), forKey: key)
    }

    public static func load(from defaults: UserDefaults = .standard) -> ApiUser? {
        defaults.data(forKey: key).flatMap { try? JSONDecoder().decode(ApiUser.self, from: $0) }
    }

    public static func clear(_ defaults: UserDefaults = .standard) {
        defaults.removeObject(forKey: key)
    }
}
