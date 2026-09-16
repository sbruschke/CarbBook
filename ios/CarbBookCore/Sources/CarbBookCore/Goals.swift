import Foundation

/// A per-window carb target (spec §2). Both bounds finite, `0 <= min <= max <= DoseLimits.maxCarbsG`.
/// `nil` on a window means "no goal", and is written to the wire as an explicit JSON null.
public struct CarbGoal: Codable, Equatable, Sendable {
    public var min: Double
    public var max: Double

    public init(min: Double, max: Double) {
        self.min = min
        self.max = max
    }

    public var isValid: Bool {
        min.isFinite && max.isFinite && min >= 0 && min <= max && max <= DoseLimits.maxCarbsG
    }

    /// Looser than `isValid`: no upper bound. A day goal is a sum of window goals and can
    /// legitimately exceed the single-window storage ceiling; `goalStatus`/`dayGoal` only need a
    /// sane band (finite, non-negative, min <= max), not a storable single-window goal.
    var isUsable: Bool {
        min.isFinite && max.isFinite && min >= 0 && min <= max
    }
}

/// Colour feedback for carbs against a goal (spec §3). Raw values match the TS core and the
/// shared vectors; `inGoal` is spelled out because `in` is a Swift keyword.
public enum GoalStatus: String, Codable, Equatable, Sendable {
    case none
    case inGoal = "in"
    case near
    case off
    case out

    /// Short screen-reader label; the visible text always carries the numbers as well. Same
    /// wording as the TS core's `GOAL_STATUS_LABELS`, so both apps read the same aloud.
    public var label: String {
        switch self {
        case .none: "no goal"
        case .inGoal: "in goal"
        case .near: "near goal"
        case .off: "off goal"
        case .out: "outside goal"
        }
    }
}

/// `d` is the distance outside the goal band; 0 inside it. d == 0 → in, d <= 5 → near,
/// d <= 10 → off, else out. No goal, incomplete carbs or a non-finite total → none.
public func goalStatus(_ carbs: CarbResult, _ goal: CarbGoal?) -> GoalStatus {
    guard let goal, goal.isUsable, carbs.complete, carbs.carbsG.isFinite else { return .none }
    let value = carbs.carbsG
    if value >= goal.min && value <= goal.max { return .inGoal }
    let d = Swift.min(abs(value - goal.min), abs(value - goal.max))
    if d <= 5 { return .near }
    if d <= 10 { return .off }
    return .out
}

/// A day's goal: the sum of that day's window goals. Windows without a goal contribute nothing to
/// either side; nil when no window in the day has a goal (spec §3).
public func dayGoal(_ windows: [DoseWindow]) -> CarbGoal? {
    let goals = windows.compactMap(\.carbGoal).filter(\.isUsable)
    guard !goals.isEmpty else { return nil }
    return CarbGoal(min: goals.reduce(0) { $0 + $1.min }, max: goals.reduce(0) { $0 + $1.max })
}

/// "68 g · goal 50–80" — the numbers always show, so colour is never the only signal (spec §3).
public func goalText(_ carbs: CarbResult, _ goal: CarbGoal?) -> String {
    let amount = carbs.complete && carbs.carbsG.isFinite ? "\(formatCarbs(carbs.carbsG)) g" : "missing data"
    guard let goal, goal.isUsable else { return amount }
    return "\(amount) · goal \(formatCarbs(goal.min))–\(formatCarbs(goal.max))"
}

/// Locale-independent carb formatting for goal text: at most one decimal, no trailing ".0".
func formatCarbs(_ value: Double) -> String {
    guard value.isFinite else { return "—" }
    var text = String(format: "%.1f", value)
    if text.hasSuffix(".0") { text.removeLast(2) }
    return text
}
