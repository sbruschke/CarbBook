import CarbBookCore
import CarbBookKit
import SwiftUI

struct FoodsView: View {
    @Environment(AppModel.self) private var app
    @State private var foods: [FoodData] = []
    @State private var query = ""
    @State private var showNew = false
    @State private var showScanner = false

    private var filtered: [FoodData] {
        query.isEmpty ? foods : foods.filter {
            $0.name.localizedCaseInsensitiveContains(query) || ($0.brand ?? "").localizedCaseInsensitiveContains(query)
        }
    }

    var body: some View {
        NavigationStack {
            List {
                ForEach(filtered, id: \.id) { food in
                    NavigationLink {
                        FoodEditorView(food: food, barcode: nil) { _ in }
                    } label: {
                        VStack(alignment: .leading) {
                            Text(food.name)
                            Text([food.brand, food.source, food.carbsPer100g.map { "\(formatNumber($0))g carbs/100g" } ?? "no carb data"]
                                .compactMap { $0 }.joined(separator: " · "))
                                .font(.caption)
                                .foregroundStyle(food.carbsPer100g == nil ? Color.orange : Color.secondary)
                        }
                    }
                    // USDA-sourced originals are never deleted (spec §3); editing one makes a custom copy instead.
                    .deleteDisabled(food.source == "usda")
                }
                .onDelete { offsets in
                    for index in offsets where filtered[index].source != "usda" {
                        try? app.delete("food", id: filtered[index].id)
                    }
                }
            }
            .overlay {
                if foods.isEmpty {
                    ContentUnavailableView("No saved foods", systemImage: "carrot",
                                           description: Text("Create one from a label, scan a barcode, or add a USDA food in the Calculator."))
                }
            }
            .searchable(text: $query)
            .navigationTitle("Foods")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button { showNew = true } label: { Image(systemName: "plus") }
                }
                ToolbarItem(placement: .topBarLeading) {
                    Button { showScanner = true } label: { Image(systemName: "barcode.viewfinder") }
                }
            }
            .sheet(isPresented: $showNew) {
                NavigationStack { FoodEditorView(food: nil, barcode: nil) { _ in showNew = false } }
            }
            .sheet(isPresented: $showScanner) {
                BarcodeFlowView { _ in }
            }
            .onAppear(perform: load)
            .onChange(of: app.revision) { load() }
        }
    }

    private func load() {
        foods = (try? app.store.foods()) ?? []
    }
}
