import CarbBookCore
import CarbBookKit
import SwiftUI

/// Edit a meal's name, yield, weight and components at any time, with live per-serving carbs (spec §8).
struct MealEditorView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let meal: MealData?

    @State private var mealId = ""
    @State private var name = ""
    @State private var yieldText = "1"
    @State private var weightText = ""
    @State private var notes = ""
    @State private var items: [MealItemData] = []
    @State private var removedItemIds: [String] = []
    @State private var base = InMemoryCatalog()
    @State private var allFoods: [FoodData] = []
    @State private var allPortions: [PortionData] = []
    @State private var allMeals: [MealData] = []
    @State private var allItems: [MealItemData] = []
    @State private var showAdd = false
    @State private var error: String?
    @State private var loaded = false

    /// The saved catalog with this meal replaced by the unsaved draft.
    private var draftCatalog: InMemoryCatalog {
        let draftMeal = MealData(id: mealId, name: name, yieldServings: parseNumber(yieldText) ?? 0,
                                 totalWeightG: parseNumber(weightText))
        return InMemoryCatalog(
            foods: allFoods, portions: allPortions,
            meals: allMeals.filter { $0.id != mealId } + [draftMeal],
            mealItems: allItems.filter { $0.mealId != mealId } + items.enumerated().map { index, item in
                var positioned = item
                positioned.position = index
                return positioned
            })
    }

    var body: some View {
        let catalog = draftCatalog
        let perServing = itemCarbs(catalog, .meal, mealId, 1, Units.serving)
        Form {
            Section {
                TextField("Name", text: $name)
                NumberField(label: "Yield", text: $yieldText, unit: "servings")
                NumberField(label: "Total weight (optional)", text: $weightText, unit: "g")
                TextField("Notes", text: $notes, axis: .vertical)
            } footer: {
                Text(perServing.complete ? "\(formatNumber(perServing.carbsG))g carbs per serving" : "Incomplete: an item is missing carb data")
                    .foregroundStyle(perServing.complete ? Color.secondary : Color.orange)
            }
            Section("Components") {
                ForEach($items, id: \.id) { $item in
                    componentRow($item, catalog: catalog)
                }
                .onMove { items.move(fromOffsets: $0, toOffset: $1) }
                .onDelete { offsets in
                    removedItemIds += offsets.map { items[$0].id }
                    items.remove(atOffsets: offsets)
                }
                Button("Add component") { showAdd = true }
            }
            if let error { Section { Text(error).foregroundStyle(.red) } }
        }
        .navigationTitle(meal == nil ? "New meal" : "Edit meal")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) { EditButton() }
            ToolbarItem(placement: .confirmationAction) { Button("Save") { save() } }
        }
        .sheet(isPresented: $showAdd) {
            AddItemSheet { hit in add(hit) }
        }
        .onAppear(perform: load)
    }

    private func componentRow(_ item: Binding<MealItemData>, catalog: InMemoryCatalog) -> some View {
        let value = item.wrappedValue
        let displayName = value.refType == .food ? catalog.food(value.refId)?.name : catalog.meal(value.refId)?.name
        let units = value.refType == .food
            ? catalog.food(value.refId).map { foodUnits($0, catalog.portions(value.refId)) } ?? [value.unit]
            : catalog.meal(value.refId).map { mealUnits($0) } ?? [value.unit]
        let carbs = itemCarbs(catalog, value.refType, value.refId, value.amount, value.unit)
        return VStack(alignment: .leading) {
            HStack {
                Text(displayName ?? "Missing \(value.refType.rawValue)")
                Spacer()
                Text(carbs.complete ? "\(formatNumber(carbs.carbsG))g" : "missing data")
                    .foregroundStyle(carbs.complete ? Color.primary : Color.orange)
            }
            HStack {
                TextField("Amount", value: item.amount, format: .number)
                    .keyboardType(.decimalPad)
                    .frame(maxWidth: 110)
                Picker("Unit", selection: item.unit) {
                    ForEach(units, id: \.self) { Text(unitLabel($0, portions: catalog.portions(value.refId))).tag($0) }
                }
                .labelsHidden()
            }
        }
    }

    private func load() {
        guard !loaded else { return }
        loaded = true
        do {
            allFoods = try app.store.records("food")
            allPortions = try app.store.records("portion")
            allMeals = try app.store.records("meal")
            allItems = try app.store.records("meal_item")
            if let meal {
                mealId = meal.id
                name = meal.name
                yieldText = formatNumber(meal.yieldServings, digits: 2)
                weightText = formatNumber(meal.totalWeightG, digits: 1)
                notes = meal.notes ?? ""
                items = try app.store.mealItems(mealId: meal.id)
            } else {
                mealId = app.store.newId()
            }
        } catch {
            self.error = "Could not load: \(error)"
        }
    }

    private func add(_ hit: SearchHit) {
        do {
            var refType = RefType.food
            var refId = hit.id
            switch hit.kind {
            case .meal:
                refType = .meal
                if wouldCreateCycle(draftCatalog, mealId, hit.id) {
                    error = "\(hit.name) already contains this meal, so it can't be a component."
                    return
                }
            case .food:
                break
            case .usda:
                guard let fdcId = hit.usdaFdcId, let usda = app.usda else { return }
                refId = try app.store.adoptUsdaFood(fdcId: fdcId, library: usda)
                allFoods = try app.store.records("food")
                allPortions = try app.store.records("portion")
            }
            let unit = refType == .meal ? Units.serving : "g"
            let amount = refType == .meal ? 1.0 : 100.0
            items.append(MealItemData(id: app.store.newId(), mealId: mealId, refType: refType, refId: refId,
                                      amount: amount, unit: unit, position: items.count))
            error = nil
        } catch {
            self.error = "Could not add \(hit.name): \(error)"
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
            var saved = meal ?? MealData(id: mealId, name: name, yieldServings: yield)
            saved.name = name.trimmingCharacters(in: .whitespaces)
            saved.yieldServings = yield
            saved.totalWeightG = weight
            saved.notes = notes.isEmpty ? nil : notes
            saved.deleted = nil
            var changes = [try SyncChange.encode("meal", saved)]
            for (index, item) in items.enumerated() {
                var positioned = item
                positioned.position = index
                positioned.deleted = nil
                changes.append(try SyncChange.encode("meal_item", positioned))
            }
            try app.save(changes)
            for id in removedItemIds { try app.delete("meal_item", id: id) }
            dismiss()
        } catch {
            self.error = "Could not save: \(error)"
        }
    }
}
