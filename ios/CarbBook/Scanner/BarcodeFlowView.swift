import CarbBookCore
import CarbBookKit
import SwiftUI

/// Scan → local lookup → server/Open Food Facts → confirm draft or enter manually (spec §6).
struct BarcodeFlowView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    /// Called with the saved or found food, after which the sheet closes.
    let onFood: (FoodData) -> Void

    private enum Stage {
        case scanning
        case resolving(String)
        case resolved(BarcodeResolution)
        case manual(String)
    }

    @State private var stage: Stage = .scanning
    @State private var typedCode = ""
    @State private var error: String?

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("Scan barcode")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                }
        }
    }

    @ViewBuilder private var content: some View {
        switch stage {
        case .scanning:
            VStack(spacing: 0) {
                if BarcodeScannerView.isUsable {
                    BarcodeScannerView { code in resolve(code) }
                } else {
                    ContentUnavailableView("Camera scanning unavailable", systemImage: "barcode.viewfinder",
                                           description: Text("Type the barcode digits instead."))
                }
                Form {
                    TextField("Barcode digits", text: $typedCode).keyboardType(.numberPad)
                    Button("Look up") { resolve(typedCode) }
                        .disabled(!(6...14).contains(typedCode.count) || !typedCode.allSatisfy(\.isNumber))
                    if let error { Text(error).foregroundStyle(.red) }
                }
                .frame(maxHeight: 220)
            }
        case .resolving(let code):
            ProgressView("Looking up \(code)…")
        case .resolved(let resolution):
            resolvedView(resolution)
        case .manual(let code):
            FoodEditorView(food: nil, barcode: code) { food in finish(food) }
        }
    }

    @ViewBuilder private func resolvedView(_ resolution: BarcodeResolution) -> some View {
        switch resolution {
        case .local(let food, _):
            foundView(food, note: "Saved on this phone.")
        case .known(let food, _):
            foundView(food, note: "Saved on the server; syncing it to this phone.")
        case .draft(let draft):
            OffDraftForm(draft: draft) { food in finish(food) }
        case .notFound(let code):
            manualPrompt(code, message: "No product found for \(code).")
        case .unavailable(let code, let message):
            manualPrompt(code, message: "Open Food Facts lookup failed: \(message)")
        case .queuedOffline(let code):
            manualPrompt(code, message: "You're offline. \(code) was saved to look up later.")
        case .invalid(let code):
            manualPrompt(code, message: "\"\(code)\" doesn't look like a barcode.")
        }
    }

    private func foundView(_ food: FoodData, note: String) -> some View {
        Form {
            Section {
                Text(food.name).font(.headline)
                if let brand = food.brand { Text(brand).foregroundStyle(.secondary) }
                Text(food.carbsPer100g.map { "\(formatNumber($0))g carbs per 100 g" } ?? "No carb data")
                Text(note).font(.footnote).foregroundStyle(.secondary)
            }
            Button("Use this food") {
                Task {
                    await app.coordinator.syncNow()
                    finish(food)
                }
            }
            .buttonStyle(.borderedProminent)
        }
    }

    private func manualPrompt(_ code: String, message: String) -> some View {
        Form {
            Text(message)
            Button("Enter the food from its label") { stage = .manual(code) }
                .buttonStyle(.borderedProminent)
            Button("Scan again") { stage = .scanning }
        }
    }

    private func resolve(_ code: String) {
        stage = .resolving(code)
        Task {
            do {
                stage = .resolved(try await BarcodeResolver(store: app.store, api: app.api).resolve(code))
            } catch APIError.unauthorized {
                stage = .manual(code)
            } catch {
                self.error = "Lookup failed: \(error)"
                stage = .scanning
            }
        }
    }

    private func finish(_ food: FoodData) {
        onFood(food)
        dismiss()
    }
}

/// Confirms an Open Food Facts draft. Missing carbs must be entered from the label before saving.
struct OffDraftForm: View {
    @Environment(AppModel.self) private var app
    let draft: OffDraft
    let onSaved: (FoodData) -> Void
    @State private var name = ""
    @State private var brand = ""
    @State private var carbs = ""
    @State private var fiber = ""
    @State private var error: String?

    var body: some View {
        Form {
            Section("From Open Food Facts") {
                TextField("Name", text: $name)
                TextField("Brand", text: $brand)
                NumberField(label: "Carbs", text: $carbs, unit: "g/100g")
                if draft.food.carbsPer100g == nil && parseNumber(carbs) == nil {
                    Text("Carbs missing. Enter them from the label.").foregroundStyle(.orange)
                }
                NumberField(label: "Fiber", text: $fiber, unit: "g/100g")
                if let serving = draft.servingSize { LabeledContent("Label serving", value: serving) }
                ForEach(draft.portions, id: \.label) { portion in
                    LabeledContent(portion.label, value: "\(formatNumber(portion.grams))g")
                }
                LabeledContent("Barcode", value: draft.barcode)
            }
            if let error { Text(error).foregroundStyle(.red) }
            Button("Save food") { save() }
                .buttonStyle(.borderedProminent)
        }
        .onAppear {
            name = draft.food.name
            brand = draft.food.brand ?? ""
            carbs = formatNumber(draft.food.carbsPer100g, digits: 2)
            fiber = formatNumber(draft.food.fiberPer100g, digits: 2)
        }
    }

    private func save() {
        guard let carbsValue = parseNumber(carbs), carbsValue >= 0, carbsValue <= 100 else {
            error = "Enter carbs per 100 g between 0 and 100."
            return
        }
        if let fiberValue = parseNumber(fiber) {
            guard fiberValue >= 0, fiberValue <= 100 else {
                error = "Fiber must be between 0 and 100 g per 100 g."
                return
            }
            guard fiberValue <= carbsValue else {
                error = "Fiber can't be more than carbs."
                return
            }
        } else if !fiber.trimmingCharacters(in: .whitespaces).isEmpty {
            error = "Fiber isn't a valid number."
            return
        }
        var confirmed = draft.food
        confirmed.name = name.trimmingCharacters(in: .whitespaces)
        confirmed.brand = brand.isEmpty ? nil : brand
        confirmed.carbsPer100g = carbsValue
        confirmed.fiberPer100g = parseNumber(fiber)
        let records = recordsFromOffDraft(draft, confirmed: confirmed, newId: app.store.newId)
        if let message = validateFood(records.food) {
            error = message
            return
        }
        do {
            try app.save([SyncChange.encode("food", records.food)]
                + records.portions.map { try SyncChange.encode("portion", $0) }
                + [SyncChange.encode("barcode", records.barcode)])
            onSaved(records.food)
        } catch {
            self.error = "Could not save: \(error)"
        }
    }
}
