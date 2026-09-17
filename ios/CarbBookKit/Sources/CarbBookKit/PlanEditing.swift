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

    /// One editable row in the slot editor. `id` is nil for a row the user just added; `key` is a
    /// stable, unique identity assigned once at creation (never re-derived from `id`) and kept
    /// unchanged across edits, so SwiftUI's `ForEach` never conflates two rows that both have a nil
    /// `id` — a mix-up that would previously let a user's typed amount land in the wrong row (an
    /// on-screen-only bug: saved values were always correct, but this matters in an insulin-dosing
    /// app). Deliberately NOT `Identifiable` on `id`, so nothing can accidentally key a `ForEach` off
    /// the optional, non-unique persisted id again; every `ForEach` over draft rows must use `\.key`.
    public struct DraftItem: Equatable, Sendable {
        public var id: Id?
        public var refType: RefType
        public var refId: Id
        public var amount: Double
        public var unit: String
        /// Quick carbs rows only: the label as typed.
        public var label: String?
        public let key: UUID

        public init(id: Id?, refType: RefType, refId: Id, amount: Double, unit: String, label: String? = nil,
                    key: UUID = UUID()) {
            self.id = id; self.refType = refType; self.refId = refId; self.amount = amount; self.unit = unit
            self.label = label; self.key = key
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

    /// The Plan screen's day total: plain grams, never goal-coloured (quick-carbs spec §3).
    public static func dayTotalText(_ carbs: CarbResult) -> String {
        carbs.complete && carbs.carbsG.isFinite ? "\(formatCarbs(carbs.carbsG)) g" : "missing data"
    }

    /// Records for saving a slot: the entry, every kept item renumbered from 0, and a soft delete for
    /// every previously stored item the draft no longer contains. A new slot starts `planned`; an
    /// existing slot keeps its status and `log_entry_id` (editing a logged slot must not unlink it).
    /// `windowName` is trimmed before it is stored, matching the server's own trim (validateRecord)
    /// and the case-insensitive slot identity every lookup uses (`PlanDate.normalizedWindowName`).
    public static func saveChanges(draft: Draft, existing: PlanEntryData?, existingItems: [PlanItemData],
                                   newId: () -> Id) throws -> [SyncChange] {
        guard !draft.items.contains(where: { AmountInput.isInvalid(amount: $0.amount, refType: $0.refType) }) else { throw EditError.invalidAmount }
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
                id: id, planEntryId: entry.id, refType: item.refType,
                refId: itemRefId(item.refType, item.refId, rowId: id),
                amount: item.amount, unit: item.unit, position: position,
                label: item.refType == .quick ? normalizeQuickLabel(item.label) : nil)))
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

    /// The Copy sheet's default destination for a single-day copy: the day after the source, never
    /// the source day itself — a target defaulting to the source day would need to be changed before
    /// Copy could ever be pressed (spec §4).
    public static func defaultCopyTarget(source: String) -> String { PlanDate.shift(source, byDays: 1) }

    /// True when a day copy's target is the same day as its source: Copy must refuse this rather than
    /// silently copying a day onto itself (only `copyChanges`'s own same-date skip would otherwise
    /// save the user from a no-op write).
    public static func isSelfCopy(sourceDate: String?, targetDate: String) -> Bool { sourceDate == targetDate }

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

    /// Destination DAYS (not slots) that already hold at least one live entry — any status, including
    /// `logged` — so the Copy sheet only asks replace/merge/skip when Replace would actually clear
    /// something. Matches the deployed web app's `conflictDates` (`web/src/plan/copy.ts`): `replace`
    /// clears every live slot on a target day, so a day with an unrelated logged breakfast still
    /// counts as a conflict even though no source window matches it.
    public static func conflictDates(targetEntries: [PlanEntryData], targetDates: [String]) -> [String] {
        let present = Set(targetEntries.map(\.date))
        return targetDates.filter { present.contains($0) }.sorted()
    }

    /// Records for copying `sourceEntries` onto the days named by `dayOffsets` (source date → target
    /// date; one pair for a day copy, seven for a week). A source date that maps to itself, or to
    /// text `PlanDate` cannot parse, is skipped (copying a day onto itself must never duplicate its
    /// own items). A copy is never linked to the source's log entry and always lands as `planned`:
    /// it is a plan, not a record of something eaten. The whole result is meant to be applied
    /// through `LocalStore.applyPlanChanges` in one call, so every soft delete and every save for a
    /// replace/merge/skip commits atomically — a failure part-way through must never leave a
    /// duplicated live slot.
    ///
    /// `replace` matches the deployed web app (`web/src/plan/copy.ts`): it clears the WHOLE target
    /// day first — every live slot on that date, matched or not — then writes the source day's
    /// slots fresh. A target day with Breakfast + Lunch and a source with only Breakfast ends with
    /// only the copied Breakfast; a stray unmatched Lunch is never left behind.
    public static func copyChanges(sourceEntries: [PlanEntryData], targetEntries: [PlanEntryData],
                                   itemsByEntry: [Id: [PlanItemData]], dayOffsets: [String: String],
                                   mode: CopyMode, newId: () -> Id) throws -> [SyncChange] {
        // Target dates a source actually lands on: not a self-copy, and parseable as a local date.
        let validTargetDates = Set(sourceEntries.compactMap { source -> String? in
            guard let target = dayOffsets[source.date], target != source.date, PlanDate.date(target) != nil else { return nil }
            return target
        })

        var targetsByKey: [String: PlanEntryData] = [:]
        for entry in targetEntries { targetsByKey[PlanDate.slotKey(date: entry.date, windowName: entry.windowName)] = entry }
        // Kept up to date as items are appended below, so a second source landing on the same key
        // (merge, or the same-key defence in `replace`) computes its start position after the first
        // source's items, not from the stale snapshot passed in.
        var itemsByEntry = itemsByEntry

        var changes: [SyncChange] = []
        if mode == .replace {
            for targetDate in validTargetDates.sorted() {
                for target in targetEntries.sorted(by: { $0.windowName < $1.windowName }) where target.date == targetDate {
                    for item in itemsByEntry[target.id] ?? [] {
                        var deletedItem = item
                        deletedItem.deleted = 1
                        changes.append(try SyncChange.encode("plan_item", deletedItem))
                    }
                    var deletedEntry = target
                    deletedEntry.deleted = 1
                    changes.append(try SyncChange.encode("plan_entry", deletedEntry))
                    targetsByKey.removeValue(forKey: PlanDate.slotKey(date: target.date, windowName: target.windowName))
                }
            }
        }

        for source in sourceEntries.sorted(by: { ($0.date, $0.windowName) < ($1.date, $1.windowName) }) {
            guard let targetDate = dayOffsets[source.date], validTargetDates.contains(targetDate) else { continue }
            let sourceItems = itemsByEntry[source.id] ?? []
            let key = PlanDate.slotKey(date: targetDate, windowName: source.windowName)
            let existing = targetsByKey[key]
            if existing != nil && mode == .skip { continue }

            var startPosition = 0
            let entryId: Id
            // A live entry at this key merges rather than duplicates, regardless of mode: for
            // `merge` this is the intended append; for `replace` the day was already cleared above,
            // so `existing` here can only be a slot this very copy just created for another source
            // that maps to the same (date, window) — appending, not re-creating, is what keeps that
            // case to one live slot too.
            if let existing {
                entryId = existing.id
                let existingItems = itemsByEntry[existing.id] ?? []
                startPosition = (existingItems.map(\.position).max() ?? -1) + 1
            } else {
                entryId = newId()
                let newEntry = PlanEntryData(id: entryId, date: targetDate, windowName: source.windowName,
                                             status: .planned, note: source.note, logEntryId: nil)
                changes.append(try SyncChange.encode("plan_entry", newEntry))
                // Recorded so a second source that lands on the same (date, window) — e.g. a
                // malformed or duplicated source list — merges into this one instead of creating
                // a second live slot for the same key.
                targetsByKey[key] = newEntry
            }
            var written: [PlanItemData] = []
            for (offset, item) in sourceItems.enumerated() {
                let id = newId()
                let copied = PlanItemData(id: id, planEntryId: entryId, refType: item.refType,
                                          refId: itemRefId(item.refType, item.refId, rowId: id),
                                          amount: item.amount, unit: item.unit, position: startPosition + offset,
                                          label: item.label)
                changes.append(try SyncChange.encode("plan_item", copied))
                written.append(copied)
            }
            itemsByEntry[entryId, default: []].append(contentsOf: written)
        }
        return changes
    }
}
