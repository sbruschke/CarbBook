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
}
