import CarbBookCore
import CarbBookKit
import Charts
import SwiftUI

/// CGM history on screen (BG history spec 2026-10-07): the Log day chart, after-meal BG on an
/// entry, and the trends screen. Display only — nothing here feeds a dose. Online only: the
/// readings live in dexcom-api on the Pi, not in the synced tables.

/// Loaded readings, or why there are none.
enum BgLoad: Equatable {
    case loading
    case loaded(BgHistory)
    case failed(String)
}

@MainActor
func loadBg(_ app: AppModel, from: Date, to: Date) async -> BgLoad {
    do {
        return .loaded(try await app.api.bgReadings(fromMs: ms(from), toMs: ms(to)))
    } catch {
        return .failed("BG history needs a connection, or is unavailable right now.")
    }
}

func bandColor(_ band: BgBand) -> Color {
    switch band {
    case .veryLow: Color(red: 0.54, green: 0.08, blue: 0.09)
    case .low: .red
    case .inRange: .green
    case .high: .orange
    case .veryHigh: Color(red: 0.54, green: 0.25, blue: 0)
    }
}

/// Readings as a line broken across gaps longer than 15 min, the 70–180 band, out-of-range dots,
/// and meal markers labelled with their carbs.
struct BgChart: View {
    let start: Date
    let end: Date
    let points: [BgPoint]
    var meals: [(at: Date, label: String)] = []
    var height: CGFloat = 170

    private struct Run: Identifiable {
        let id: Int
        let points: [BgPoint]
    }

    private var runs: [Run] {
        var out: [[BgPoint]] = []
        for p in points.sorted(by: { $0.at < $1.at }) {
            if let last = out.last?.last, p.at - last.at <= 15 * 60_000 { out[out.count - 1].append(p) } else { out.append([p]) }
        }
        return out.enumerated().map { Run(id: $0.offset, points: $0.element) }
    }

    private var top: Double {
        min(400, max(300, ((points.map(\.mgdl).max() ?? 0) / 50).rounded(.up) * 50))
    }

    var body: some View {
        Chart {
            RectangleMark(xStart: .value("Start", start), xEnd: .value("End", end),
                          yStart: .value("Low", BgTargets.low), yEnd: .value("High", BgTargets.high))
                .foregroundStyle(.green.opacity(0.12))
            ForEach(meals.indices, id: \.self) { i in
                RuleMark(x: .value("Meal", meals[i].at))
                    .foregroundStyle(.green.opacity(0.6))
                    .lineStyle(StrokeStyle(lineWidth: 1, dash: [2, 2]))
                    .annotation(position: .top, alignment: .center) {
                        Text(meals[i].label).font(.caption2.bold()).foregroundStyle(.green)
                    }
            }
            ForEach(runs) { run in
                ForEach(run.points, id: \.at) { p in
                    LineMark(x: .value("Time", date(ms: p.at)), y: .value("mg/dL", min(top, max(40, p.mgdl))),
                             series: .value("Run", run.id))
                        .foregroundStyle(.primary)
                        .lineStyle(StrokeStyle(lineWidth: 1.6))
                }
            }
            ForEach(runs.flatMap { run in run.points.filter { run.points.count == 1 || bgBand($0.mgdl) != .inRange } }, id: \.at) { p in
                PointMark(x: .value("Time", date(ms: p.at)), y: .value("mg/dL", min(top, max(40, p.mgdl))))
                    .foregroundStyle(bandColor(bgBand(p.mgdl)))
                    .symbolSize(14)
            }
        }
        .chartXScale(domain: start...end)
        .chartYScale(domain: 40...top)
        .chartYAxis {
            AxisMarks(position: .leading, values: [70.0, 180, 300].filter { $0 <= top }) { _ in
                AxisGridLine()
                AxisValueLabel()
            }
        }
        .chartXAxis {
            AxisMarks(values: .stride(by: .hour, count: end.timeIntervalSince(start) > 6 * 3600 ? 3 : 1)) { _ in
                AxisGridLine()
                AxisValueLabel(format: .dateTime.hour())
            }
        }
        .frame(height: height)
        .accessibilityLabel("BG chart")
    }
}

/// The Log day's chart and its stats in words.
struct BgDaySection: View {
    @Environment(AppModel.self) private var app
    let day: Date
    let entries: [LogEntryData]
    @State private var load: BgLoad = .loading

    private var start: Date { Calendar.current.startOfDay(for: day) }
    private var end: Date { Calendar.current.date(byAdding: .day, value: 1, to: start)! }

