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

    /// What to do when the destination slot already has a live entry (spec §4).
    public enum CopyMode: String, Equatable, Sendable, CaseIterable {
        /// Clear the destination's items and use the source's.
        case replace
        /// Append the source's items after the destination's.
        case merge
        /// Leave the destination untouched.
        case skip

        public var label: String {
            switch self {
            case .replace: "Replace"
            case .merge: "Merge"
            case .skip: "Skip"
            }
        }
    }

    /// Destination slot keys ("<date>|<window>", normalized) that already hold a live entry, so the
    /// screen can ask replace / merge / skip only when it actually matters.
    public static func occupiedTargets(sourceEntries: [PlanEntryData], targetEntries: [PlanEntryData],
                                       dayOffsets: [String: String]) -> [String] {
        let existing = Set(targetEntries.map { PlanDate.slotKey(date: $0.date, windowName: $0.windowName) })
        let wanted = sourceEntries.compactMap { entry -> String? in
            guard let target = dayOffsets[entry.date], target != entry.date else { return nil }
            return PlanDate.slotKey(date: target, windowName: entry.windowName)
        }
        return wanted.filter { existing.contains($0) }.sorted()
    }

    /// Records for copying `sourceEntries` onto the days named by `dayOffsets` (source date → target
    /// date; one pair for a day copy, seven for a week). A source date that maps to itself is
    /// skipped (copying a day onto itself must never duplicate its own items). A copy is never
    /// linked to the source's log entry and always lands as `planned`: it is a plan, not a record of
    /// something eaten. The whole result is meant to be applied through `LocalStore.save` in one
    /// call, so every soft delete and every save for a replace/merge/skip commits atomically — a
    /// failure part-way through must never leave a duplicated live slot.
    public static func copyChanges(sourceEntries: [PlanEntryData], targetEntries: [PlanEntryData],
                                   itemsByEntry: [Id: [PlanItemData]], dayOffsets: [String: String],
                                   mode: CopyMode, newId: () -> Id) throws -> [SyncChange] {
        var targetsByKey: [String: PlanEntryData] = [:]
        for entry in targetEntries { targetsByKey[PlanDate.slotKey(date: entry.date, windowName: entry.windowName)] = entry }
        var changes: [SyncChange] = []
        for source in sourceEntries.sorted(by: { ($0.date, $0.windowName) < ($1.date, $1.windowName) }) {
            guard let targetDate = dayOffsets[source.date], targetDate != source.date else { continue }
            let sourceItems = itemsByEntry[source.id] ?? []
            let key = PlanDate.slotKey(date: targetDate, windowName: source.windowName)
            let existing = targetsByKey[key]
            if existing != nil && mode == .skip { continue }

            var startPosition = 0
            let entryId: Id
            if let existing {
                entryId = existing.id
                let existingItems = itemsByEntry[existing.id] ?? []
                if mode == .replace {
                    for item in existingItems {
                        var deletedItem = item
                        deletedItem.deleted = 1
                        changes.append(try SyncChange.encode("plan_item", deletedItem))
                    }
                    // A replaced slot goes back to planned and loses any link to a logged entry.
                    var reset = existing
                    reset.status = .planned
                    reset.logEntryId = nil
                    reset.note = source.note
                    changes.append(try SyncChange.encode("plan_entry", reset))
                } else {
                    startPosition = (existingItems.map(\.position).max() ?? -1) + 1
                }
            } else {
                entryId = newId()
                changes.append(try SyncChange.encode("plan_entry", PlanEntryData(
                    id: entryId, date: targetDate, windowName: source.windowName, status: .planned,
                    note: source.note, logEntryId: nil)))
            }
            for (offset, item) in sourceItems.enumerated() {
                changes.append(try SyncChange.encode("plan_item", PlanItemData(
                    id: newId(), planEntryId: entryId, refType: item.refType, refId: item.refId,
                    amount: item.amount, unit: item.unit, position: startPosition + offset)))
            }
        }
        return changes
    }
}
