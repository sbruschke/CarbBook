import Foundation

/// CGM history maths for charts and trends (BG history spec 2026-10-07) — mirror of TS core
/// `bg.ts`, shared vectors `testdata/bg-stats-vectors.json`. Display only: never fed to a dose.
/// Bands are the international consensus CGM targets: very low < 54, low 54–69, in range 70–180,
/// high 181–250, very high > 250 mg/dL.
public enum BgTargets {
    public static let veryLow = 54.0
    public static let low = 70.0
    public static let high = 180.0
    public static let veryHigh = 250.0
    /// Dexcom produces one reading every 5 minutes.
    public static let intervalMs = 5.0 * 60 * 1000
}

public struct BgPoint: Codable, Equatable, Sendable {
    /// ms since epoch
    public var at: Int64
    public var mgdl: Double

    public init(at: Int64, mgdl: Double) {
        self.at = at; self.mgdl = mgdl
    }
}

public enum BgBand: String, Codable, CaseIterable, Sendable {
    case veryLow = "very_low"
    case low
    case inRange = "in_range"
    case high
    case veryHigh = "very_high"
}

public func bgBand(_ mgdl: Double) -> BgBand {
    if mgdl < BgTargets.veryLow { return .veryLow }
    if mgdl < BgTargets.low { return .low }
    if mgdl <= BgTargets.high { return .inRange }
    if mgdl <= BgTargets.veryHigh { return .high }
    return .veryHigh
}

public struct BgStats: Equatable, Sendable {
    public var count: Int
    /// Readings received ÷ readings expected over the span, 0...1.
    public var coverage: Double
    public var mean: Double
    /// Population standard deviation.
    public var sd: Double
    /// Coefficient of variation, percent. Consensus target ≤ 36.
    public var cv: Double
    /// Glucose management indicator, percent: 3.31 + 0.02392 × mean mg/dL.
    public var gmi: Double
    public var min: Double
    public var max: Double
    /// Fraction of readings in each band; they sum to 1.
    public var bands: [BgBand: Double]

    public init(count: Int, coverage: Double, mean: Double, sd: Double, cv: Double, gmi: Double, min: Double, max: Double,
                bands: [BgBand: Double]) {
        self.count = count; self.coverage = coverage; self.mean = mean; self.sd = sd; self.cv = cv; self.gmi = gmi
        self.min = min; self.max = max; self.bands = bands
    }
}

private func usable(_ points: [BgPoint]) -> [BgPoint] {
    points.filter { $0.mgdl.isFinite && $0.mgdl > 0 }
}

/// Stats over readings covering `spanMs` of time; nil when there are none.
public func bgStats(_ points: [BgPoint], spanMs: Double) -> BgStats? {
    let values = usable(points).map(\.mgdl)
    guard !values.isEmpty else { return nil }
    let count = Double(values.count)
    let mean = values.reduce(0, +) / count
    let sd = (values.reduce(0) { $0 + ($1 - mean) * ($1 - mean) } / count).squareRoot()
    var bands = Dictionary(uniqueKeysWithValues: BgBand.allCases.map { ($0, 0.0) })
    for value in values { bands[bgBand(value), default: 0] += 1 }
    for band in BgBand.allCases { bands[band]! /= count }
    let expected = spanMs > 0 ? spanMs / BgTargets.intervalMs : count
    return BgStats(count: values.count, coverage: Swift.min(1, count / expected), mean: mean, sd: sd,
                   cv: mean > 0 ? sd / mean * 100 : 0, gmi: 3.31 + 0.02392 * mean,
                   min: values.min()!, max: values.max()!, bands: bands)
}

public struct MealResponse: Codable, Equatable, Sendable {
    /// Latest reading from 15 min before to 5 min after eating.
    public var before: Double?
    /// The reading closest to 2 h after eating, if one is within 10 min of it.
    public var twoHour: Double?
    /// Highest reading in the 3 h after eating.
    public var peak: Double?
    /// Minutes from eating to that peak.
    public var peakMinutes: Int?
    /// peak − before, when both exist.
    public var rise: Double?

    public init(before: Double?, twoHour: Double?, peak: Double?, peakMinutes: Int?, rise: Double?) {
        self.before = before; self.twoHour = twoHour; self.peak = peak; self.peakMinutes = peakMinutes; self.rise = rise
    }

    enum CodingKeys: String, CodingKey {
        case before, peak, rise
        case twoHour = "two_hour"
        case peakMinutes = "peak_minutes"
    }
}

private let minute: Int64 = 60_000

/// How BG moved after a meal eaten at `eatenAt`. Every field is nil when the data isn't there.
public func mealResponse(_ points: [BgPoint], eatenAt: Int64) -> MealResponse {
    let pts = usable(points)
    let before = pts.filter { $0.at >= eatenAt - 15 * minute && $0.at <= eatenAt + 5 * minute }.max { $0.at < $1.at }
    let target = eatenAt + 120 * minute
    let near = pts.filter { abs($0.at - target) <= 10 * minute }
        .min { (abs($0.at - target), $0.at) < (abs($1.at - target), $1.at) }
    var peak: BgPoint?
    for p in pts where p.at > eatenAt && p.at <= eatenAt + 180 * minute {
        if let current = peak, !(p.mgdl > current.mgdl || (p.mgdl == current.mgdl && p.at < current.at)) { continue }
        peak = p
    }
    return MealResponse(
        before: before?.mgdl, twoHour: near?.mgdl, peak: peak?.mgdl,
        peakMinutes: peak.map { Int((Double($0.at - eatenAt) / Double(minute)).rounded()) },
        rise: peak.flatMap { p in before.map { p.mgdl - $0.mgdl } })
}

public struct PatternHour: Equatable, Sendable {
    public var hour: Int
    public var count: Int
    /// 10th, 25th, 50th, 75th, 90th percentiles; nil with fewer than 3 readings in the hour.
    public var p10: Double?
    public var p25: Double?
    public var p50: Double?
    public var p75: Double?
    public var p90: Double?

    public init(hour: Int, count: Int, p10: Double?, p25: Double?, p50: Double?, p75: Double?, p90: Double?) {
        self.hour = hour; self.count = count; self.p10 = p10; self.p25 = p25; self.p50 = p50; self.p75 = p75; self.p90 = p90
    }
}

/// Linear-interpolated percentile of sorted values (the common "type 7" definition).
public func percentile(_ sorted: [Double], _ p: Double) -> Double {
    guard !sorted.isEmpty else { return .nan }
    let rank = Double(sorted.count - 1) * p
    let lo = Int(rank.rounded(.down)), hi = Int(rank.rounded(.up))
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - Double(lo))
}

/// The daily pattern: readings grouped by local hour of day. `hourOf` is the platform's local hour.
public func dailyPattern(_ points: [BgPoint], hourOf: (Int64) -> Int) -> [PatternHour] {
    var byHour = Array(repeating: [Double](), count: 24)
    for p in usable(points) {
        let hour = hourOf(p.at)
        if (0..<24).contains(hour) { byHour[hour].append(p.mgdl) }
    }
    return byHour.enumerated().map { hour, values in
        let sorted = values.sorted()
        let q = { (p: Double) -> Double? in sorted.count >= 3 ? percentile(sorted, p) : nil }
        return PatternHour(hour: hour, count: sorted.count, p10: q(0.1), p25: q(0.25), p50: q(0.5), p75: q(0.75), p90: q(0.9))
    }
}
