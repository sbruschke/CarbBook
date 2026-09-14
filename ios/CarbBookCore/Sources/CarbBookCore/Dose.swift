import Foundation

/// Mirrors packages/core/src/dose.ts.
private let EPS = 1e-9
private let HOUR_MS: Int64 = 3_600_000

public struct InvalidTimeError: Error, Equatable {
    public let value: String
}

/// Parses "HH:MM" (exactly two ASCII digits each side, 00:00-23:59) to minutes since midnight.
public func parseHHMM(_ value: String) throws -> Int {
    let bytes = Array(value.utf8)
    func digit(_ b: UInt8) -> Int? { (48...57).contains(b) ? Int(b - 48) : nil }
    guard bytes.count == 5, bytes[2] == UInt8(ascii: ":"),
          let h1 = digit(bytes[0]), let h2 = digit(bytes[1]),
          let m1 = digit(bytes[3]), let m2 = digit(bytes[4]) else { throw InvalidTimeError(value: value) }
    let hours = h1 * 10 + h2
    let minutes = m1 * 10 + m2
    guard hours <= 23, minutes <= 59 else { throw InvalidTimeError(value: value) }
    return hours * 60 + minutes
}

public func minutesOfDay(_ date: Date, calendar: Calendar = .current) -> Int {
    let parts = calendar.dateComponents([.hour, .minute], from: date)
    return parts.hour! * 60 + parts.minute!
}

/// Last window whose start ≤ minutes; before the first start → the previous day's last window.
/// Windows with unparseable starts sort as if they started at 0 (estimateDose refuses those first).
public func pickWindow(_ windows: [DoseWindow], _ minutes: Int) -> DoseWindow? {
    guard !windows.isEmpty else { return nil }
    let sorted = windows.enumerated()
        .map { (index: $0.offset, window: $0.element, start: (try? parseHHMM($0.element.start)) ?? 0) }
        .sorted { $0.start != $1.start ? $0.start < $1.start : $0.index < $1.index }
    var chosen = sorted.last!.window
    for entry in sorted where entry.start <= minutes { chosen = entry.window }
    return chosen
}

public func correctionUnits(_ rule: CorrectionRule, _ bg: Double?) -> Double {
    // Written as TS's `bg <= threshold || step <= 0` so NaN inputs yield NaN, not 0.
    guard let bg else { return 0 }
    if bg <= rule.threshold || rule.step <= 0 { return 0 }
    let steps = (bg - rule.threshold) / rule.step
    switch rule.mode {
    case "started": return (steps - EPS).rounded(.up) * rule.unitsPerStep
    case "full": return (steps + EPS).rounded(.down) * rule.unitsPerStep
    case "proportional": return steps * rule.unitsPerStep
    default: return 0 // unreachable after validation; TS returns undefined here
    }
}

/// Rounds a raw dose to `rule.increment`. Pure: assumes `rule.increment > 0`.
public func roundDose(_ raw: Double, _ rule: RoundingRule, _ bg: Double?) -> (units: Double, roundedDown: Bool) {
    let increment = rule.increment
    var roundedDown = false
    if let bg, let below = rule.roundDownBelowBg, bg < below { roundedDown = true }
    let steps = roundedDown ? (raw / increment + EPS).rounded(.down) : (raw / increment + 0.5 + EPS).rounded(.down)
    return (Double(JS.toFixed(steps * increment, 4))!, roundedDown)
}

public protocol EffectiveVersion {
    var id: Id { get }
    var effectiveFrom: Int64 { get }
    var deleted: Int? { get }
}

extension DoseSettingsData: EffectiveVersion {}

/// Newest non-deleted version with effective_from ≤ atMs; ties go to the larger id (JS string order).
public func activeSettings<T: EffectiveVersion>(_ versions: [T], _ atMs: Int64) -> T? {
    var best: T?
    for v in versions where v.deleted != 1 && v.effectiveFrom <= atMs {
        if let current = best {
            if v.effectiveFrom > current.effectiveFrom || (v.effectiveFrom == current.effectiveFrom && JS.greater(v.id, current.id)) {
                best = v
            }
        } else {
            best = v
        }
    }
    return best
}

/// Warns near a logged dose in either time direction, including clock-skewed future timestamps.
public func recentDoseWarning(_ lastDoseAtMs: Int64?, _ nowMs: Int64, hours: Int64 = 4) -> Bool {
    guard let lastDoseAtMs else { return false }
    return nowMs - lastDoseAtMs < hours * HOUR_MS
}
