import Foundation

/// Meal-plan slot status (spec §2).
public enum PlanStatus: String, Codable, Equatable, Sendable {
    case planned, logged, skipped
}

/// One planned slot: at most one non-deleted row per (date, window_name); a second is rejected
/// by the server as `duplicate_slot`.
public struct PlanEntryData: Codable, Equatable, Sendable {
    public var id: Id
    /// "YYYY-MM-DD", local date.
    public var date: String
    /// Matches a dose-settings window name.
    public var windowName: String
    public var status: PlanStatus
    public var note: String?
    /// Set when this slot was logged from the Calculator.
    public var logEntryId: Id?
    public var deleted: Int?

    public init(id: Id, date: String, windowName: String, status: PlanStatus, note: String? = nil,
                logEntryId: Id? = nil, deleted: Int? = nil) {
        self.id = id; self.date = date; self.windowName = windowName; self.status = status
        self.note = note; self.logEntryId = logEntryId; self.deleted = deleted
    }

    enum CodingKeys: String, CodingKey {
        case id, date, status, note, deleted
        case windowName = "window_name"
        case logEntryId = "log_entry_id"
    }

    /// Explicit, so clearing a note or a log link is sent as JSON `null` rather than omitted (the
    /// server reads a missing key as "keep the stored value").
    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(date, forKey: .date)
        try container.encode(windowName, forKey: .windowName)
        try container.encode(status, forKey: .status)
        try container.encode(note, forKey: .note)
        try container.encode(logEntryId, forKey: .logEntryId)
        try container.encodeIfPresent(deleted, forKey: .deleted)
    }
}

/// One row inside a planned slot: the same shape as `log_item` minus the snapshot fields
/// (`display_name`, `carbs_g`). Plans never snapshot; carbs are computed live with `itemCarbs`.
public struct PlanItemData: Codable, Equatable, Sendable {
    public var id: Id
    public var planEntryId: Id
    public var refType: RefType
    public var refId: Id
    public var amount: Double
    public var unit: String
    public var position: Int
    public var deleted: Int?

    public init(id: Id, planEntryId: Id, refType: RefType, refId: Id, amount: Double, unit: String,
                position: Int, deleted: Int? = nil) {
        self.id = id; self.planEntryId = planEntryId; self.refType = refType; self.refId = refId
        self.amount = amount; self.unit = unit; self.position = position; self.deleted = deleted
    }

    enum CodingKeys: String, CodingKey {
        case id, amount, unit, position, deleted
        case planEntryId = "plan_entry_id"
        case refType = "ref_type"
        case refId = "ref_id"
    }
}
