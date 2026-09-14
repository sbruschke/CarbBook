import CarbBookCore
import SwiftUI

/// Visual language borrowed from ChaosControl: system forms, grey input wells, bordered-prominent
/// primary buttons, a large monospaced dose number and range-coloured glucose.
enum Theme {
    static let fieldBackground = Color(.systemGray6)

    static func glucoseColor(_ mgdl: Double) -> Color {
        switch mgdl {
        case ..<54: .red
        case ..<70: .purple
        case ..<180: .green
        case ..<250: .orange
        default: .red
        }
    }
}

/// Parses user-typed numbers, accepting "," as the decimal separator.
func parseNumber(_ text: String) -> Double? {
    let trimmed = text.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: ",", with: ".")
    guard !trimmed.isEmpty, let value = Double(trimmed), value.isFinite else { return nil }
    return value
}

func formatNumber(_ value: Double, digits: Int = 1) -> String {
    value.formatted(.number.precision(.fractionLength(0...digits)))
}

func formatNumber(_ value: Double?, digits: Int = 1) -> String {
    value.map { formatNumber($0, digits: digits) } ?? ""
}

/// "p:<portion id>" → the portion label; "floz" → "fl oz".
func unitLabel(_ unit: String, portions: [PortionData]) -> String {
    if unit.hasPrefix(Units.portionPrefix) {
        let id = String(unit.dropFirst(Units.portionPrefix.count))
        return portions.first(where: { $0.id == id }).map { "\($0.label) (\(formatNumber($0.grams))g)" } ?? "missing portion"
    }
    return unit == "floz" ? "fl oz" : unit
}

func nowMs() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }

func date(ms: Int64) -> Date { Date(timeIntervalSince1970: Double(ms) / 1000) }

func ms(_ date: Date) -> Int64 { Int64((date.timeIntervalSince1970 * 1000).rounded()) }

/// A labelled grey number well (ChaosControl's ChaosInputField).
struct NumberField: View {
    let label: String
    @Binding var text: String
    var unit: String = ""

    var body: some View {
        HStack {
            Text(label)
            Spacer()
            TextField(label, text: $text)
                .keyboardType(.decimalPad)
                .multilineTextAlignment(.trailing)
                .frame(maxWidth: 110)
                .padding(6)
                .background(Theme.fieldBackground)
                .clipShape(RoundedRectangle(cornerRadius: 8))
            if !unit.isEmpty {
                Text(unit).font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}
