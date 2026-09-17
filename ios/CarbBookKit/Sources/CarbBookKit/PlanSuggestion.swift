import CarbBookCore
import Foundation

/// The Calculator's "Planned: … — Load / Skip / Dismiss" line (spec §5).
public struct PlanSuggestion: Equatable, Sendable {
    public var entryId: Id
    public var date: String
    public var windowName: String
    /// Display names of the slot's items, in order; an item whose food has not synced yet reads
    /// "Unknown item" rather than hiding the suggestion.
    public var itemNames: [String]
    public var carbs: CarbResult

    public var slotKey: String { PlanDate.slotKey(date: date, windowName: windowName) }

    /// "Planned: Rice, Salad — 42 g" (or "… — missing data").
    public var text: String {
        let amount = carbs.complete ? "\(formatCarbs(carbs.carbsG)) g" : "missing data"
        return "Planned: \(itemNames.joined(separator: ", ")) — \(amount)"
    }

    /// The suggestion for a slot, or nil when there is nothing to offer: no slot, no items, a slot
    /// already logged or skipped, or one dismissed on this device. `dismissed` is compared through
    /// the same normalized `slotKey` this struct exposes, so a dismissal survives a slot whose
    /// window name differs only by case or whitespace.
    public static func make(entry: PlanEntryData?, items: [PlanItemData], catalog: Catalog,
                            dismissed: Set<String>) -> PlanSuggestion? {
        guard let entry, entry.status == .planned, entry.deleted != 1, !items.isEmpty else { return nil }
        let key = PlanDate.slotKey(date: entry.date, windowName: entry.windowName)
        guard !dismissed.contains(key) else { return nil }
        return PlanSuggestion(
            entryId: entry.id, date: entry.date, windowName: entry.windowName,
            itemNames: items.map { displayName($0, catalog: catalog) },
            carbs: PlanEditing.carbs(items, catalog: catalog))
    }

    /// Calculator rows for "Load": plain editable lines, removable like any other row.
    public static func lines(for items: [PlanItemData], catalog: Catalog, newLineId: () -> String) -> [CalculatorLine] {
        items.map { item in
            CalculatorLine(id: newLineId(), refType: item.refType, refId: item.refId,
                           displayName: displayName(item, catalog: catalog), amount: item.amount, unit: item.unit,
                           label: item.label)
        }
    }

    private static func displayName(_ item: PlanItemData, catalog: Catalog) -> String {
        itemDisplayName(item.refType, item.refId, label: item.label, catalog: catalog)
    }

    /// Whether the Calculator should show a freshly computed suggestion: never once a slot has been
    /// loaded this session, matching web `Calculator.tsx:75` (`loadedSlot === null ? suggestionFor(...)
    /// : null`). Loading clears the visible suggestion, but the slot itself is still `planned` in
    /// storage, so recomputing (a clock tick, a window change) would otherwise compute and re-show it
    /// — offering "Load" again would append the same items a second time. Both `refreshSuggestion` and
    /// `loadSuggestion`'s idempotency rely on this: once `loadedSlotId != nil`, this always returns
    /// nil, so a second Load call sees no suggestion to act on.
    public static func shown(computed: PlanSuggestion?, loadedSlotId: Id?) -> PlanSuggestion? {
        loadedSlotId == nil ? computed : nil
    }
}

/// Suggestions the user dismissed on *this device only* — never synced (spec §5). Same key format
/// as the web app's localStorage set (trimmed, case-insensitive `PlanDate.slotKey`), so the two are
/// easy to reason about together.
public enum PlanDismissals {
    public static let key = "plan.dismissedSlots"

    public static func load(from defaults: UserDefaults = .standard) -> Set<String> {
        Set(defaults.array(forKey: key) as? [String] ?? [])
    }

    public static func dismiss(date: String, windowName: String, in defaults: UserDefaults = .standard) {
        var current = load(from: defaults)
        current.insert(PlanDate.slotKey(date: date, windowName: windowName))
        defaults.set(Array(current).sorted(), forKey: key)
    }

    /// Used when a slot is re-planned or edited, so a dismissal never hides a changed slot forever.
    public static func clear(date: String, windowName: String, in defaults: UserDefaults = .standard) {
        var current = load(from: defaults)
        current.remove(PlanDate.slotKey(date: date, windowName: windowName))
        defaults.set(Array(current).sorted(), forKey: key)
    }
}
