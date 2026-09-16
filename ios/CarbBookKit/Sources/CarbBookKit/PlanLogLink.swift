import CarbBookCore
import Foundation

/// Links between a planned slot and the log entry it produced (spec §5).
///
/// The server also reverts a slot when the log entry it points at is soft-deleted (that is where the
/// rule lives, so devices that never held the slot still converge). The client writes the same change
/// as well, so the Plan screen is correct immediately and while offline: both writes set exactly the
/// same fields, so whichever wins last-write-wins produces the same row. `log_entry_id` only ever
/// links to a live log entry: this file's two changes are the only writers of that field, and
/// `unlinkChanges` is exactly what clears it back to `planned` when the entry it points at is gone.
public enum PlanLogLink {
    /// The slot a "Log it" came from, moved to `logged` with its `log_entry_id`. Takes the
    /// `LogEntryData` itself (not a bare id) so a slot can only ever be linked to a log entry the
    /// caller actually has in hand — never a dangling or already-deleted id.
    public static func loggedChange(_ entry: PlanEntryData?, loggedTo logEntry: LogEntryData) -> SyncChange? {
        guard var updated = entry else { return nil }
        updated.status = .logged
        updated.logEntryId = logEntry.id
        return try? SyncChange.encode("plan_entry", updated)
    }

    /// Slots pointing at a deleted log entry, returned to `planned` with the link cleared.
    public static func unlinkChanges(_ entries: [PlanEntryData], logEntryId: Id) throws -> [SyncChange] {
        try entries.filter { $0.logEntryId == logEntryId }.map { entry in
            var updated = entry
            updated.status = .planned
            updated.logEntryId = nil
            return try SyncChange.encode("plan_entry", updated)
        }
    }
}
