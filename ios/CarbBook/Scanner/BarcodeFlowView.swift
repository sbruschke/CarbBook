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
        case .local(let food, let portions):
            foundView(food, portions: portions, note: "Saved on this phone.")
        case .known(let food, let portions):
            foundView(food, portions: portions, note: "Saved on the server; syncing it to this phone.")
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

    private func foundView(_ food: FoodData, portions: [PortionData], note: String) -> some View {
        Form {
            Section {
                Text(food.name).font(.headline)
                if let brand = food.brand { Text(brand).foregroundStyle(.secondary) }
                Text(FoodLabel.basisSummary(food, portions) ?? "No carb data")
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

/// Confirms an Open Food Facts draft: carbs per serving when OFF lists a serving weight, else per 100 g.
/// Missing carbs must be entered from the label before saving. Rules live in CarbBookKit `OffDraftEntry`.
struct OffDraftForm: View {
    @Environment(AppModel.self) private var app
    let onSaved: (FoodData) -> Void
    @State private var entry: OffDraftEntry
    @State private var errors: [String] = []

    init(draft: OffDraft, onSaved: @escaping (FoodData) -> Void) {
        self.onSaved = onSaved
        _entry = State(initialValue: OffDraftEntry(draft: draft))
    }

    var body: some View {
        Form {
            Section("From Open Food Facts") {
                TextField("Name", text: $entry.name)
                TextField("Brand", text: $entry.brand)
                if let grams = entry.servingGrams {
                    LabeledContent("Serving", value: "1 serving (\(NumberParsing.editText(grams, maxFractionDigits: 2)) g)")
                    NumberField(label: "Carbs per serving", text: $entry.carbs, unit: "g")
                    if let per100g = entry.per100gText { Text(per100g).font(.footnote).foregroundStyle(.secondary) }
                } else {
                    NumberField(label: "Carbs", text: $entry.carbs, unit: "g/100g")
                }
                if entry.carbsMissing {
                    Text("Carbs missing. Enter them from the label.").foregroundStyle(.orange)
                }
                NumberField(label: "Fiber", text: $entry.fiber, unit: "g/100g")
                if let serving = entry.draft.servingSize { LabeledContent("Label serving", value: serving) }
                LabeledContent("Barcode", value: entry.draft.barcode)
            }
            ForEach(errors, id: \.self) { Text($0).foregroundStyle(.red) }
            Button("Save food") { save() }
                .buttonStyle(.borderedProminent)
        }
    }

    private func save() {
        switch entry.build(newId: { app.store.newId() }) {
        case .failure(let failure):
            errors = failure.messages
        case .success(let records):
            do {
                try app.save([SyncChange.encode("food", records.food)]
                    + records.portions.map { try SyncChange.encode("portion", $0) }
                    + [SyncChange.encode("barcode", records.barcode)])
                onSaved(records.food)
            } catch {
                errors = ["Could not save: \(error)"]
            }
        }
    }
}
