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

/// Parses a non-amount number field (weights, carbs, fiber) strictly (`NumberParsing.parseNonNegative`,
/// in CarbBookKit so it has Linux-runnable tests): decimal digits, "," accepted as the decimal
/// separator, NO fractions. Malformed text (hex, exponents, "Infinity", "1/2", empty…) is never
/// silently 0. Amount fields (item amounts, yield/servings) call `NumberParsing.parseAmount` directly.
func parseNumber(_ text: String) -> Double? {
    NumberParsing.parseNonNegative(text)
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

/// A labelled grey number well (ChaosControl's ChaosInputField). `allowsFraction` is for amount
/// fields (item amounts, portion quantities, servings): it switches to a keyboard that can type "/"
/// and shows a fraction-friendly placeholder, so "2/3" can be typed directly instead of ".66667".
/// Carbs, weights, ratios, BG and dose-settings fields keep `allowsFraction: false` (the default).
struct NumberField: View {
    let label: String
    @Binding var text: String
    var unit: String = ""
    var allowsFraction: Bool = false

    var body: some View {
        HStack {
            Text(label)
            Spacer()
            TextField(allowsFraction ? "e.g. 2/3" : label, text: $text)
                .keyboardType(allowsFraction ? .numbersAndPunctuation : .decimalPad)
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

/// Goal feedback for a carb total. Colour is never the only signal: `text` always carries the
/// numbers ("68 g · goal 50–80") and `accessibilityLabel` adds the status in words (spec §3).
struct GoalStyle {
    var status: GoalStatus
    var text: String
    var color: Color
    var accessibilityLabel: String
}

/// `nil` goal or incomplete carbs still produce a style — `status` is then `.none` and the colour is
/// the ordinary secondary text colour, so callers never branch on "is there a goal".
func goalStyle(_ carbs: CarbResult, _ goal: CarbGoal?) -> GoalStyle {
    let status = goalStatus(carbs, goal)
    let text = goalText(carbs, goal)
    return GoalStyle(status: status, text: text, color: goalColor(status),
                     accessibilityLabel: status == .none ? text : "\(text), \(status.label)")
}

/// in → green, near → yellow, off → orange, out → red, none → secondary (spec §3).
func goalColor(_ status: GoalStatus) -> Color {
    switch status {
    case .none: .secondary
    case .inGoal: .green
    case .near: .yellow
    case .off: .orange
    case .out: .red
    }
}

/// One line of goal feedback: the numbers in the goal colour, with the spoken status attached.
struct GoalBadge: View {
    let style: GoalStyle
    var font: Font = .callout

    var body: some View {
        Text(style.text)
            .font(font)
            .monospacedDigit()
            .foregroundStyle(style.color)
            .accessibilityLabel(style.accessibilityLabel)
    }
}
