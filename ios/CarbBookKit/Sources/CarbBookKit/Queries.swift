import CarbBookCore
import Foundation
import GRDB

/// Read queries for the screens. Rows are decoded into core structs through their wire shape.
extension LocalStore {
    func decodeRows<T: Decodable>(_ db: Database, _ table: String, _ sqlSuffix: String, _ arguments: StatementArguments = []) throws -> [T] {
        let columns = try TableCodec.columns(table)
        return try Row.fetchAll(db, sql: "SELECT \(columns.joined(separator: ", ")) FROM \(table) \(sqlSuffix)", arguments: arguments)
            .map { try JSONValue.object(TableCodec.record($0)).decode(T.self) }
    }

    public func records<T: Decodable>(_ table: String, _ sqlSuffix: String = "WHERE deleted = 0", _ arguments: StatementArguments = []) throws -> [T] {
        try dbQueue.read { db in try decodeRows(db, table, sqlSuffix, arguments) }
    }

    /// Everything carb math needs, without deleted rows.
    public func catalog() throws -> InMemoryCatalog {
        try dbQueue.read { db in
            InMemoryCatalog(
                foods: try decodeRows(db, "food", "WHERE deleted = 0"),
                portions: try decodeRows(db, "portion", "WHERE deleted = 0"),
                meals: try decodeRows(db, "meal", "WHERE deleted = 0"),
                mealItems: try decodeRows(db, "meal_item", "WHERE deleted = 0")
            )
        }
    }

    public func doseSettingsVersions() throws -> [DoseSettingsData] {
        try records("dose_settings", "WHERE deleted = 0 ORDER BY effective_from DESC, id DESC")
    }

    public func foods() throws -> [FoodData] { try records("food", "WHERE deleted = 0 ORDER BY name COLLATE NOCASE") }
    public func meals() throws -> [MealData] { try records("meal", "WHERE deleted = 0 ORDER BY name COLLATE NOCASE") }

    public func portions(foodId: Id) throws -> [PortionData] {
        try records("portion", "WHERE deleted = 0 AND food_id = ? ORDER BY grams", [foodId])
    }

    public func mealItems(mealId: Id) throws -> [MealItemData] {
        try records("meal_item", "WHERE deleted = 0 AND meal_id = ? ORDER BY position", [mealId])
    }

    /// Entries with `from ≤ eaten_at < to`, newest first.
    public func logEntries(from: Int64, to: Int64) throws -> [LogEntryData] {
        try records("log_entry", "WHERE deleted = 0 AND eaten_at >= ? AND eaten_at < ? ORDER BY eaten_at DESC", [from, to])
    }

    public func logItems(entryId: Id) throws -> [LogItemData] {
        try records("log_item", "WHERE deleted = 0 AND log_entry_id = ? ORDER BY rowid", [entryId])
    }

    /// Unpushed local changes (Settings → Sync).
    public func pendingCount() throws -> Int {
        try dbQueue.read { db in try Int.fetchOne(db, sql: "SELECT count(*) FROM sync_pending") ?? 0 }
    }

    /// Time of the latest logged entry with a taken dose (4-hour warning, spec §4.3).
    public func lastDoseAtMs() throws -> Int64? {
        try dbQueue.read { db in
            try Int64.fetchOne(db, sql: "SELECT max(eaten_at) FROM log_entry WHERE deleted = 0 AND taken_units > 0")
        }
    }

    /// Same as `lastDoseAtMs()`, excluding one entry: the Log editor's own recent-dose warning must
    /// not fire on the entry being edited (its own taken dose isn't "another" recent dose).
    public func lastDoseAtMs(excluding entryId: Id) throws -> Int64? {
        try dbQueue.read { db in
            try Int64.fetchOne(
                db, sql: "SELECT max(eaten_at) FROM log_entry WHERE deleted = 0 AND taken_units > 0 AND id != ?",
                arguments: [entryId])
        }
    }

    /// Local barcode lookup, including UPC-A/EAN-13 zero-padding variants.
    public func foodForBarcode(_ code: String) throws -> (food: FoodData, portions: [PortionData])? {
        let candidates = barcodeCandidates(code)
        let placeholders = candidates.map { _ in "?" }.joined(separator: ", ")
        let foods: [FoodData] = try records(
            "food",
            """
            WHERE deleted = 0 AND id IN (SELECT food_id FROM barcode WHERE deleted = 0 AND code IN (\(placeholders)))
            ORDER BY updated_at DESC LIMIT 1
            """,
            StatementArguments(candidates))
        guard let food = foods.first else { return nil }
        return (food, try portions(foodId: food.id))
    }

    public func queueBarcode(_ code: String, note: String?) throws {
        try dbQueue.write { db in
            try db.execute(
                sql: "INSERT INTO barcode_queue (code, note, queued_at) VALUES (?, ?, ?) ON CONFLICT(code) DO UPDATE SET note = excluded.note",
                arguments: [code, note, now()])
        }
    }

    public func queuedBarcodes() throws -> [(code: String, note: String?)] {
        try dbQueue.read { db in
            try Row.fetchAll(db, sql: "SELECT code, note FROM barcode_queue ORDER BY queued_at").map { ($0["code"], $0["note"]) }
        }
    }

    public func removeQueuedBarcode(_ code: String) throws {
        try dbQueue.write { db in try db.execute(sql: "DELETE FROM barcode_queue WHERE code = ?", arguments: [code]) }
    }
}
