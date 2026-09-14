import CarbBookCore
import CarbBookKit
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

/// Parses user-typed amounts strictly (`NumberParsing.parseAmount`, in CarbBookKit so it has
/// Linux-runnable tests): only plain decimal digits with an optional fractional part, "," accepted
/// as the decimal separator. Malformed text (hex, exponents, "Infinity", empty…) is never silently 0.
func parseNumber(_ text: String) -> Double? {
    NumberParsing.parseAmount(text)
}

/// Whole-number-only fields (BG): rejects a typed decimal instead of rounding or truncating it.
func parseWholeNumber(_ text: String) -> Double? {
    NumberParsing.parseWholeNumber(text)
}

func formatNumber(_ value: Double, digits: Int = 1) -> String {
    value.formatted(.number.precision(.fractionLength(0...digits)))
}

func formatNumber(_ value: Double?, digits: Int = 1) -> String {
    value.map { formatNumber($0, digits: digits) } ?? ""
}

/// "p:<portion id>" → "slice (30 g)" (just the label when its weight is unknown); "floz" → "fl oz".
func unitLabel(_ unit: String, portions: [PortionData]) -> String {
    displayUnitName(unit, portions: portions)
}

/// Unit picker for a line item: valid units from core `foodUnits`/`mealUnits`, plus the current
/// unit marked "(not valid)" when it isn't one of them (the row then shows "missing data").
struct UnitPicker: View {
    @Binding var unit: String
    let units: [String]
    let portions: [PortionData]

    var body: some View {
        Picker("Unit", selection: $unit) {
            ForEach(unitPickerOptions(units: units, current: unit), id: \.unit) { option in
                Text(option.valid ? unitLabel(option.unit, portions: portions) : "\(unitLabel(option.unit, portions: portions)) (not valid)")
                    .tag(option.unit)
            }
        }
        .labelsHidden()
    }
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
