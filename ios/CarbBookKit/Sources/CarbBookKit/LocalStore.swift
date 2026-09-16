import CarbBookCore
import Foundation
import GRDB

/// The app's SQLite database: synced tables, pending queue and sync state. Every local write
/// stamps `updated_at`/`updated_by`, upserts the row and marks it pending in one transaction,
/// so pending changes survive restarts (spec §5).
public final class LocalStore: @unchecked Sendable {
    public let dbQueue: DatabaseQueue
    public let deviceId: String
    let now: @Sendable () -> Int64
    private let lock = NSLock()
    private var localWriteHandler: (@Sendable () -> Void)?

    /// `path == nil` opens an in-memory database (tests).
    public init(path: String?, now: @escaping @Sendable () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }) throws {
        dbQueue = try path.map { try DatabaseQueue(path: $0) } ?? DatabaseQueue()
        self.now = now
        try Schema.migrator.migrate(dbQueue)
        deviceId = try dbQueue.write { db in
            if let existing = try String.fetchOne(db, sql: "SELECT value FROM sync_state WHERE key = 'device_id'") {
                return existing
            }
            let id = "ios-" + UUIDv7.make(nowMs: now())
            try db.execute(sql: "INSERT INTO sync_state (key, value) VALUES ('device_id', ?)", arguments: [id])
            return id
        }
    }

    /// Called after every local write (the sync coordinator debounces a sync from it).
    public func setLocalWriteHandler(_ handler: (@Sendable () -> Void)?) {
        lock.lock()
        localWriteHandler = handler
        lock.unlock()
    }

    public func newId() -> Id { UUIDv7.make(nowMs: now()) }

    /// Saves records as local edits. Missing columns are written as null; `deleted` defaults to 0.
    @discardableResult
    public func save(_ changes: [SyncChange]) throws -> [SyncChange] {
        let stamp = now()
        let saved = try dbQueue.write { db in
            try changes.map { change in try Self.writeLocal(db, change, stamp: stamp, deviceId: deviceId) }
        }
        lock.lock()
        let handler = localWriteHandler
        lock.unlock()
        handler?()
        return saved
    }

    /// Encodes a core struct (e.g. `FoodData`) and saves it.
    @discardableResult
    public func save<T: Encodable>(_ table: String, _ value: T) throws -> SyncChange {
        try save([SyncChange.encode(table, value)])[0]
    }

    public func softDelete(_ table: String, id: Id) throws {
        guard var record = try dbQueue.read({ db in try change(db, table: table, id: id)?.record }) else { return }
        record["deleted"] = .number(1)
        try save([SyncChange(table: table, record: record)])
    }

    /// Applies a batch of plan writes (a slot save, a clear, a copy) in one transaction: `save`
    /// already writes every change inside a single `dbQueue.write`, so a record that fails partway
    /// through (a missing id, say) rolls the whole batch back rather than leaving some slots written
    /// and others not. Named separately from the generic `save` so Plan call sites read as what they
    /// are: a single all-or-nothing plan update.
    @discardableResult
    public func applyPlanChanges(_ changes: [SyncChange]) throws -> [SyncChange] {
        try save(changes)
    }

    /// Soft-deletes a log entry and its items, and returns any slot pointing at it to `planned` with
    /// the link cleared — all in one transaction, so the Plan screen is never read mid-update and a
    /// crash between the two writes can never happen (spec §5, mirrors the server's own rule).
    public func deleteLogEntry(_ id: Id) throws {
        let stamp = now()
        try dbQueue.write { db in
            guard var entryRecord = try self.change(db, table: "log_entry", id: id)?.record else { return }
            entryRecord["deleted"] = .number(1)
            _ = try Self.writeLocal(db, SyncChange(table: "log_entry", record: entryRecord), stamp: stamp, deviceId: self.deviceId)

            let items: [LogItemData] = try self.decodeRows(db, "log_item", "WHERE deleted = 0 AND log_entry_id = ?", [id])
            for item in items {
                guard var itemRecord = try self.change(db, table: "log_item", id: item.id)?.record else { continue }
                itemRecord["deleted"] = .number(1)
                _ = try Self.writeLocal(db, SyncChange(table: "log_item", record: itemRecord), stamp: stamp, deviceId: self.deviceId)
            }

            let linked: [PlanEntryData] = try self.decodeRows(db, "plan_entry", "WHERE deleted = 0 AND log_entry_id = ?", [id])
            for unlink in try PlanLogLink.unlinkChanges(linked, logEntryId: id) {
                _ = try Self.writeLocal(db, unlink, stamp: stamp, deviceId: self.deviceId)
            }
        }
        lock.lock()
        let handler = localWriteHandler
        lock.unlock()
        handler?()
    }

    /// The current row as a wire record without `server_seq`, or nil when absent.
    func change(_ db: Database, table: String, id: Id) throws -> SyncChange? {
        let columns = try TableCodec.columns(table)
        guard let row = try Row.fetchOne(
            db, sql: "SELECT \(columns.joined(separator: ", ")) FROM \(table) WHERE id = ?", arguments: [id]) else { return nil }
        var record = TableCodec.record(row)
        record.removeValue(forKey: "server_seq")
        return SyncChange(table: table, record: record)
    }

    static func writeLocal(_ db: Database, _ change: SyncChange, stamp: Int64, deviceId: String) throws -> SyncChange {
        let columns = try TableCodec.columns(change.table)
        guard let id = change.id, !id.isEmpty else { throw TableCodec.CodecError.missingId }
        var record: [String: JSONValue] = [:]
        for column in columns where column != "server_seq" {
            record[column] = change.record[column] ?? .null
        }
        record["updated_at"] = .number(Double(stamp))
        record["updated_by"] = .string(deviceId)
        record["deleted"] = change.record["deleted"] == .number(1) ? .number(1) : .number(0)
        let writeColumns = columns.filter { $0 != "server_seq" }
        try db.execute(
            sql: TableCodec.upsertSQL(change.table, writeColumns),
            arguments: StatementArguments(try writeColumns.map { try TableCodec.databaseValue($0, record[$0]) })
        )
        try db.execute(
            sql: """
            INSERT INTO sync_pending (key, table_name, record_id, queued_at) VALUES (?, ?, ?, ?)
            ON CONFLICT(key) DO NOTHING
            """,
            arguments: ["\(change.table)/\(id)", change.table, id, stamp]
        )
        // A new local edit carries every column, including the any-unit ones.
        try db.execute(sql: "DELETE FROM sync_legacy_pending WHERE key = ?", arguments: ["\(change.table)/\(id)"])
        return SyncChange(table: change.table, record: record)
    }

    func state(_ db: Database, _ key: String) throws -> String? {
        try String.fetchOne(db, sql: "SELECT value FROM sync_state WHERE key = ?", arguments: [key])
    }

    func setState(_ db: Database, _ key: String, _ value: String) throws {
        try db.execute(
            sql: "INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            arguments: [key, value]
        )
    }
}

extension SyncChange {
    /// A change for a core struct (e.g. `FoodData`), ready for `LocalStore.save`.
    public static func encode<T: Encodable>(_ table: String, _ value: T) throws -> SyncChange {
        guard case .object(let fields) = try JSONValue.from(value) else { throw TableCodec.CodecError.missingId }
        return SyncChange(table: table, record: fields)
    }
}
