import CarbBookCore
import CarbBookKit
import SwiftUI

/// Unified search (spec §6): meals and custom foods, then saved foods by recency, then USDA.
struct AddItemSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let onPick: (SearchHit) -> Void
    @State private var query = ""
    @State private var hits: [SearchHit] = []
    @State private var error: String?

    var body: some View {
        NavigationStack {
            List {
                if let error {
                    Text(error).foregroundStyle(.red)
                }
                if query.isEmpty {
                    Text("Search meals, your foods and the USDA library.").foregroundStyle(.secondary)
                    if app.usda == nil {
                        Text(app.usdaStatus).font(.footnote).foregroundStyle(.secondary)
                    }
                }
                ForEach(hits) { hit in
                    Button {
                        onPick(hit)
                        dismiss()
                    } label: {
                        HStack {
                            Image(systemName: icon(hit.kind))
                                .foregroundStyle(.secondary)
                                .frame(width: 24)
                            VStack(alignment: .leading) {
                                Text(hit.name).foregroundStyle(.primary)
                                if let brand = hit.brand { Text(brand).font(.caption).foregroundStyle(.secondary) }
                            }
                            Spacer()
                            Text(hit.kind == .meal ? "meal" : (hit.basisText ?? "no carb data"))
                                .font(.caption)
                                .foregroundStyle(hit.basisText == nil && hit.kind != .meal ? Color.orange : Color.secondary)
                        }
                    }
                }
            }
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always))
            .onChange(of: query) { search() }
            .navigationTitle("Add item")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
        }
    }

    private func icon(_ kind: SearchHit.Kind) -> String {
        switch kind {
        case .meal: "fork.knife"
        case .food: "carrot"
        case .usda: "books.vertical"
        }
    }

    private func search() {
        do {
            hits = try app.store.search(query, limit: 40, usda: app.usda)
            error = nil
        } catch {
            self.error = "Search failed: \(error)"
        }
    }
}

struct SaveMealSheet: View {
    @Environment(\.dismiss) private var dismiss
    let onSave: (String, Double, Double?) throws -> Void
    @State private var name = ""
    @State private var yieldText = "1"
    @State private var weightText = ""
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                TextField("Meal name", text: $name)
                NumberField(label: "Yield", text: $yieldText, unit: "servings")
                NumberField(label: "Total weight (optional)", text: $weightText, unit: "g")
                if let error { Text(error).foregroundStyle(.red) }
            }
            .navigationTitle("Save as meal")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Save") { save() } }
            }
        }
    }

    private func save() {
        guard !name.trimmingCharacters(in: .whitespaces).isEmpty else { error = "Enter a name."; return }
        guard let yield = parseNumber(yieldText), yield > 0 else { error = "Yield must be more than 0 servings."; return }
        let weightTrimmed = weightText.trimmingCharacters(in: .whitespaces)
        var weight: Double?
        if !weightTrimmed.isEmpty {
            guard let parsed = parseNumber(weightText), parsed > 0 else {
                error = "Total weight must be more than 0 g or empty."
                return
            }
            weight = parsed
        }
        do {
            try onSave(name, yield, weight)
            dismiss()
        } catch {
            self.error = "Could not save: \(error)"
        }
    }
}
