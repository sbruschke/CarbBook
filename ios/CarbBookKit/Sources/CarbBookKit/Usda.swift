import CarbBookCore
import Foundation
import GRDB

/// The downloaded USDA SQLite bundle (server-data plan Task 10), opened read-only.
public final class UsdaLibrary: @unchecked Sendable {
    public let dbQueue: DatabaseQueue
    public let version: String

    public init(path: String) throws {
        var configuration = Configuration()
        configuration.readonly = true
        dbQueue = try DatabaseQueue(path: path, configuration: configuration)
        version = try dbQueue.read { db in
            try String.fetchOne(db, sql: "SELECT value FROM bundle_meta WHERE key = 'version'")
        } ?? ""
    }

    /// FTS5 prefix search ordered by bm25, like the server's USDA tier. Rows with null carbs
    /// stay searchable (`carbsPer100g == nil` → "no carb data").
    public func search(_ input: String, limit: Int) throws -> [SearchHit] {
        guard let query = toFtsQuery(input), limit > 0 else { return [] }
        return try dbQueue.read { db in
            try Row.fetchAll(
                db,
                sql: """
                SELECT usda_food.fdc_id AS fdc_id, usda_food.name AS name, usda_food.carbs_per_100g AS carbs
                  FROM usda_fts JOIN usda_food ON usda_food.fdc_id = usda_fts.rowid
                 WHERE usda_fts MATCH ? ORDER BY bm25(usda_fts) LIMIT ?
                """,
                arguments: [query, limit]
            ).map { row in
                let fdcId: Int64 = row["fdc_id"]
                return SearchHit(kind: .usda, id: "usda:\(fdcId)", name: row["name"], brand: nil, source: "usda", carbsPer100g: row["carbs"])
            }
        }
    }

    public func food(fdcId: Int64) throws -> UsdaFood? {
        try dbQueue.read { db in
            try Row.fetchOne(db, sql: "SELECT fdc_id, name, carbs_per_100g, fiber_per_100g FROM usda_food WHERE fdc_id = ?", arguments: [fdcId])
                .map { UsdaFood(fdcId: $0["fdc_id"], name: $0["name"], carbsPer100g: $0["carbs_per_100g"], fiberPer100g: $0["fiber_per_100g"]) }
        }
    }

    public func portions(fdcId: Int64) throws -> [UsdaPortion] {
        try dbQueue.read { db in
            try Row.fetchAll(
                db, sql: "SELECT id, fdc_id, label, kind, quantity, grams, description FROM usda_portion WHERE fdc_id = ? ORDER BY id",
                arguments: [fdcId]
            ).map {
                UsdaPortion(id: $0["id"], fdcId: $0["fdc_id"], label: $0["label"], kind: $0["kind"],
                            quantity: $0["quantity"], grams: $0["grams"], description: $0["description"])
            }
        }
    }
}

extension LocalStore {
    /// The synced `food` id for a USDA food, copying it (with portions) on first use (owner decision:
    /// USDA foods used in a meal or log are copied into `food` with `source = 'usda'`). Ids are the
    /// deterministic `usda-<fdc_id>` / `usda-portion-<id>` from core `copyUsdaFood`.
    public func adoptUsdaFood(fdcId: Int64, library: UsdaLibrary) throws -> Id {
        let existing: [FoodData] = try records("food", "WHERE deleted = 0 AND source = 'usda' AND source_ref = ? LIMIT 1", [String(fdcId)])
        if let food = existing.first { return food.id }
        guard let usda = try library.food(fdcId: fdcId) else { throw UsdaError.unknownFood(fdcId) }
        let copy = copyUsdaFood(usda, portions: try library.portions(fdcId: fdcId))
        try save([SyncChange.encode("food", copy.food)] + copy.portions.map { try SyncChange.encode("portion", $0) })
        return copy.food.id
    }
}

public enum UsdaError: Error, Equatable {
    case unknownFood(Int64)
    case checksumMismatch(expected: String, actual: String)
    case versionMismatch(expected: String, actual: String)
}
