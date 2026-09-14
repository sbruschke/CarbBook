import Foundation

/// Mirrors packages/core/src/sync.ts plus the wire format of POST /api/sync/push and
/// GET /api/sync/pull (server-data plan, "Wire formats").
public struct RecordVersion: Equatable, Sendable {
    public var updatedAt: Int64
    public var updatedBy: String

    public init(updatedAt: Int64, updatedBy: String) {
        self.updatedAt = updatedAt
        self.updatedBy = updatedBy
    }
}

/// Last-write-wins: newer timestamp wins; equal timestamps go to the higher device id, compared
/// as JS strings (UTF-16 code units). An exact replay is not newer.
public func isNewer(_ incoming: RecordVersion, than stored: RecordVersion?) -> Bool {
    guard let stored else { return true }
    if incoming.updatedAt != stored.updatedAt { return incoming.updatedAt > stored.updatedAt }
    return JS.greater(incoming.updatedBy, stored.updatedBy)
}

/// A pulled record overwrites the local row unless the local row has an unpushed change that
/// beats it under LWW (that change is pushed on the next sync and wins on the server too).
public func shouldApplyPulled(incoming: RecordVersion, local: RecordVersion?, localPending: Bool) -> Bool {
    guard let local, localPending else { return true }
    return !isNewer(local, than: incoming)
}

public enum SyncTables {
    /// Synced tables, in the server's pull order.
    public static let all = ["food", "portion", "barcode", "meal", "meal_item", "log_entry", "log_item", "dose_settings"]
}

public struct SyncChange: Codable, Equatable, Sendable {
    public var table: String
    public var record: [String: JSONValue]

    public init(table: String, record: [String: JSONValue]) {
        self.table = table
        self.record = record
    }

    public var id: String? { record["id"]?.stringValue }
    public var key: String { "\(table)/\(id ?? "")" }

    public var version: RecordVersion? {
        guard let at = record["updated_at"]?.int64Value, let by = record["updated_by"]?.stringValue else { return nil }
        return RecordVersion(updatedAt: at, updatedBy: by)
    }
}

public struct PushRequest: Codable, Equatable, Sendable {
    public var changes: [SyncChange]
    public init(changes: [SyncChange]) { self.changes = changes }
}

public struct PushResult: Codable, Equatable, Sendable {
    public var table: String
    public var id: String
    /// "accepted" | "ignored" | "rejected"
    public var status: String
    public var serverSeq: Int64?
    /// "unknown_table" | "invalid" | "forbidden" | "cycle" when rejected
    public var reason: String?
    public var message: String?

    public init(table: String, id: String, status: String, serverSeq: Int64? = nil, reason: String? = nil, message: String? = nil) {
        self.table = table; self.id = id; self.status = status; self.serverSeq = serverSeq
        self.reason = reason; self.message = message
    }

    public var key: String { "\(table)/\(id)" }

    enum CodingKeys: String, CodingKey {
        case table, id, status, reason, message
        case serverSeq = "server_seq"
    }
}

public struct PushResponse: Codable, Equatable, Sendable {
    public var results: [PushResult]
    public var serverSeq: Int64

    public init(results: [PushResult], serverSeq: Int64) {
        self.results = results
        self.serverSeq = serverSeq
    }

    enum CodingKeys: String, CodingKey {
        case results
        case serverSeq = "server_seq"
    }
}

public struct PullResponse: Codable, Equatable, Sendable {
    public var changes: [SyncChange]
    public var nextSince: Int64
    public var hasMore: Bool

    public init(changes: [SyncChange], nextSince: Int64, hasMore: Bool) {
        self.changes = changes
        self.nextSince = nextSince
        self.hasMore = hasMore
    }

    enum CodingKeys: String, CodingKey {
        case changes
        case nextSince = "next_since"
        case hasMore = "has_more"
    }
}
