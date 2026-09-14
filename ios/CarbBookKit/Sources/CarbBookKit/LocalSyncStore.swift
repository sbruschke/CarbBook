import CarbBookCore
import Foundation
import GRDB

/// A rejected push, shown in Settings → Sync (spec §9).
public struct SyncRejection: Equatable, Sendable {
    public var table: String
    public var recordId: String
    public var reason: String?
    public var message: String?
    public var rejectedAt: Int64
}

/// GRDB implementation of core's `SyncStore` contract (see SyncEngine.swift):
/// - every synced row has a last server-acknowledged snapshot in `sync_snapshot` (absent = never synced);
/// - push results are matched to sent records by index, and applied only while the row still has
///   the pushed version: accepted → clear pending + new snapshot; ignored → clear pending;
///   rejected → restore the snapshot (or delete a never-synced row) + clear pending + record it;
/// - pulls apply `shouldApplyPulled` whether or not the row is pending, and update rows,
///   snapshots, pending marks and the cursor in one transaction.
extension LocalStore: SyncStore {
    public func pendingChanges(limit: Int) async throws -> [SyncChange] {
        try await dbQueue.read { db in
            let pending = try Row.fetchAll(
                db, sql: "SELECT table_name, record_id FROM sync_pending ORDER BY queued_at, key LIMIT ?", arguments: [limit])
            return try pending.compactMap { entry -> SyncChange? in
                try self.change(db, table: entry["table_name"], id: entry["record_id"])
            }
        }
    }

    public func recordPushResults(_ pushed: [SyncChange], _ results: [PushResult]) async throws {
        let stamp = now()
        try await dbQueue.write { db in
            for (sent, result) in zip(pushed, results) {
                guard let id = sent.id, TableCodec.dataColumns[sent.table] != nil else { continue }
                let key = sent.key
                let current = try self.change(db, table: sent.table, id: id)
                // A newer local edit landed while the push was in flight: leave row, pending mark
                // and rejections untouched so the newer edit is retried on the next sync.
                guard let current, current.version == sent.version else { continue }

                switch result.status {
                case "accepted":
                    var acknowledged = sent.record
                    if let seq = result.serverSeq {
                        try db.execute(sql: "UPDATE \(sent.table) SET server_seq = ? WHERE id = ?", arguments: [seq, id])
                        acknowledged["server_seq"] = .number(Double(seq))
                    }
                    try Self.saveSnapshot(db, SyncChange(table: sent.table, record: acknowledged))
                    try db.execute(sql: "DELETE FROM sync_rejection WHERE key = ?", arguments: [key])
                case "ignored":
                    break
                default: // "rejected"
                    if let snapshot = try Self.snapshot(db, key: key) {
                        try Self.upsertRow(db, snapshot)
                    } else {
                        try db.execute(sql: "DELETE FROM \(sent.table) WHERE id = ?", arguments: [id])
                    }
                    try db.execute(
                        sql: """
                        INSERT INTO sync_rejection (key, table_name, record_id, reason, message, rejected_at, rejected_updated_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(key) DO UPDATE SET reason = excluded.reason, message = excluded.message,
                          rejected_at = excluded.rejected_at, rejected_updated_at = excluded.rejected_updated_at
                        """,
                        arguments: [key, sent.table, id, result.reason, result.message, stamp, sent.version?.updatedAt])
                }
                try db.execute(sql: "DELETE FROM sync_pending WHERE key = ?", arguments: [key])
            }
        }
    }

    public func pullCursor() async throws -> Int64 {
        try await dbQueue.read { db in Int64(try self.state(db, "pull_cursor") ?? "0") ?? 0 }
    }

