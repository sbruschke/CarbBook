import CarbBookCore
import CarbBookKit
import SwiftUI

/// Create or edit a food and its portions. Carbs are entered per 100 g or from a label in any unit
/// (g, ml/l/tsp/tbsp/fl oz/cup, or a named piece/serving), with an optional weight. State and save
/// rules live in CarbBookKit `FoodForm` (Linux-tested); this view only binds them. Editing a USDA
/// food saves a custom copy (`derived_from` = the USDA copy's id) and leaves the original untouched.
struct FoodEditorView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let food: FoodData?
    /// Saved as a `barcode` row pointing at the new food (manual entry after a scan).
    let barcode: String?
    let onSaved: (FoodData) -> Void

    @State private var form = FoodForm(food: nil, portions: [])
    @State private var errors: [String] = []
    @State private var loaded = false

    var body: some View {
        Form {
            Section("Food") {
                TextField("Name", text: $form.name)
                TextField("Brand", text: $form.brand)
                if let summary = currentSummary {
                    LabeledContent("Saved as", value: summary)
                }
                if form.isUsdaCopy {
                    Text("Saving creates your own copy; the USDA entry stays as it is.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            carbsSection
            Section("More") {
                NumberField(label: "Fiber", text: $form.fiber, unit: "g/100g")
                NumberField(label: "Density (optional)", text: $form.density, unit: "g/ml")
                TextField("Notes", text: $form.notes, axis: .vertical)
            }
            portionsSection
            if !errors.isEmpty {
                Section {
                    ForEach(errors, id: \.self) { Text($0).foregroundStyle(.red) }
                }
            }
        }
        .navigationTitle(food == nil ? "New food" : "Edit food")
        .toolbar {
            ToolbarItem(placement: .confirmationAction) { Button("Save") { save() } }
        }
        .onAppear(perform: load)
    }

    /// "48 g carbs per cup" for the stored food (edit only).
    private var currentSummary: String? {
        guard let food else { return nil }
        return FoodLabel.basisSummary(food, (try? app.store.portions(foodId: food.id)) ?? [])
    }

    private var carbsSection: some View {
        Section {
            Picker("Carbs", selection: $form.carbsMode) {
                Text("Per 100 g").tag(FoodForm.CarbsMode.per100g)
                Text("From label").tag(FoodForm.CarbsMode.label)
            }
            .pickerStyle(.segmented)
            switch form.carbsMode {
            case .per100g:
                NumberField(label: "Carbs", text: $form.carbsText, unit: "g/100g")
                if form.carbsText.trimmingCharacters(in: .whitespaces).isEmpty {
                    Text("Carbs missing: enter them from the label").font(.footnote).foregroundStyle(.orange)
                }
            case .label:
                NumberField(label: "Amount", text: $form.labelAmount)
                Picker("Unit", selection: $form.labelUnit) {
                    ForEach(FoodLabel.units, id: \.self) { Text(FoodLabel.unitName($0)).tag($0) }
                }
                if form.labelUnit == FoodLabel.other {
                    TextField("Portion name (e.g. bar)", text: $form.labelName)
                }
                NumberField(label: "Carbs", text: $form.labelCarbs, unit: "g")
                if form.labelUnit != "g" {
                    NumberField(label: "Weighs (optional)", text: $form.labelWeight, unit: "g")
                }
                Text(form.labelResultText).font(.footnote).foregroundStyle(.secondary)
            }
            if let keptG = form.keptG {
                keptBasisRow("Also saved: \(NumberParsing.editText(keptG, maxFractionDigits: 2)) g carbs per 100 g",
                             remove: "Remove carbs per 100 g") { form.removedBaseG = true }
            }
            if let keptMl = form.keptMl {
                keptBasisRow("Also saved: \(NumberParsing.editText(keptMl, maxFractionDigits: 2)) g carbs per 100 ml",
                             remove: "Remove carbs per 100 ml") { form.removedBaseMl = true }
            }
        } header: {
            Text("Carbs")
        } footer: {
            Text("From label: amount [unit] contains N g carbs, e.g. 1 cup = 48 g, or 1 bar = 22 g.")
        }
    }

    private func keptBasisRow(_ text: String, remove: String, action: @escaping () -> Void) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(text).font(.footnote)
            Button(remove, role: .destructive, action: action).font(.footnote)
        }
    }

    private var portionsSection: some View {
        Section("Portions") {
            ForEach($form.portions) { $portion in
                VStack(alignment: .leading) {
                    Picker("Kind", selection: $portion.kind) {
                        Text("Count").tag("count")
                        Text("Serving").tag("serving")
                        Text("Volume").tag("volume")
                    }
                    .pickerStyle(.segmented)
                    .onChange(of: portion.kind) { old, new in
                        if new == "volume" && !isVolumeUnit(portion.label) { portion.label = "cup" }
                        if old == "volume" && new != "volume" { portion.label = "" }
                    }
                    if portion.kind == "volume" {
                        Picker("Unit", selection: $portion.label) {
                            ForEach(Units.volumeOrder, id: \.self) { Text(unitLabel($0, portions: [])).tag($0) }
                        }
                    } else {
                        TextField("Label (e.g. slice)", text: $portion.label)
                    }
                    NumberField(label: "Quantity", text: $portion.quantity)
                    NumberField(label: portion.kind == "volume" ? "Weighs" : "Weighs (optional)", text: $portion.grams, unit: "g")
                    if portion.kind != "volume" {
                        NumberField(label: "Carbs (optional)", text: $portion.carbsG, unit: "g")
                    }
                }
            }
            .onDelete { form.portions.remove(atOffsets: $0) }
            Button("Add portion") {
                form.portions.append(FoodForm.Portion(id: app.store.newId(), label: "", kind: "count", quantity: "1", grams: "", carbsG: ""))
            }
        }
    }

    private func load() {
        guard !loaded else { return }
        loaded = true
        let portions = food.map { (try? app.store.portions(foodId: $0.id)) ?? [] } ?? []
        form = FoodForm(food: food, portions: portions)
    }

    private func save() {
        switch form.build(newId: { app.store.newId() }) {
        case .failure(let failure):
            errors = failure.messages
        case .success(let output):
            do {
                var changes = [try SyncChange.encode("food", output.food)]
                changes += try output.portions.map { try SyncChange.encode("portion", $0) }
                if let barcode {
                    changes.append(try SyncChange.encode("barcode", BarcodeData(id: app.store.newId(), code: barcode, foodId: output.food.id)))
                }
                try app.save(changes)
                for id in output.removedPortionIds { try app.delete("portion", id: id) }
                if let barcode { try? app.store.removeQueuedBarcode(barcode) }
                errors = []
                onSaved(output.food)
                dismiss()
            } catch {
                errors = ["Could not save: \(error)"]
            }
        }
    }
}
