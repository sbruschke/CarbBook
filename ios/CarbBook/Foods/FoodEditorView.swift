import CarbBookCore
import CarbBookKit
import SwiftUI

/// Create or edit a food and its portions. Editing a USDA food saves a custom copy
/// (`derived_from` = the USDA copy's id) and leaves the original untouched (spec §3).
struct FoodEditorView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let food: FoodData?
    /// Saved as a `barcode` row pointing at the new food (manual entry after a scan).
    let barcode: String?
    let onSaved: (FoodData) -> Void

    private struct PortionDraft: Identifiable {
        var id: String
        var label: String
        var kind: String
        var quantity: String
        var grams: String
        var existing: Bool
    }

    private static let labelServingLabel = "label serving"

    @State private var name = ""
    @State private var brand = ""
    @State private var carbs = ""
    @State private var fiber = ""
    @State private var density = ""
    @State private var notes = ""
    @State private var servingGrams = ""
    @State private var carbsPerServing = ""
    @State private var portions: [PortionDraft] = []
    @State private var removedPortionIds: [String] = []
    @State private var error: String?
    @State private var loaded = false

    var body: some View {
        Form {
            Section("Food") {
                TextField("Name", text: $name)
                TextField("Brand", text: $brand)
                NumberField(label: "Carbs", text: $carbs, unit: "g/100g")
                NumberField(label: "Fiber", text: $fiber, unit: "g/100g")
                NumberField(label: "Density (optional)", text: $density, unit: "g/ml")
                TextField("Notes", text: $notes, axis: .vertical)
                if food?.source == "usda" {
                    Text("Saving creates your own copy; the USDA entry stays as it is.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            Section {
                NumberField(label: "Serving size", text: $servingGrams, unit: "g")
                NumberField(label: "Carbs per serving", text: $carbsPerServing, unit: "g")
                Button("Use label values") { applyLabel() }
            } header: {
                Text("From a nutrition label")
            } footer: {
                Text("Sets carbs per 100 g and adds (or updates) a \"\(Self.labelServingLabel)\" portion.")
            }
            Section("Portions") {
                ForEach($portions) { $portion in
                    VStack(alignment: .leading) {
                        Picker("Kind", selection: $portion.kind) {
                            Text("Count").tag("count")
                            Text("Serving").tag("serving")
                            Text("Volume").tag("volume")
                        }
                        .pickerStyle(.segmented)
                        if portion.kind == "volume" {
                            Picker("Unit", selection: $portion.label) {
                                ForEach(Units.volumeOrder, id: \.self) { Text(unitLabel($0, portions: [])).tag($0) }
                            }
                        } else {
                            TextField("Label (e.g. slice)", text: $portion.label)
                        }
                        NumberField(label: "Quantity", text: $portion.quantity)
                        NumberField(label: "Weighs", text: $portion.grams, unit: "g")
                    }
                }
                .onDelete { offsets in
                    removedPortionIds += offsets.map { portions[$0] }.filter(\.existing).map(\.id)
                    portions.remove(atOffsets: offsets)
                }
                Button("Add portion") {
                    portions.append(PortionDraft(id: app.store.newId(), label: "", kind: "count", quantity: "1", grams: "", existing: false))
                }
            }
            if let error {
                Section { Text(error).foregroundStyle(.red) }
            }
        }
        .navigationTitle(food == nil ? "New food" : "Edit food")
        .toolbar {
            ToolbarItem(placement: .confirmationAction) { Button("Save") { save() } }
        }
        .onAppear(perform: load)
    }

    private func load() {
        guard !loaded else { return }
        loaded = true
        guard let food else { return }
        name = food.name
        brand = food.brand ?? ""
        carbs = formatNumber(food.carbsPer100g, digits: 2)
        fiber = formatNumber(food.fiberPer100g, digits: 2)
        density = formatNumber(food.densityGPerMl, digits: 3)
        notes = food.notes ?? ""
        portions = ((try? app.store.portions(foodId: food.id)) ?? []).map {
            PortionDraft(id: $0.id, label: $0.label, kind: $0.kind, quantity: formatNumber($0.quantity, digits: 3),
                         grams: formatNumber($0.grams, digits: 2), existing: true)
        }
    }

    private func applyLabel() {
        guard let grams = parseNumber(servingGrams), let perServing = parseNumber(carbsPerServing),
              let per100 = carbsPer100gFromLabel(servingGrams: grams, carbsPerServing: perServing) else {
            error = "Serving size must be above 0 g and carbs can't exceed the serving weight."
            return
        }
        carbs = formatNumber(per100, digits: 2)
        // Re-entering label info updates the existing "label serving" portion rather than adding a
        // duplicate one.
        if let index = portions.firstIndex(where: { $0.label == Self.labelServingLabel && $0.kind == "serving" }) {
            portions[index].grams = formatNumber(grams, digits: 2)
            portions[index].quantity = "1"
        } else {
            portions.append(PortionDraft(id: app.store.newId(), label: Self.labelServingLabel, kind: "serving", quantity: "1",
                                         grams: formatNumber(grams, digits: 2), existing: false))
        }
        error = nil
    }

    private func save() {
        guard let carbsValue = parseNumber(carbs) else {
            error = carbs.trimmingCharacters(in: .whitespaces).isEmpty
                ? "Carbs per 100 g are required."
                : "Carbs isn't a valid number."
            return
        }
        let fiberText = fiber.trimmingCharacters(in: .whitespaces)
        let fiberValue: Double?
        if fiberText.isEmpty {
            fiberValue = nil
        } else if let parsed = parseNumber(fiber) {
            fiberValue = parsed
        } else {
            error = "Fiber isn't a valid number."
            return
        }
        if let fiberValue, fiberValue > carbsValue {
            error = "Fiber can't be more than carbs."
            return
        }

        let copyOfUsda = food?.source == "usda"
        var saved = food ?? FoodData(id: app.store.newId(), name: "", source: "custom", carbsPer100g: nil)
        if copyOfUsda {
            saved.derivedFrom = food?.id
            saved.id = app.store.newId()
            saved.source = "custom"
            saved.sourceRef = nil
        }
        saved.name = name.trimmingCharacters(in: .whitespaces)
        saved.brand = brand.isEmpty ? nil : brand
        saved.carbsPer100g = carbsValue
        saved.fiberPer100g = fiberValue
        let densityText = density.trimmingCharacters(in: .whitespaces)
        if densityText.isEmpty {
            saved.densityGPerMl = nil
        } else if let parsed = parseNumber(density) {
            saved.densityGPerMl = parsed
        } else {
            error = "Density isn't a valid number."
            return
        }
        saved.notes = notes.isEmpty ? nil : notes
        saved.deleted = nil
        if let message = validateFood(saved) {
            error = message
            return
        }
        var changes: [SyncChange] = []
        do {
            changes.append(try SyncChange.encode("food", saved))
            for draft in portions {
                guard let quantity = parseNumber(draft.quantity), quantity > 0,
                      let grams = parseNumber(draft.grams), grams > 0,
                      !draft.label.trimmingCharacters(in: .whitespaces).isEmpty,
                      draft.kind != "volume" || isVolumeUnit(draft.label) else {
                    error = "Every portion needs a label (a volume unit for volume portions), a quantity above 0 and grams above 0."
                    return
                }
                let id = copyOfUsda ? app.store.newId() : draft.id
                changes.append(try SyncChange.encode("portion", PortionData(
                    id: id, foodId: saved.id, label: draft.label, kind: draft.kind, quantity: quantity, grams: grams)))
            }
            if let barcode {
                changes.append(try SyncChange.encode("barcode", BarcodeData(id: app.store.newId(), code: barcode, foodId: saved.id)))
            }
            try app.save(changes)
            if !copyOfUsda {
                for id in removedPortionIds { try app.delete("portion", id: id) }
            }
            if let barcode { try? app.store.removeQueuedBarcode(barcode) }
            onSaved(saved)
            dismiss()
        } catch {
            self.error = "Could not save: \(error)"
        }
    }
}