    public func applyPull(_ changes: [SyncChange], nextSince: Int64) async throws {
        try await dbQueue.write { db in
            for change in changes {
                guard TableCodec.dataColumns[change.table] != nil, let id = change.id, let incoming = change.version else { continue }
                let local = try self.change(db, table: change.table, id: id)
                let isPending = try Bool.fetchOne(
                    db, sql: "SELECT EXISTS (SELECT 1 FROM sync_pending WHERE key = ?)", arguments: [change.key]) ?? false
                guard shouldApplyPulled(incoming: incoming, local: local?.version, localPending: isPending) else { continue }
                try Self.upsertRow(db, change)
                try Self.saveSnapshot(db, change)
                try db.execute(sql: "DELETE FROM sync_pending WHERE key = ?", arguments: [change.key])
                // The server has since converged on this key (directly, or via another device): any
                // earlier rejection recorded for it no longer reflects the current state.
                try db.execute(sql: "DELETE FROM sync_rejection WHERE key = ?", arguments: [change.key])
            }
            try self.setState(db, "pull_cursor", String(nextSince))
        }
    }

    public func setLastSynced(_ ms: Int64) async throws {
        try await dbQueue.write { db in try self.setState(db, "last_synced_at", String(ms)) }
    }

    public func lastSyncedMs() throws -> Int64? {
        try dbQueue.read { db in try state(db, "last_synced_at").flatMap { Int64($0) } }
    }

    public func rejections() throws -> [SyncRejection] {
        try dbQueue.read { db in
            try Row.fetchAll(db, sql: "SELECT * FROM sync_rejection ORDER BY rejected_at DESC, key").map {
                SyncRejection(table: $0["table_name"], recordId: $0["record_id"], reason: $0["reason"],
                              message: $0["message"], rejectedAt: $0["rejected_at"])
            }
        }
    }

    /// Ids of dose_settings versions with a recorded push rejection that is still in effect. Pass as
    /// `rejectedSettingsIds` to core `evaluateCalculator` / `recalculateLogEntry`.
    ///
    /// A rejection is excluded once the row has moved on from the rejected version: `recordPushResults`
    /// restores the row to its last server-acknowledged snapshot (or deletes it when never synced), so
    /// a restore that succeeded leaves the row's `updated_at` different from `rejected_updated_at` — the
    /// version is valid again and must be selectable. A row still at `rejected_updated_at` (restore
    /// failed) or altogether missing (never synced, deleted on rejection) stays excluded from use.
    public func rejectedDoseSettingsIds() throws -> Set<Id> {
        try dbQueue.read { db in
            Set(try String.fetchAll(
                db,
                sql: """
                SELECT sr.record_id FROM sync_rejection sr
                 WHERE sr.table_name = 'dose_settings'
                   AND (
                     NOT EXISTS (SELECT 1 FROM dose_settings ds WHERE ds.id = sr.record_id)
                     OR EXISTS (SELECT 1 FROM dose_settings ds WHERE ds.id = sr.record_id AND ds.updated_at = sr.rejected_updated_at)
                   )
                """))
        }
    }

    public func dismissRejection(table: String, recordId: String) throws {
        try dbQueue.write { db in
            try db.execute(sql: "DELETE FROM sync_rejection WHERE key = ?", arguments: ["\(table)/\(recordId)"])
        }
    }

    // MARK: - Snapshot helpers

    static func upsertRow(_ db: Database, _ change: SyncChange) throws {
        let columns = try TableCodec.columns(change.table)
        try db.execute(
            sql: TableCodec.upsertSQL(change.table, columns),
            arguments: StatementArguments(try columns.map { try TableCodec.databaseValue($0, change.record[$0]) }))
    }

    static func saveSnapshot(_ db: Database, _ change: SyncChange) throws {
        guard let id = change.id else { return }
        let text = String(decoding: try JSONEncoder().encode(change.record), as: UTF8.self)
        try db.execute(
            sql: """
            INSERT INTO sync_snapshot (key, table_name, record_id, record) VALUES (?, ?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET record = excluded.record
            """,
            arguments: [change.key, change.table, id, text])
    }

    static func snapshot(_ db: Database, key: String) throws -> SyncChange? {
        guard let row = try Row.fetchOne(db, sql: "SELECT table_name, record FROM sync_snapshot WHERE key = ?", arguments: [key]) else {
            return nil
        }
        let text: String = row["record"]
        let record = try JSONDecoder().decode([String: JSONValue].self, from: Data(text.utf8))
        return SyncChange(table: row["table_name"], record: record)
    }
}
