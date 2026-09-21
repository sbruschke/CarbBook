import Foundation

/// Input for ``accountabilityText(_:)`` — the mirror of the TS core's `AccountabilityInput`.
public struct AccountabilityInput: Equatable, Sendable {
    /// Local timestamp, already formatted, e.g. "9/20/26, 12:24:58 PM CDT".
    public var when: String
    /// Logged BG in mg/dL, or nil when the entry has none.
    public var bgMgdl: Double?
    /// The entry's carb total in grams.
    public var carbsG: Double
    /// Units actually taken, or nil when no dose is recorded on the entry.
    public var units: Double?

    public init(when: String, bgMgdl: Double?, carbsG: Double, units: Double?) {
        self.when = when
        self.bgMgdl = bgMgdl
        self.carbsG = carbsG
        self.units = units
    }
}

/// Trailing zeros are noise in a sentence: 7 not 7.00, 59 not 59.0, 0.5 stays 0.5.
/// Exactly the TS core's `String(Number(value.toFixed(digits)))`, via the JS-semantics helpers —
/// a `String(format:)` here would round ties the other way and drift from the shared vectors.
private func number(_ value: Double, _ digits: Int) -> String {
    JS.numberString(Double(JS.toFixed(value, digits)) ?? value)
}

private func unitsPhrase(_ units: Double) -> String {
    if units == 0 { return "and so am not giving myself any fast acting insulin" }
    let text = number(units, 2)
    return "and so am giving myself \(text) \(text == "1" ? "unit" : "units") of fast acting insulin"
}

/// The copy-pasteable accountability message for one log entry, identical to the TS core's
/// `accountabilityText` (shared vectors: `testdata/accountability-vectors.json`).
///
/// It is a message about an entry, never a dose recommendation: it only restates what is already
/// logged, and says plainly when a BG, a carb total or a dose is missing rather than guessing.
public func accountabilityText(_ input: AccountabilityInput) -> String {
    let bg = (input.bgMgdl?.isFinite ?? false) ? input.bgMgdl : nil
    let opening = bg == nil
        ? "As of \(input.when) I do not have a blood sugar reading."
        : "As of \(input.when) my blood sugar is \(number(bg!, 0))."

    guard input.carbsG.isFinite else {
        return "\(opening) I do not have a carb total for this meal."
    }
    let carbs = "I am eating something with \(number(input.carbsG, 1)) carbs"

    guard let units = input.units, units.isFinite else {
        return "\(opening) \(carbs) and have not recorded a dose yet."
    }
    return "\(opening) \(carbs) \(unitsPhrase(units))."
}
