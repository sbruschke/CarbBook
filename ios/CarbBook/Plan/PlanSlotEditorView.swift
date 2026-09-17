import CarbBookCore
import CarbBookKit
import SwiftUI

/// Edits one plan slot with the same item picker as the Calculator (`AddItemSheet`), the same strict
/// fraction-capable amount parsing (`AmountInput`, so "2/3" works) and the same `UnitPicker`.
struct PlanSlotEditorView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let slot: PlanSlot
    let onSave: (PlanEditing.Draft) -> Void

    @State private var items: [PlanEditing.DraftItem] = []
    @State private var note = ""
    @State private var showAdd = false
    @State private var showQuick = false
    @State private var error: String?
    @State private var loaded = false
    /// Loaded once (`loadCatalog`, off the main thread) rather than re-read from the DB on every
    /// access; refreshed only after a food or meal is actually added.
    @State private var catalog = InMemoryCatalog()

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    ForEach($items) { $item in
                        if item.refType == .quick {
                            QuickCarbsRow(label: Binding(get: { $item.wrappedValue.label ?? "" },
                                                         set: { $item.wrappedValue.label = $0 }),
                                          amount: $item.amount,
                                          carbs: itemCarbs(catalog, item.refType, item.refId, item.amount, item.unit))
                        } else {
                            PlanItemRow(item: $item, name: displayName(item), units: units(for: item),
                                        portions: catalog.portions(item.refId),
                                        carbs: itemCarbs(catalog, item.refType, item.refId, item.amount, item.unit))
                        }
                    }
                    .onDelete { items.remove(atOffsets: $0) }
                    HStack {
                        Button { showAdd = true } label: { Label("Add food or meal", systemImage: "plus.circle") }
                        Spacer()
                        Button("+ Carbs") { showQuick = true }
                    }
                    .buttonStyle(.borderless)
                } header: {
                    Text("Items")
                } footer: {
                    GoalBadge(style: goalStyle(total, slot.window.carbGoal))
                }
                Section("Note") {
                    TextField("Optional note", text: $note, axis: .vertical)
                }
                if let error { Section { Text(error).foregroundStyle(.red) } }
            }
            .navigationTitle("\(slot.window.name) · \(slot.date)")
            .navigationBarTitleDisplayMode(.inline)
            .sheet(isPresented: $showAdd) {
                AddItemSheet { hit in add(hit) }
            }
            .sheet(isPresented: $showQuick) {
                QuickCarbsSheet { label, grams in
                    items.append(PlanEditing.DraftItem(id: nil, refType: .quick, refId: "", amount: grams,
                                                       unit: Units.quick, label: label))
                }
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Save") { save() } }
            }
            .onAppear(perform: load)
            .task { await loadCatalog() }
        }
    }

    /// Reads the whole catalog off the main thread; `LocalStore`'s underlying `DatabaseQueue` is
    /// safe to read from any thread.
    private func loadCatalog() async {
        let store = app.store
        catalog = await Task.detached(priority: .userInitiated) { (try? store.catalog()) ?? InMemoryCatalog() }.value
    }

    private var total: CarbResult {
        sumCarbs(items.map { itemCarbs(catalog, $0.refType, $0.refId, $0.amount, $0.unit) })
    }

    /// Plans never snapshot a display name, so it is resolved live from the catalog.
    private func displayName(_ item: PlanEditing.DraftItem) -> String {
        itemDisplayName(item.refType, item.refId, label: item.label, catalog: catalog)
    }

    private func units(for item: PlanEditing.DraftItem) -> [String] {
        itemUnits(item.refType, item.refId, currentUnit: item.unit, catalog: catalog)
    }

    private func load() {
        guard !loaded else { return }
        loaded = true
        items = slot.items.map {
            PlanEditing.DraftItem(id: $0.id, refType: $0.refType, refId: $0.refId, amount: $0.amount, unit: $0.unit,
                                  label: $0.label)
        }
        note = slot.entry?.note ?? ""
    }

    /// USDA hits are copied into the synced food table first, exactly as the Calculator does.
    private func add(_ hit: SearchHit) {
        do {
            switch hit.kind {
            case .meal:
                items.append(PlanEditing.DraftItem(id: nil, refType: .meal, refId: hit.id, amount: 1, unit: Units.serving))
            case .food:
                appendFood(id: hit.id)
            case .usda:
                guard let fdcId = hit.usdaFdcId, let usda = app.usda else { return }
                let id = try app.store.adoptUsdaFood(fdcId: fdcId, library: usda)
                app.revision += 1
                // Refresh synchronously here (not the cached `catalog`'s usual off-thread reload):
                // the adopted food must be visible immediately so `appendFood` below picks its real
                // default portion/unit instead of falling back to 100 g.
                catalog = (try? app.store.catalog()) ?? catalog
                appendFood(id: id)
            }
        } catch {
            self.error = "Could not add \(hit.name): \(error)"
        }
    }

    private func appendFood(id: Id) {
        let initial = catalog.food(id).map { defaultFoodAmountAndUnit($0, catalog.portions(id)) } ?? (amount: 100, unit: "g")
        items.append(PlanEditing.DraftItem(id: nil, refType: .food, refId: id, amount: initial.amount, unit: initial.unit))
    }

    private func save() {
        guard !items.contains(where: { !$0.amount.isFinite || $0.amount < 0 || ($0.refType == .quick && !isValidQuickCarbs($0.amount)) }) else {
            error = PlanEditing.EditError.invalidAmount.message
            return
        }
        onSave(PlanEditing.Draft(date: slot.date, windowName: slot.window.name, note: note, items: items))
        dismiss()
    }
}

/// One editable plan row. Amount text is parsed strictly with `AmountInput` (fractions allowed),
/// so empty or malformed text becomes NaN and blocks the save instead of silently keeping a number
/// the field no longer shows.
struct PlanItemRow: View {
    @Binding var item: PlanEditing.DraftItem
    let name: String
    let units: [String]
    let portions: [PortionData]
    let carbs: CarbResult
    @State private var amountText: String

    init(item: Binding<PlanEditing.DraftItem>, name: String, units: [String], portions: [PortionData], carbs: CarbResult) {
        _item = item
        self.name = name
        self.units = units
        self.portions = portions
        self.carbs = carbs
        _amountText = State(initialValue: AmountInput.text(for: item.wrappedValue.amount))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(name).lineLimit(2)
                Spacer()
                Text(carbs.complete ? "\(formatNumber(carbs.carbsG))g" : "missing data")
                    .foregroundStyle(carbs.complete ? Color.primary : Color.orange)
                    .monospacedDigit()
            }
            HStack {
                TextField("e.g. 2/3", text: $amountText)
                    .keyboardType(.numbersAndPunctuation)
                    .padding(6)
                    .background(Theme.fieldBackground)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .frame(maxWidth: 110)
                    .onChange(of: amountText) { _, text in item.amount = AmountInput.modelAmount(text) }
                UnitPicker(unit: $item.unit, units: units, portions: portions)
            }
            if AmountInput.isInvalid(amountText) {
                Text(AmountInput.invalidMessage).font(.caption).foregroundStyle(.red)
            }
        }
    }
}
