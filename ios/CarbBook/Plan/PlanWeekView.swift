import CarbBookCore
import CarbBookKit
import SwiftUI

/// Phone layout of the spec §4 week grid: days as sections, that day's windows stacked inside.
struct PlanWeekView: View {
    @Environment(AppModel.self) private var app
    @State private var model = PlanModel()
    @State private var editing: PlanSlot?
    @State private var copyScope: PlanModel.CopyScope?

    var body: some View {
        NavigationStack {
            List {
                if model.windows.isEmpty {
                    Section {
                        Text("Add dose settings with meal windows before planning.").foregroundStyle(.secondary)
                    }
                }
                ForEach(model.week, id: \.self) { date in
                    Section {
                        ForEach(model.windows, id: \.name) { window in
                            slotRow(model.slot(date: date, window: window))
                        }
                    } header: {
                        dayHeader(date)
                    }
                }
            }
            .navigationTitle("Plan")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { model.showWeek(offsetBy: -1, app) } label: { Image(systemName: "chevron.left") }
                        .accessibilityLabel("Previous week")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { model.showWeek(offsetBy: 1, app) } label: { Image(systemName: "chevron.right") }
                        .accessibilityLabel("Next week")
                }
                ToolbarItem(placement: .bottomBar) { Button("Today") { model.showToday(app) } }
                ToolbarItem(placement: .bottomBar) { Button("Copy week") { copyScope = .week } }
            }
            .sheet(item: $editing) { slot in
                PlanSlotEditorView(slot: slot) { draft in model.save(draft: draft, slot: slot, app) }
            }
            .sheet(item: $copyScope) { scope in
                PlanCopySheet(
                    scope: scope,
                    occupied: { model.occupied($0, app) },
                    offsets: { target in model.dayOffsets(for: scope, target: target) },
                    onCopy: { offsets, mode in model.copy(offsets, mode: mode, app) })
            }
            .alert(model.message ?? "", isPresented: Binding(get: { model.message != nil },
                                                             set: { if !$0 { model.message = nil } })) {
                Button("OK", role: .cancel) {}
            }
            .onAppear { model.load(app) }
            .onChange(of: app.revision) { model.load(app) }
        }
    }

    private func dayHeader(_ date: String) -> some View {
        let total = model.dayCarbs(date)
        let style = goalStyle(total, model.dayGoalFor(date))
        return HStack {
            Text(PlanDate.date(date).map { $0.formatted(.dateTime.weekday(.abbreviated).month().day()) } ?? date)
            Spacer()
            GoalBadge(style: style, font: .caption)
            Button { copyScope = .day(date) } label: { Image(systemName: "doc.on.doc") }
                .buttonStyle(.borderless)
                .accessibilityLabel("Copy \(date) to another day")
        }
    }

    private func slotRow(_ slot: PlanSlot) -> some View {
        Button {
            editing = slot
        } label: {
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(slot.window.name).foregroundStyle(.primary)
                    if let status = slot.entry?.status, status != .planned {
                        Text(status.rawValue)
                            .font(.caption2)
                            .padding(.horizontal, 6).padding(.vertical, 2)
                            .background(Theme.fieldBackground)
                            .clipShape(Capsule())
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    if slot.isEmpty {
                        Image(systemName: "plus").foregroundStyle(.secondary).accessibilityLabel("Plan \(slot.window.name)")
                    } else {
                        GoalBadge(style: goalStyle(slot.carbs, slot.window.carbGoal), font: .callout)
                    }
                }
                if !slot.isEmpty {
                    Text(itemsText(slot)).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
            }
        }
        .swipeActions(edge: .trailing) {
            if slot.entry != nil {
                Button("Clear", role: .destructive) { model.clear(slot: slot, app) }
                Button(slot.entry?.status == .skipped ? "Plan" : "Skip") {
                    model.setStatus(slot.entry?.status == .skipped ? .planned : .skipped, slot: slot, app)
                }
            }
        }
    }

    private func itemsText(_ slot: PlanSlot) -> String {
        slot.items.map { item in
            switch item.refType {
            case .food: model.catalog.food(item.refId)?.name ?? "Unknown item"
            case .meal: model.catalog.meal(item.refId)?.name ?? "Unknown item"
            }
        }.joined(separator: ", ")
    }
}
