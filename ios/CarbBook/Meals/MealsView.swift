import CarbBookCore
import CarbBookKit
import SwiftUI

struct MealsView: View {
    @Environment(AppModel.self) private var app
    @State private var meals: [MealData] = []
    @State private var catalog = InMemoryCatalog()
    @State private var showNew = false

    var body: some View {
        NavigationStack {
            List {
                ForEach(meals, id: \.id) { meal in
                    NavigationLink {
                        MealEditorView(meal: meal)
                    } label: {
                        let perServing = itemCarbs(catalog, .meal, meal.id, 1, Units.serving)
                        HStack {
                            // The row already has the meal, so its image needs no second lookup.
                            ImageThumbView(imageID: meal.imageId)
                            VStack(alignment: .leading) {
                                Text(meal.name)
                                Text(perServing.complete
                                     ? "\(formatNumber(perServing.carbsG))g per serving · yields \(formatNumber(meal.yieldServings))"
                                     : "incomplete carb data")
                                    .font(.caption)
                                    .foregroundStyle(perServing.complete ? Color.secondary : Color.orange)
                            }
                        }
                    }
                }
                .onDelete { offsets in
                    for index in offsets { try? app.delete("meal", id: meals[index].id) }
                }
            }
            .overlay {
                if meals.isEmpty {
                    ContentUnavailableView("No meals", systemImage: "fork.knife",
                                           description: Text("Build one here or use Save as meal in the Calculator."))
                }
            }
            .navigationTitle("Meals")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button { showNew = true } label: { Image(systemName: "plus") }
                }
            }
            .sheet(isPresented: $showNew) {
                NavigationStack { MealEditorView(meal: nil) }
            }
            .onAppear(perform: load)
            .onChange(of: app.revision) { load() }
        }
    }

    private func load() {
        meals = (try? app.store.meals()) ?? []
        catalog = (try? app.store.catalog()) ?? InMemoryCatalog()
    }
}
