import CarbBookCore
import Foundation

/// Every decision the Plan screen makes about a slot, kept out of SwiftUI so it is unit tested on
/// Linux. Plans never snapshot carbs: totals are computed live with core `itemCarbs`/`sumCarbs`,
/// so an item whose food has not synced yet simply reads as incomplete ("missing data").
public enum PlanEditing {
    public enum EditError: Error, Equatable {
        case invalidAmount

        public var message: String { "\(AmountInput.invalidMessage). Fix it before saving." }
    }

    /// One editable row in the slot editor. `id` is nil for a row the user just added.
    public struct DraftItem: Equatable, Sendable, Identifiable {
        public var id: Id?
        public var refType: RefType
        public var refId: Id
        public var amount: Double
        public var unit: String

        public init(id: Id?, refType: RefType, refId: Id, amount: Double, unit: String) {
            self.id = id; self.refType = refType; self.refId = refId; self.amount = amount; self.unit = unit
        }
    }

    public struct Draft: Equatable, Sendable {
        public var date: String
        public var windowName: String
        public var note: String?
        public var items: [DraftItem]

        public init(date: String, windowName: String, note: String?, items: [DraftItem]) {
            self.date = date; self.windowName = windowName; self.note = note; self.items = items
        }
    }

    /// Live carbs for a slot. An empty slot is complete and zero, so an untouched day reads "0 g"
    /// rather than "missing data".
    public static func carbs(_ items: [PlanItemData], catalog: Catalog) -> CarbResult {
        sumCarbs(items.map { itemCarbs(catalog, $0.refType, $0.refId, $0.amount, $0.unit) })
    }

    /// Records for saving a slot: the entry, every kept item renumbered from 0, and a soft delete for
    /// every previously stored item the draft no longer contains. A new slot starts `planned`; an
    /// existing slot keeps its status and `log_entry_id` (editing a logged slot must not unlink it).
    /// `windowName` is trimmed before it is stored, matching the server's own trim (validateRecord)
    /// and the case-insensitive slot identity every lookup uses (`PlanDate.normalizedWindowName`).
    public static func saveChanges(draft: Draft, existing: PlanEntryData?, existingItems: [PlanItemData],
                                   newId: () -> Id) throws -> [SyncChange] {
        guard draft.items.allSatisfy({ $0.amount.isFinite && $0.amount >= 0 }) else { throw EditError.invalidAmount }
        let trimmedNote = draft.note?.trimmingCharacters(in: .whitespacesAndNewlines)
        let entry = PlanEntryData(
            id: existing?.id ?? newId(),
            date: draft.date,
            windowName: draft.windowName.trimmingCharacters(in: .whitespacesAndNewlines),
            status: existing?.status ?? .planned,
            note: (trimmedNote?.isEmpty ?? true) ? nil : trimmedNote,
            logEntryId: existing?.logEntryId)
        var changes = [try SyncChange.encode("plan_entry", entry)]
        var kept = Set<Id>()
        for (position, item) in draft.items.enumerated() {
            let id = item.id ?? newId()
            if item.id != nil { kept.insert(id) }
            changes.append(try SyncChange.encode("plan_item", PlanItemData(
                id: id, planEntryId: entry.id, refType: item.refType, refId: item.refId,
                amount: item.amount, unit: item.unit, position: position)))
        }
        for removed in existingItems where !kept.contains(removed.id) {
            var record = removed
            record.deleted = 1
            changes.append(try SyncChange.encode("plan_item", record))
        }
        return changes
    }

    /// Soft deletes for a slot and all of its items (the Plan screen's "Clear slot").
    public static func deleteChanges(entry: PlanEntryData, items: [PlanItemData]) -> [SyncChange] {
        var deletedEntry = entry
        deletedEntry.deleted = 1
        var changes = [(try? SyncChange.encode("plan_entry", deletedEntry))].compactMap { $0 }
        for item in items {
            var deletedItem = item
            deletedItem.deleted = 1
            if let change = try? SyncChange.encode("plan_item", deletedItem) { changes.append(change) }
        }
        return changes
    }

    /// Status-only change (Skip on the Calculator, Skip/Plan again on the Plan screen).
    public static func statusChange(_ entry: PlanEntryData, to status: PlanStatus) -> SyncChange {
        var updated = entry
        updated.status = status
        return (try? SyncChange.encode("plan_entry", updated))
            ?? SyncChange(table: "plan_entry", record: ["id": .string(entry.id)])
    }
}
