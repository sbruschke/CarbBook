import CarbBookCore
import CarbBookKit
import SwiftUI

struct CalculatorView: View {
    @Environment(AppModel.self) private var app
    @State private var model = CalculatorModel()
    @State private var showAdd = false
    @State private var showScanner = false
    @State private var showSaveMeal = false

    var body: some View {
        NavigationStack {
            Form {
                itemsSection
                bgSection
                timeSection
                doseSection
                actionsSection
            }
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle("Calculator")
            .sheet(isPresented: $showAdd) {
                AddItemSheet { hit in
                    do { try model.add(hit, app) } catch { model.message = "Could not add \(hit.name): \(error)" }
                }
            }
            .sheet(isPresented: $showScanner) {
                BarcodeFlowView { food in
                    model.reload(app)
                    model.addFood(id: food.id, name: food.name)
                    model.recompute(app)
                }
            }
            .sheet(isPresented: $showSaveMeal) {
                SaveMealSheet { name, yield, weight in
                    try model.saveMeal(name: name, yieldServings: yield, totalWeightG: weight, app)
                }
            }
            .alert(model.message ?? "", isPresented: Binding(get: { model.message != nil }, set: { if !$0 { model.message = nil } })) {
                Button("OK", role: .cancel) {}
            }
            .onAppear { model.reload(app) }
            .task { await model.refreshBg(app) }
            .onChange(of: app.revision) { model.reload(app) }
            .onChange(of: model.lines) { model.recompute(app) }
            .onChange(of: model.manualBg) { model.recompute(app) }
            .onChange(of: model.windowOverride) { model.recompute(app) }
            .onChange(of: model.useNow) { model.recompute(app) }
            .onChange(of: model.eatenAt) { if !model.useNow { model.recompute(app) } }
        }
    }

    private var itemsSection: some View {
        Section {
            ForEach($model.lines) { $line in
                LineRow(line: $line, units: model.units(for: line), portions: model.catalog.portions(line.refId),
                        carbs: model.carbs(for: line))
            }
            .onDelete { model.lines.remove(atOffsets: $0) }
            HStack {
                Button { showAdd = true } label: { Label("Add food or meal", systemImage: "plus.circle") }
                Spacer()
                Button { showScanner = true } label: { Label("Scan", systemImage: "barcode.viewfinder") }
            }
            .buttonStyle(.borderless)
        } header: {
            Text("Items")
        } footer: {
            if let total = model.result?.total, !model.lines.isEmpty {
                Text("Total \(formatNumber(total.carbsG))g carbs" + (total.complete ? "" : " (incomplete: some items are missing carb data)"))
                    .foregroundStyle(total.complete ? Color.secondary : Color.orange)
            }
        }
    }

    private var bgSection: some View {
        Section("Blood glucose") {
            if case .dexcom(let mgdl, let trend) = model.dexcom {
                HStack {
                    Text(formatNumber(mgdl, digits: 0))
                        .font(.system(size: 32, weight: .bold, design: .monospaced))
                        .foregroundStyle(Theme.glucoseColor(mgdl))
                    Text("mg/dL \(trend ?? "")").foregroundStyle(.secondary)
                }
            } else {
                NumberField(label: "BG", text: $model.manualBg, unit: "mg/dL")
                if model.manualBgIsInvalid {
                    Text("Invalid BG. Enter a whole number of mg/dL.").font(.caption).foregroundStyle(.red)
                }
            }
            Text(model.bgNote).font(.footnote).foregroundStyle(.secondary)
            Button("Refresh Dexcom") { Task { await model.refreshBg(app) } }
                .buttonStyle(.borderless)
        }
    }

    private var timeSection: some View {
        Section("Time and window") {
            Toggle("Eating now", isOn: $model.useNow)
            if !model.useNow {
                DatePicker("Eaten at", selection: $model.eatenAt)
            }
            Picker("Window", selection: $model.windowOverride) {
                Text("Auto" + (model.result?.estimate?.window.map { " (\($0.name))" } ?? "")).tag(String?.none)
                ForEach(model.activeSettings?.windows ?? [], id: \.name) { window in
                    Text("\(window.name) · 1:\(formatNumber(window.ratioGPerUnit))").tag(Optional(window.name))
                }
            }
        }
    }

    private var doseSection: some View {
        Section {
            if case .ok(let suggestion)? = model.result?.estimate {
                Text("\(formatNumber(suggestion.units, digits: 2))u")
                    .font(.system(size: 48, weight: .bold, design: .monospaced))
                    .frame(maxWidth: .infinity, alignment: .center)
                Text(model.result?.breakdown ?? "")
                    .font(.callout.monospaced())
            } else if !model.lines.isEmpty {
                Label(model.result?.refusal ?? "Can't estimate — check your numbers.", systemImage: "exclamationmark.circle")
                    .foregroundStyle(.orange)
            } else {
                Text("Add items to see a dose estimate.").foregroundStyle(.secondary)
            }
            if model.result?.recentDoseWarning == true {
                Label("A dose was logged in the last 4 hours. Insulin on board is not subtracted.", systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(.red)
            }
            NumberField(label: "Taken (units)", text: $model.taken, unit: "u")
            TextField("Notes", text: $model.notes)
        } header: {
            Text("Dose estimate")
        } footer: {
            Text((!model.takenEditedByUser && !model.taken.isEmpty)
                 ? "An estimate from your dose settings. Check it before you dose. Prefilled from the estimate — change it if you took a different amount."
                 : "An estimate from your dose settings. Check it before you dose.")
        }
    }

    private var actionsSection: some View {
        Section {
            Button {
                do { try model.logIt(app) } catch { model.message = "Could not log: \(error)" }
            } label: {
                Text("Log it").frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .disabled(model.lines.isEmpty)
            Button("Save as meal") { showSaveMeal = true }
                .disabled(model.lines.isEmpty)
        }
    }
}

struct LineRow: View {
    @Binding var line: CalculatorLine
    let units: [String]
    let portions: [PortionData]
    let carbs: CarbResult

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(line.displayName).lineLimit(2)
                Spacer()
                Text(carbs.complete ? "\(formatNumber(carbs.carbsG))g" : "missing data")
                    .foregroundStyle(carbs.complete ? Color.primary : Color.orange)
                    .monospacedDigit()
            }
            HStack {
                TextField("Amount", value: $line.amount, format: .number)
                    .keyboardType(.decimalPad)
                    .padding(6)
                    .background(Theme.fieldBackground)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .frame(maxWidth: 110)
                Picker("Unit", selection: $line.unit) {
                    ForEach(units, id: \.self) { unit in
                        Text(unitLabel(unit, portions: portions)).tag(unit)
                    }
                }
                .labelsHidden()
            }
        }
    }
}