    var body: some View {
        Section("Blood sugar") {
            switch load {
            case .loading:
                Text("Loading BG…").foregroundStyle(.secondary)
            case .failed(let message):
                Text(message).foregroundStyle(.secondary)
            case .loaded(let history):
                if let stats = bgStats(history.readings, spanMs: end.timeIntervalSince(start) * 1000) {
                    BgChart(start: start, end: end, points: history.readings,
                            meals: entries.map { (at: date(ms: $0.eatenAt), label: "\(formatNumber($0.totalCarbsG, digits: 0)) g") })
                        .padding(.top, 8)
                    Text(BgText.statsLine(stats)).font(.caption).foregroundStyle(.secondary)
                } else if let earliest = history.earliestAt, ms(end) <= earliest {
                    Text("BG history starts later than this day.").foregroundStyle(.secondary)
                } else {
                    Text("No CGM readings this day.").foregroundStyle(.secondary)
                }
            }
        }
        .task(id: start) {
            load = .loading
            load = await loadBg(app, from: start, to: end)
        }
    }
}

/// After-meal BG for one log entry, or nothing when there is no data.
struct MealBgSection: View {
    @Environment(AppModel.self) private var app
    let eatenAt: Date
    @State private var load: BgLoad = .loading

    private var from: Date { eatenAt.addingTimeInterval(-20 * 60) }
    private var to: Date { eatenAt.addingTimeInterval(3 * 3600 + 60) }

    var body: some View {
        Group {
            if case .loaded(let history) = load, !history.readings.isEmpty,
               let text = BgText.mealResponse(mealResponse(history.readings, eatenAt: ms(eatenAt))) {
                Section("BG after this meal") {
                    BgChart(start: from, end: to, points: history.readings, meals: [(at: eatenAt, label: "ate")], height: 130)
                        .padding(.top, 8)
                    Text(text).font(.callout)
                }
            }
        }
        .task(id: eatenAt) { load = await loadBg(app, from: from, to: to) }
    }
}

/// Trends over a range: time in range, the usual summary numbers, the daily pattern, and how
/// each meal window tends to go.
struct BgTrendsView: View {
    @Environment(AppModel.self) private var app
    @State private var days = 14
    @State private var load: BgLoad = .loading
    @State private var entries: [LogEntryData] = []

    private var end: Date { Calendar.current.date(byAdding: .day, value: 1, to: Calendar.current.startOfDay(for: Date()))! }
    private var start: Date { Calendar.current.date(byAdding: .day, value: -days, to: end)! }

    private struct WindowRow: Identifiable {
        var id: String { name }
        let name: String
        var meals = 0
        var carbs = 0.0
        var rises: [Double] = []
        var twoHours: [Double] = []
    }

    var body: some View {
        List {
            Section {
                Picker("Range", selection: $days) {
                    ForEach([7, 14, 30, 90], id: \.self) { Text("\($0) days").tag($0) }
                }
                .pickerStyle(.segmented)
            }
            switch load {
            case .loading:
                Text("Loading BG…").foregroundStyle(.secondary)
            case .failed(let message):
                Text(message).foregroundStyle(.secondary)
            case .loaded(let history):
                content(history)
            }
        }
        .navigationTitle("BG trends")
        .task(id: days) {
            load = .loading
            entries = (try? app.store.logEntries(from: ms(start), to: ms(end))) ?? []
            load = await loadBg(app, from: start, to: end)
        }
    }

