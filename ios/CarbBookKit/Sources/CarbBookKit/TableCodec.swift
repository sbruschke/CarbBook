import CarbBookCore
import Foundation
import GRDB

/// Converts between sync records (`[String: JSONValue]`, wire shape) and SQLite rows.
enum TableCodec {
    static let dataColumns: [String: [String]] = [
        "food": ["name", "brand", "source", "source_ref", "derived_from", "carbs_per_100g", "carbs_per_100ml", "fiber_per_100g",
                 "density_g_per_ml", "notes"],
        "portion": ["food_id", "label", "kind", "quantity", "grams", "carbs_g"],
        "barcode": ["code", "food_id"],
        "meal": ["name", "yield_servings", "total_weight_g", "notes"],
        "meal_item": ["meal_id", "ref_type", "ref_id", "amount", "unit", "position"],
        "log_entry": ["eaten_at", "window_name", "bg_mgdl", "bg_source", "bg_trend", "total_carbs_g", "suggested_units",
                      "taken_units", "settings_version_id", "notes"],
        "log_item": ["log_entry_id", "ref_type", "ref_id", "display_name", "amount", "unit", "carbs_g"],
        "dose_settings": ["effective_from", "windows", "correction", "rounding"],
    ]
    /// Stored as JSON text, sent as JSON objects/arrays on the wire. Explicit nulls inside them
    /// (e.g. `rounding.round_down_below_bg`) are preserved: `JSONValue.null` encodes as `null`.
    /// Columns added by the any-unit foods migration. Omitted from the push of a row that was pending
    /// before the migration (see `Schema.v2AnyUnitFoods`), so the server keeps its stored values.
    static let anyUnitColumns: [String: [String]] = ["food": ["carbs_per_100ml"], "portion": ["carbs_g"]]
    static let jsonColumns: Set<String> = ["windows", "correction", "rounding"]
    static let integerColumns: Set<String> = ["eaten_at", "effective_from", "position", "updated_at", "deleted", "server_seq"]

    enum CodecError: Error, Equatable {
        case unknownTable(String)
        case missingId
    }

    static func columns(_ table: String) throws -> [String] {
        guard let data = dataColumns[table] else { throw CodecError.unknownTable(table) }
        return ["id"] + data + ["updated_at", "updated_by", "deleted", "server_seq"]
    }

    static func databaseValue(_ column: String, _ value: JSONValue?) throws -> DatabaseValue {
        guard let value, value != .null else { return .null }
        if jsonColumns.contains(column) {
            let text = String(decoding: try JSONEncoder().encode(value), as: UTF8.self)
            return text.databaseValue
        }
        switch value {
        case .null: return .null
        case .bool(let b): return (b ? 1 : 0).databaseValue
        case .number(let n): return integerColumns.contains(column) ? Int64(n).databaseValue : n.databaseValue
        case .string(let s): return s.databaseValue
        case .array, .object:
            let text = String(decoding: try JSONEncoder().encode(value), as: UTF8.self)
            return text.databaseValue
        }
    }

    static func jsonValue(_ column: String, _ value: DatabaseValue) -> JSONValue {
        switch value.storage {
        case .null: return .null
        case .int64(let i): return .number(Double(i))
        case .double(let d): return .number(d)
        case .string(let s):
            if jsonColumns.contains(column), let parsed = try? JSONDecoder().decode(JSONValue.self, from: Data(s.utf8)) {
                return parsed
            }
            return .string(s)
        case .blob(let data): return .string(data.base64EncodedString())
        }
    }

    /// Wire record for a row; `server_seq` is omitted when null.
    static func record(_ row: Row) -> [String: JSONValue] {
        var record: [String: JSONValue] = [:]
        for (column, value) in row {
            if column == "server_seq" && value.isNull { continue }
            record[column] = jsonValue(column, value)
        }
        return record
    }

    /// `INSERT … ON CONFLICT(id) DO UPDATE` for every column in `columns`.
    static func upsertSQL(_ table: String, _ columns: [String]) -> String {
        let placeholders = Array(repeating: "?", count: columns.count).joined(separator: ", ")
        let updates = columns.filter { $0 != "id" }.map { "\($0) = excluded.\($0)" }.joined(separator: ", ")
        return "INSERT INTO \(table) (\(columns.joined(separator: ", "))) VALUES (\(placeholders)) ON CONFLICT(id) DO UPDATE SET \(updates)"
    }
}
