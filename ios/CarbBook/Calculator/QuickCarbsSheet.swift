import CarbBookCore
import CarbBookKit
import SwiftUI

/// "+ Carbs" (quick-carbs spec §2): grams of carbs with an optional label, no food needed.
/// Used by the Calculator, the meal editor and the plan slot editor.
struct QuickCarbsSheet: View {
    @Environment(\.dismiss) private var dismiss
    /// Label (normalized, nil when blank) and grams of carbs (already validated).
    let onAdd: (String?, Double) -> Void
    @State private var label = ""
    @State private var gramsText = ""

    private var grams: Double? { QuickCarbsInput.parse(gramsText) }

    var body: some View {
        NavigationStack {
            Form {
                TextField("Label (optional, e.g. ranch & salad)", text: $label)
                NumberField(label: "Carbs", text: $gramsText, unit: "g")
                if !gramsText.isEmpty && grams == nil {
                    Text(QuickCarbsInput.invalidMessage).font(.caption).foregroundStyle(.red)
                }
            }
            .navigationTitle("Add carbs")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add") {
                        guard let grams else { return }
                        onAdd(normalizeQuickLabel(label), grams)
                        dismiss()
                    }
                    .disabled(grams == nil)
                }
            }
        }
    }
}

/// An editable quick carbs row: "label — N g carbs", a label field and a grams field. Invalid or empty
/// grams set the amount to NaN, so the row is incomplete, no dose is shown and saving is blocked.
struct QuickCarbsRow: View {
    @Binding var label: String
    @Binding var amount: Double
    let carbs: CarbResult
    @State private var gramsText: String

    init(label: Binding<String>, amount: Binding<Double>, carbs: CarbResult) {
        _label = label
        _amount = amount
        self.carbs = carbs
        _gramsText = State(initialValue: AmountInput.text(for: amount.wrappedValue))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(QuickCarbsInput.rowText(label: label, amount: amount)).lineLimit(2)
                Spacer()
                Text(carbs.complete ? "\(formatNumber(carbs.carbsG))g" : "missing data")
                    .foregroundStyle(carbs.complete ? Color.primary : Color.orange)
                    .monospacedDigit()
            }
            HStack {
                TextField("Label (optional)", text: $label)
                    .padding(6)
                    .background(Theme.fieldBackground)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                TextField("g", text: $gramsText)
                    .keyboardType(.decimalPad)
                    .multilineTextAlignment(.trailing)
                    .padding(6)
                    .background(Theme.fieldBackground)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .frame(maxWidth: 90)
                    .onChange(of: gramsText) { _, text in amount = QuickCarbsInput.modelAmount(text) }
                Text("g carbs").font(.caption).foregroundStyle(.secondary)
            }
            if QuickCarbsInput.isInvalid(gramsText) {
                Text(QuickCarbsInput.invalidMessage).font(.caption).foregroundStyle(.red)
            }
        }
    }
}