    @ViewBuilder
    private func content(_ history: BgHistory) -> some View {
        let covered = max(ms(start), min(ms(end), history.earliestAt ?? ms(end)))
        if let earliest = history.earliestAt, earliest > ms(start) {
            Text("BG history starts \(date(ms: earliest).formatted(.dateTime.month(.abbreviated).day())). Older readings can be imported from a Dexcom Clarity export.")
                .font(.footnote).foregroundStyle(.secondary)
        }
        if let stats = bgStats(history.readings, spanMs: Double(ms(end) - covered)) {
            Section("Time in range (70–180)") {
                TirBar(stats: stats)
                LabeledContent("Average", value: "\(formatNumber(stats.mean, digits: 0)) mg/dL")
                LabeledContent("GMI", value: "\(formatNumber(stats.gmi, digits: 1))%")
                LabeledContent("Variability (CV)", value: "\(formatNumber(stats.cv, digits: 0))% · \(stats.cv <= 36 ? "stable" : "variable")")
                LabeledContent("Sensor data", value: "\(formatNumber(stats.coverage * 100, digits: 0))%")
                if stats.coverage < 0.7 {
                    Text("Under 70% sensor data — treat these numbers as rough.").font(.footnote).foregroundStyle(.secondary)
                }
            }
            Section {
                PatternChart(hours: dailyPattern(history.readings) { Calendar.current.component(.hour, from: date(ms: $0)) })
            } header: {
                Text("Daily pattern")
            } footer: {
                Text("Line: median by hour. Bands: middle 50% and 80% of readings.")
            }
            let rows = windowRows(history.readings)
            if !rows.isEmpty {
                Section("After meals") {
                    ForEach(rows) { row in
                        VStack(alignment: .leading, spacing: 2) {
                            Text("\(row.name) · \(row.meals) logged · avg \(formatNumber(row.carbs / Double(row.meals), digits: 0)) g")
                            Text([
                                average(row.rises).map { "avg rise +\(formatNumber($0, digits: 0))" },
                                average(row.twoHours).map { "avg 2 h after \(formatNumber($0, digits: 0))" },
                            ].compactMap { $0 }.joined(separator: " · ").ifEmpty("no CGM data around these meals"))
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            }
        } else {
            Text("No CGM readings in this range.").foregroundStyle(.secondary)
        }
    }

    private func average(_ values: [Double]) -> Double? {
        values.isEmpty ? nil : values.reduce(0, +) / Double(values.count)
    }

    private func windowRows(_ points: [BgPoint]) -> [WindowRow] {
        var rows: [String: WindowRow] = [:]
        var order: [String] = []
        for entry in entries.sorted(by: { $0.eatenAt < $1.eatenAt }) {
            let name = entry.windowName ?? "Other"
            if rows[name] == nil { order.append(name); rows[name] = WindowRow(name: name) }
            rows[name]!.meals += 1
            rows[name]!.carbs += entry.totalCarbsG.isFinite ? entry.totalCarbsG : 0
            let r = mealResponse(points, eatenAt: entry.eatenAt)
            if let rise = r.rise { rows[name]!.rises.append(rise) }
            if let twoHour = r.twoHour { rows[name]!.twoHours.append(twoHour) }
        }
        return order.compactMap { rows[$0] }
    }
}

private extension String {
    func ifEmpty(_ fallback: String) -> String { isEmpty ? fallback : self }
}

/// Stacked time-in-range bar with the percentages written out (colour is never the only signal).
struct TirBar: View {
    let stats: BgStats
    private let bands: [(BgBand, String)] = [(.veryLow, "Very low"), (.low, "Low"), (.inRange, "In range"), (.high, "High"), (.veryHigh, "Very high")]

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            GeometryReader { geo in
                HStack(spacing: 0) {
                    ForEach(bands.indices, id: \.self) { i in
                        Rectangle().fill(bandColor(bands[i].0)).frame(width: geo.size.width * (stats.bands[bands[i].0] ?? 0))
                    }
                }
            }
            .frame(height: 14)
            .clipShape(RoundedRectangle(cornerRadius: 4))
            Text(bands.map { "\($0.1) \(formatNumber((stats.bands[$0.0] ?? 0) * 100, digits: 0))%" }.joined(separator: " · "))
                .font(.caption).foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }
}

/// The daily pattern: 10–90th and 25–75th percentile bands and the median, by hour of day.
struct PatternChart: View {
    let hours: [PatternHour]

    var body: some View {
        let filled = hours.filter { $0.p50 != nil }
        let top = min(400, max(300, ((filled.compactMap(\.p90).max() ?? 0) / 50).rounded(.up) * 50))
        if filled.isEmpty {
            Text("Not enough readings yet").foregroundStyle(.secondary)
        } else {
            Chart {
                RectangleMark(xStart: .value("Start", 0.0), xEnd: .value("End", 24.0),
                              yStart: .value("Low", BgTargets.low), yEnd: .value("High", BgTargets.high))
                    .foregroundStyle(.green.opacity(0.1))
                ForEach(filled, id: \.hour) { h in
                    AreaMark(x: .value("Hour", Double(h.hour) + 0.5), yStart: .value("p10", h.p10!), yEnd: .value("p90", h.p90!),
                             series: .value("Band", "80"))
                        .foregroundStyle(.green.opacity(0.18))
                    AreaMark(x: .value("Hour", Double(h.hour) + 0.5), yStart: .value("p25", h.p25!), yEnd: .value("p75", h.p75!),
                             series: .value("Band", "50"))
                        .foregroundStyle(.green.opacity(0.32))
                    LineMark(x: .value("Hour", Double(h.hour) + 0.5), y: .value("Median", h.p50!))
                        .foregroundStyle(.green)
                        .lineStyle(StrokeStyle(lineWidth: 2))
                }
            }
            .chartXScale(domain: 0.0...24.0)
            .chartYScale(domain: 40...top)
            .chartXAxis {
                AxisMarks(values: [0.0, 6, 12, 18, 24]) { value in
                    AxisGridLine()
                    AxisValueLabel {
                        if let hour = value.as(Double.self) {
                            Text(Calendar.current.date(bySettingHour: Int(hour) % 24, minute: 0, second: 0, of: Date())!,
                                 format: .dateTime.hour())
                        }
                    }
                }
            }
            .chartYAxis { AxisMarks(position: .leading, values: [70.0, 180, 300].filter { $0 <= top }) }
            .frame(height: 190)
            .padding(.top, 8)
        }
    }
}
