import CarbBookCore
import CarbBookKit
import Foundation
import Observation

/// One cell of the Plan grid: a window on a day, with whatever is planned in it.
struct PlanSlot: Identifiable {
    var date: String
    var window: DoseWindow
    var entry: PlanEntryData?
    var items: [PlanItemData]
    var carbs: CarbResult

    var id: String { PlanDate.slotKey(date: date, windowName: window.name) }
    var isEmpty: Bool { items.isEmpty }
}

@Observable
@MainActor
final class PlanModel {
    /// Any date inside the displayed week.
    var anchor: String = PlanDate.string(Date())
    private(set) var week: [String] = []
    private(set) var windows: [DoseWindow] = []
    private(set) var slots: [String: PlanSlot] = [:]
    private(set) var catalog = InMemoryCatalog()
    var message: String?

    /// Windows of the dose-settings version in effect now; an empty list means the user has no dose
    /// settings yet, and the Plan screen says so instead of showing an empty grid.
    private func loadWindows(_ app: AppModel) throws -> [DoseWindow] {
        let versions = try app.store.doseSettingsVersions()
        let usable = eligibleDoseSettingsVersions(versions, rejectedIds: try app.store.rejectedDoseSettingsIds())
        return activeSettings(usable, nowMs())?.windows ?? []
    }

    func load(_ app: AppModel) {
        do {
            week = PlanDate.week(containing: anchor)
            windows = try loadWindows(app)
            catalog = try app.store.catalog()
            let entries = try app.store.planEntries(from: week.first ?? anchor, to: week.last ?? anchor)
            let itemsByEntry = try app.store.planItems(entryIds: entries.map(\.id))
            var built: [String: PlanSlot] = [:]
            for date in week {
                for window in windows {
                    let entry = entries.first { $0.date == date && $0.windowName == window.name }
                    let items = entry.flatMap { itemsByEntry[$0.id] } ?? []
                    built[PlanDate.slotKey(date: date, windowName: window.name)] = PlanSlot(
                        date: date, window: window, entry: entry, items: items,
                        carbs: PlanEditing.carbs(items, catalog: catalog))
                }
            }
            slots = built
        } catch {
            message = "Could not read the plan: \(error)"
        }
    }

    func slot(date: String, window: DoseWindow) -> PlanSlot {
        slots[PlanDate.slotKey(date: date, windowName: window.name)]
            ?? PlanSlot(date: date, window: window, entry: nil, items: [], carbs: CarbResult(carbsG: 0, complete: true))
    }

    /// Carbs planned for a whole day (no day goal: goals are per meal/snack only).
    func dayCarbs(_ date: String) -> CarbResult {
        sumCarbs(windows.map { slot(date: date, window: $0).carbs })
    }

    func showWeek(offsetBy weeks: Int, _ app: AppModel) {
        anchor = PlanDate.shift(anchor, byDays: weeks * 7)
        load(app)
    }

    func showToday(_ app: AppModel) {
        anchor = PlanDate.string(Date())
        load(app)
    }

    func save(draft: PlanEditing.Draft, slot: PlanSlot, _ app: AppModel) {
        do {
            let changes = try PlanEditing.saveChanges(draft: draft, existing: slot.entry,
                                                      existingItems: slot.items, newId: app.store.newId)
            try app.savePlan(changes)
            // An edited slot is worth offering again even if it was dismissed on this device.
            PlanDismissals.clear(date: slot.date, windowName: slot.window.name)
            load(app)
        } catch let error as PlanEditing.EditError {
            message = error.message
        } catch {
            message = "Could not save the slot: \(error)"
        }
    }

    func clear(slot: PlanSlot, _ app: AppModel) {
        guard let entry = slot.entry else { return }
        do {
            try app.savePlan(PlanEditing.deleteChanges(entry: entry, items: slot.items))
            load(app)
        } catch {
            message = "Could not clear the slot: \(error)"
        }
    }

    func setStatus(_ status: PlanStatus, slot: PlanSlot, _ app: AppModel) {
        guard let entry = slot.entry else { return }
        do {
            try app.savePlan([PlanEditing.statusChange(entry, to: status)])
            load(app)
        } catch {
            message = "Could not update the slot: \(error)"
        }
    }

    /// What the user is copying: one day, or the whole displayed week onto the next one.
    enum CopyScope: Equatable {
        case day(String)
        case week
    }

    /// Source date → target date for a scope. A day copy has one pair; a week copy maps each of the
    /// seven displayed days onto the same weekday `weeks` later.
    func dayOffsets(for scope: CopyScope, target: String, weeks: Int = 1) -> [String: String] {
        switch scope {
        case .day(let date): [date: target]
        case .week: Dictionary(uniqueKeysWithValues: week.map { ($0, PlanDate.shift($0, byDays: weeks * 7)) })
        }
    }

    /// Destination DAYS that already hold a live entry (any status, including `logged`), so the sheet
    /// only asks replace/merge/skip when Replace would actually clear something on that day
    /// (`PlanEditing.conflictDates`, matching web `conflictDates`).
    func occupied(_ offsets: [String: String], _ app: AppModel) -> [String] {
        let targetDates = Array(Set(offsets.values)).sorted()
        guard let first = targetDates.first, let last = targetDates.last else { return [] }
        let targets = (try? app.store.planEntries(from: first, to: last)) ?? []
        return PlanEditing.conflictDates(targetEntries: targets, targetDates: targetDates)
    }

    func copy(_ offsets: [String: String], mode: PlanEditing.CopyMode, _ app: AppModel) {
        do {
            let sources = sourceEntries(offsets)
            guard !sources.isEmpty else {
                message = "There is nothing planned to copy."
                return
            }
            let targetDates = offsets.values.sorted()
            let targets = try app.store.planEntries(from: targetDates.first ?? anchor, to: targetDates.last ?? anchor)
            var itemsByEntry = try app.store.planItems(entryIds: sources.map(\.id))
            for (key, value) in try app.store.planItems(entryIds: targets.map(\.id)) { itemsByEntry[key] = value }
            let changes = try PlanEditing.copyChanges(
                sourceEntries: sources, targetEntries: targets, itemsByEntry: itemsByEntry,
                dayOffsets: offsets, mode: mode, newId: app.store.newId)
            guard !changes.isEmpty else {
                message = "Nothing was copied: every destination already had a plan."
                return
            }
            try app.savePlan(changes)
            load(app)
            // Replace also emits a plan_entry change per cleared slot; only the live (non-deleted)
            // ones are slots actually copied.
            let copied = changes.filter { $0.table == "plan_entry" && $0.record["deleted"] != .number(1) }.count
            message = "Copied \(copied) slot(s)."
        } catch {
            message = "Could not copy: \(error)"
        }
    }

    private func sourceEntries(_ offsets: [String: String]) -> [PlanEntryData] {
        offsets.keys.sorted().flatMap { date in
            windows.compactMap { slot(date: date, window: $0).entry }.filter { $0.date == date }
        }
    }
}
