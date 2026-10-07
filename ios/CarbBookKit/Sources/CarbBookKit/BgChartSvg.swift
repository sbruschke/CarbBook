import CarbBookCore
import Foundation

/// BG charts as SVG strings for the PDF (BG history spec 2026-10-07). Port of the web's
/// `web/src/bg/chart.ts` — keep the two in step. The app's own screens draw with Swift Charts.
public enum BgChartSvg {
    static let width = 720.0
    static let padLeft = 34.0, padRight = 10.0, padTop = 16.0, padBottom = 20.0
    static let hourMs: Int64 = 3_600_000
    /// A gap longer than this breaks the line instead of drawing across missing data.
    static let gapMs: Int64 = 15 * 60_000

    public static func color(_ band: BgBand) -> String {
        switch band {
        case .veryLow: "#8a1418"
        case .low: "#c62828"
        case .inRange: "#2e7d32"
        case .high: "#b26a00"
        case .veryHigh: "#8a3f00"
        }
    }

    static func esc(_ text: String) -> String {
        text.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;").replacingOccurrences(of: "\"", with: "&quot;")
    }

    /// One decimal, no trailing ".0" — the same numbers the web writes.
    static func f(_ n: Double) -> String { JS.numberString((n * 10).rounded() / 10) }

    struct Scale {
        let top: Double
        let height: Double
        func y(_ mgdl: Double) -> Double {
            let plot = height - BgChartSvg.padTop - BgChartSvg.padBottom
            return BgChartSvg.padTop + plot * (1 - (Swift.min(top, Swift.max(40, mgdl)) - 40) / (top - 40))
        }
    }

    static func scale(_ values: [Double], height: Double) -> Scale {
        let highest = values.max() ?? 0
        return Scale(top: Swift.min(400, Swift.max(300, (Swift.max(0, highest) / 50).rounded(.up) * 50)), height: height)
    }

    static func frame(_ s: Scale) -> String {
        let right = width - padRight
        var ticks = [70.0, 180.0]
        if s.top >= 300 { ticks.append(300) }
        var out = "<rect x=\"\(f(padLeft))\" y=\"\(f(s.y(BgTargets.high)))\" width=\"\(f(right - padLeft))\" height=\"\(f(s.y(BgTargets.low) - s.y(BgTargets.high)))\" fill=\"#e6f4ec\"/>"
        for t in ticks {
            out += "<line x1=\"\(f(padLeft))\" x2=\"\(f(right))\" y1=\"\(f(s.y(t)))\" y2=\"\(f(s.y(t)))\" stroke=\"#c5cfc1\" stroke-width=\"1\" \(t == 300 ? "" : "stroke-dasharray=\"3 3\"")/>"
            out += "<text x=\"\(f(padLeft - 4))\" y=\"\(f(s.y(t) + 3.5))\" text-anchor=\"end\" font-size=\"10\" fill=\"#5d6b59\">\(Int(t))</text>"
        }
        out += "<line x1=\"\(f(padLeft))\" x2=\"\(f(right))\" y1=\"\(f(s.height - padBottom))\" y2=\"\(f(s.height - padBottom))\" stroke=\"#d7ddd3\"/>"
        return out
    }

    public struct Meal: Sendable {
        public var at: Int64
        public var label: String
        public init(at: Int64, label: String) { self.at = at; self.label = label }
    }

    /// A stretch of time (normally a local day): target band, reading line broken across gaps,
    /// out-of-range and lone readings dotted in their band colour, and meal markers.
    public static func day(start: Int64, end: Int64, points: [BgPoint], meals: [Meal] = [],
                           hourLabel: (Int64) -> String, height: Double = 170) -> String {
        let pts = points.filter { $0.at >= start && $0.at < end && $0.mgdl.isFinite && $0.mgdl > 0 }.sorted { $0.at < $1.at }
        let s = scale(pts.map(\.mgdl), height: height)
        let span = Double(end - start)
        let x = { (at: Int64) in padLeft + (width - padLeft - padRight) * Double(at - start) / span }

        var runs: [[BgPoint]] = []
        for p in pts {
            if let last = runs.last?.last, p.at - last.at <= gapMs { runs[runs.count - 1].append(p) } else { runs.append([p]) }
        }
        let lines = runs.filter { $0.count > 1 }.map { run in
            "<polyline points=\"\(run.map { "\(f(x($0.at))),\(f(s.y($0.mgdl)))" }.joined(separator: " "))\" fill=\"none\" stroke=\"#1c2419\" stroke-width=\"1.6\" stroke-linejoin=\"round\"/>"
        }.joined()
        let dots = runs.flatMap { run in run.filter { run.count == 1 || bgBand($0.mgdl) != .inRange } }.map {
            "<circle cx=\"\(f(x($0.at)))\" cy=\"\(f(s.y($0.mgdl)))\" r=\"1.8\" fill=\"\(color(bgBand($0.mgdl)))\"/>"
        }.joined()
        var ticks = ""
        var t = ((start + hourMs - 1) / hourMs) * hourMs
        while t < end {
            if Int(((Double(t - start)) / Double(hourMs)).rounded()) % 3 == 0 {
                ticks += "<text x=\"\(f(x(t)))\" y=\"\(f(height - 6))\" text-anchor=\"middle\" font-size=\"10\" fill=\"#5d6b59\">\(esc(hourLabel(t)))</text>"
            }
            t += hourMs
        }
        let marks = meals.filter { $0.at >= start && $0.at < end }.map { m in
            "<line x1=\"\(f(x(m.at)))\" x2=\"\(f(x(m.at)))\" y1=\"\(f(padTop))\" y2=\"\(f(height - padBottom))\" stroke=\"#1b5e20\" stroke-width=\"1\" stroke-dasharray=\"2 2\" opacity=\"0.7\"/>"
                + "<text x=\"\(f(x(m.at)))\" y=\"\(f(padTop - 4))\" text-anchor=\"middle\" font-size=\"9.5\" font-weight=\"600\" fill=\"#1b5e20\">\(esc(m.label))</text>"
        }.joined()
        let empty = pts.isEmpty ? "<text x=\"\(f(width / 2))\" y=\"\(f(height / 2))\" text-anchor=\"middle\" font-size=\"12\" fill=\"#5d6b59\">No CGM readings</text>" : ""
        return "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 \(f(width)) \(f(height))\" width=\"100%\" role=\"img\" class=\"bg-chart\">\(frame(s))\(marks)\(lines)\(dots)\(ticks)\(empty)</svg>"
    }

    /// Daily pattern: 10–90th and 25–75th percentile bands and the median line, by local hour.
    public static func pattern(_ hours: [PatternHour], hourLabel: (Int) -> String, height: Double = 190) -> String {
        let filled = hours.filter { $0.p50 != nil }
        let s = scale(filled.compactMap(\.p90), height: height)
        let x = { (hour: Double) in padLeft + (width - padLeft - padRight) * hour / 24 }
        func band(_ lo: KeyPath<PatternHour, Double?>, _ hi: KeyPath<PatternHour, Double?>, _ fill: String) -> String {
            var runs: [[PatternHour]] = []
            var run: [PatternHour] = []
            for h in hours {
                if h[keyPath: lo] == nil { if !run.isEmpty { runs.append(run) }; run = [] } else { run.append(h) }
            }
            if !run.isEmpty { runs.append(run) }
            return runs.map { r in
                let upper = r.map { "\(f(x(Double($0.hour) + 0.5))),\(f(s.y($0[keyPath: hi]!)))" }
                let lower = r.reversed().map { "\(f(x(Double($0.hour) + 0.5))),\(f(s.y($0[keyPath: lo]!)))" }
                return "<polygon points=\"\((upper + lower).joined(separator: " "))\" fill=\"\(fill)\"/>"
            }.joined()
        }
        let median = filled.map { "\(f(x(Double($0.hour) + 0.5))),\(f(s.y($0.p50!)))" }.joined(separator: " ")
        let ticks = [0, 3, 6, 9, 12, 15, 18, 21].map {
            "<text x=\"\(f(x(Double($0))))\" y=\"\(f(height - 6))\" text-anchor=\"middle\" font-size=\"10\" fill=\"#5d6b59\">\(esc(hourLabel($0)))</text>"
        }.joined()
        let empty = filled.isEmpty ? "<text x=\"\(f(width / 2))\" y=\"\(f(height / 2))\" text-anchor=\"middle\" font-size=\"12\" fill=\"#5d6b59\">Not enough readings yet</text>" : ""
        let line = filled.count > 1 ? "<polyline points=\"\(median)\" fill=\"none\" stroke=\"#1b5e20\" stroke-width=\"2\"/>" : ""
        return "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 \(f(width)) \(f(height))\" width=\"100%\" role=\"img\" class=\"bg-chart\"><title>Daily BG pattern</title>\(frame(s))\(band(\.p10, \.p90, "rgba(27,94,32,0.14)"))\(band(\.p25, \.p75, "rgba(27,94,32,0.28)"))\(line)\(ticks)\(empty)</svg>"
    }

    static let bandNames: [(BgBand, String)] = [(.veryLow, "Very low"), (.low, "Low"), (.inRange, "In range"), (.high, "High"), (.veryHigh, "Very high")]

    static func pct(_ n: Double) -> String { "\(Int((n * 100).rounded()))%" }

    /// Stacked time-in-range bar with the percentages written out.
    public static func tirBar(_ stats: BgStats) -> String {
        let segs = bandNames.filter { (stats.bands[$0.0] ?? 0) > 0 }.map { band, name in
            "<span style=\"flex:\(stats.bands[band]!);background:\(color(band))\" title=\"\(name) \(pct(stats.bands[band]!))\"></span>"
        }.joined()
        let legend = bandNames.map { band, name in
            "<span class=\"tir-key\"><i style=\"background:\(color(band))\"></i>\(name) \(pct(stats.bands[band] ?? 0))</span>"
        }.joined()
        return "<div class=\"tir\"><div class=\"tir-bar\">\(segs)</div><div class=\"tir-legend\">\(legend)</div></div>"
    }
}

