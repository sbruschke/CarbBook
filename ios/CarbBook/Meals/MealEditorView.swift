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
    /// Typed amount text per item id; amounts are parsed strictly (`AmountInput`), invalid → NaN.
    @State private var amountTexts: [String: String] = [:]
    @State private var removedItemIds: [String] = []
    @State private var base = InMemoryCatalog()
    @State private var allFoods: [FoodData] = []
    @State private var allPortions: [PortionData] = []
    @State private var allMeals: [MealData] = []
    @State private var allItems: [MealItemData] = []
    @State private var showAdd = false
    @State private var showQuick = false
    @State private var error: String?
    @State private var loaded = false

    /// The saved catalog with this meal replaced by the unsaved draft.
    private var draftCatalog: InMemoryCatalog {
        let draftMeal = MealData(id: mealId, name: name, yieldServings: NumberParsing.parseAmount(yieldText) ?? 0,
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
                NumberField(label: "Yield", text: $yieldText, unit: "servings", allowsFraction: true)
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
                Button("+ Carbs") { showQuick = true }
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
        .sheet(isPresented: $showQuick) {
            QuickCarbsSheet { label, grams in addQuick(label: label, grams: grams) }
        }
        .onAppear(perform: load)
    }

    @ViewBuilder
    private func componentRow(_ item: Binding<MealItemData>, catalog: InMemoryCatalog) -> some View {
        let value = item.wrappedValue
        let carbs = itemCarbs(catalog, value.refType, value.refId, value.amount, value.unit)
        if value.refType == .quick {
            QuickCarbsRow(label: Binding(get: { item.wrappedValue.label ?? "" }, set: { item.wrappedValue.label = $0 }),
                          amount: item.amount, carbs: carbs)
        } else {
            foodOrMealRow(item, catalog: catalog, carbs: carbs)
        }
    }

    private func foodOrMealRow(_ item: Binding<MealItemData>, catalog: InMemoryCatalog, carbs: CarbResult) -> some View {
        let value = item.wrappedValue
        let units = itemUnits(value.refType, value.refId, currentUnit: value.unit, catalog: catalog)
        let amountText = amountTexts[value.id] ?? AmountInput.text(for: value.amount)
        let amountBinding = Binding<String>(
            get: { amountText },
            set: { text in
                amountTexts[value.id] = text
                item.wrappedValue.amount = AmountInput.modelAmount(text)
            })
        return VStack(alignment: .leading) {
            HStack {
                Text(itemDisplayName(value.refType, value.refId, label: nil, catalog: catalog))
                Spacer()
                Text(carbs.complete ? "\(formatNumber(carbs.carbsG))g" : "missing data")
                    .foregroundStyle(carbs.complete ? Color.primary : Color.orange)
            }
            HStack {
                TextField("e.g. 2/3", text: amountBinding)
                    .keyboardType(.numbersAndPunctuation)
                    .frame(maxWidth: 110)
                UnitPicker(unit: item.unit, units: units, portions: value.refType == .food ? catalog.portions(value.refId) : [])
            }
            if AmountInput.isInvalid(amountText) {
                Text(AmountInput.invalidMessage).font(.caption).foregroundStyle(.red)
            }
        }
    }

    /// "+ Carbs": a quick component that points at itself (quick-carbs spec §2).
    private func addQuick(label: String?, grams: Double) {
        let id = app.store.newId()
        items.append(MealItemData(id: id, mealId: mealId, refType: .quick, refId: id, amount: grams,
                                  unit: Units.quick, position: items.count, label: label))
        error = nil
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
                // Plain digits: locale text like "1,200" would parse back as 1.2 (comma = decimal separator).
                yieldText = NumberParsing.editText(meal.yieldServings)
                weightText = NumberParsing.editText(meal.totalWeightG)
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
            // Foods: first valid portion, else 100 g, else 1 cup (any-unit foods).
            let initial = refType == .meal
                ? (amount: 1.0, unit: Units.serving)
                : draftCatalog.food(refId).map { defaultFoodAmountAndUnit($0, draftCatalog.portions(refId)) } ?? (amount: 100.0, unit: "g")
            let unit = initial.unit
            let amount = initial.amount
            items.append(MealItemData(id: app.store.newId(), mealId: mealId, refType: refType, refId: refId,
                                      amount: amount, unit: unit, position: items.count))
            error = nil
        } catch {
            self.error = "Could not add \(hit.name): \(error)"
        }
    }

    private func save() {
        guard !name.trimmingCharacters(in: .whitespaces).isEmpty else { error = "Enter a name."; return }
        guard let yield = NumberParsing.parseAmount(yieldText), yield > 0 else { error = "Yield must be more than 0 servings."; return }
        guard !AmountInput.hasInvalidAmount(items) else { error = "\(AmountInput.invalidMessage). Fix it before saving."; return }
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
                positioned.label = positioned.refType == .quick ? normalizeQuickLabel(positioned.label) : nil
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