/// The words behind the charts — same wording as the web (`web/src/bg/BgViews.tsx`).
public enum BgText {
    static func mg(_ n: Double) -> String { String(Int(n.rounded())) }

    /// "In range 72% · avg 148 · low 3% · high 25% · 286 readings"
    public static func statsLine(_ s: BgStats) -> String {
        let low = (s.bands[.low] ?? 0) + (s.bands[.veryLow] ?? 0)
        let high = (s.bands[.high] ?? 0) + (s.bands[.veryHigh] ?? 0)
        return ["In range \(BgChartSvg.pct(s.bands[.inRange] ?? 0))", "avg \(mg(s.mean))", "low \(BgChartSvg.pct(low))",
                "high \(BgChartSvg.pct(high))", "\(s.count) readings"].joined(separator: " · ")
    }

    /// "BG 112 → peak 210 (+55 min) · 2 h after 180", "BG 163 → no rise · …", or nil without data.
    public static func mealResponse(_ r: MealResponse) -> String? {
        var parts: [String] = []
        if let before = r.before, let rise = r.rise, rise <= 0 {
            parts.append("BG \(mg(before)) → no rise")
        } else if let before = r.before {
            parts.append("BG \(mg(before))" + (r.peak.map { " → peak \(mg($0)) (+\(r.peakMinutes ?? 0) min)" } ?? ""))
        } else if let peak = r.peak {
            parts.append("peak \(mg(peak)) (+\(r.peakMinutes ?? 0) min)")
        }
        if let twoHour = r.twoHour { parts.append("2 h after \(mg(twoHour))") }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}
