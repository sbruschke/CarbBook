import CarbBookCore
import Foundation
import GRDB

public struct SearchHit: Equatable, Sendable, Identifiable {
    public enum Kind: String, Sendable { case meal, food, usda }
    public var kind: Kind
    /// food/meal UUID, or "usda:<fdc_id>"
    public var id: String
    public var name: String
    public var brand: String?
    public var source: String?
    public var carbsPer100g: Double?
    /// Volume carb basis (any-unit foods); nil for meals and USDA hits.
    public var carbsPer100ml: Double?
    /// True when a count/serving portion carries valid carbs (a piece-only food).
    public var hasPortionCarbs: Bool
    /// The row's own image, carried here so a result row needs no second lookup to show a
    /// thumbnail. Always nil for USDA library hits, which have no photo.
    public var imageId: String?

    public init(kind: Kind, id: String, name: String, brand: String?, source: String?, carbsPer100g: Double?,
                carbsPer100ml: Double? = nil, hasPortionCarbs: Bool = false, imageId: String? = nil) {
        self.kind = kind; self.id = id; self.name = name; self.brand = brand; self.source = source; self.carbsPer100g = carbsPer100g
        self.carbsPer100ml = carbsPer100ml; self.hasPortionCarbs = hasPortionCarbs; self.imageId = imageId
    }

    /// Short carb basis for a result row: "28.2 g/100 g", "48 g/cup", "per piece", or nil (no carb data).
    public var basisText: String? {
        if isValidCarbsPer100g(carbsPer100g) { return "\(NumberParsing.editText(carbsPer100g, maxFractionDigits: 1)) g/100 g" }
        if isValidCarbsPer100ml(carbsPer100ml) {
            return "\(NumberParsing.editText(carbsPer100ml! * Units.volumeMl["cup"]! / 100, maxFractionDigits: 1)) g/cup"
        }
        return hasPortionCarbs ? "per piece" : nil
    }

    public var usdaFdcId: Int64? { kind == .usda ? Int64(id.dropFirst("usda:".count)) : nil }
}

extension LocalStore {
    /// Spec §6 ranking, same SQL as the server: meals + custom foods, then other saved foods
    /// (most recently logged first), bm25 within a tier; then the USDA library fills the rest.
    public func search(_ input: String, limit: Int, usda: UsdaLibrary?) throws -> [SearchHit] {
        guard let query = toFtsQuery(input) else { return [] }
        let userHits = try dbQueue.read { db in
            try Row.fetchAll(
                db,
                sql: """
                SELECT catalog_fts.kind AS kind, catalog_fts.ref_id AS id, catalog_fts.name AS name,
                       nullif(catalog_fts.brand, '') AS brand, food.source AS source, food.carbs_per_100g AS carbs,
                       food.carbs_per_100ml AS carbs_ml, coalesce(food.image_id, meal.image_id) AS image_id,
                       EXISTS (SELECT 1 FROM portion p WHERE p.food_id = catalog_fts.ref_id AND p.deleted = 0 AND p.kind != 'volume'
                                  AND p.carbs_g >= 0 AND p.carbs_g <= 500) AS portion_carbs,
                       CASE WHEN catalog_fts.kind = 'meal' OR food.source = 'custom' THEN 0 ELSE 1 END AS tier,
                       (SELECT max(log_entry.eaten_at) FROM log_item
                          JOIN log_entry ON log_entry.id = log_item.log_entry_id
                         WHERE log_item.ref_id = catalog_fts.ref_id AND log_item.deleted = 0 AND log_entry.deleted = 0
                       ) AS last_logged
                  FROM catalog_fts
                  LEFT JOIN food ON catalog_fts.kind = 'food' AND food.id = catalog_fts.ref_id
                  LEFT JOIN meal ON catalog_fts.kind = 'meal' AND meal.id = catalog_fts.ref_id
                 WHERE catalog_fts MATCH ?
                 ORDER BY tier, last_logged DESC NULLS LAST, bm25(catalog_fts)
                 LIMIT ?
                """,
                arguments: [query, limit]
            ).map { row -> SearchHit in
                let kind: String = row["kind"]
                return SearchHit(kind: kind == "meal" ? .meal : .food, id: row["id"], name: row["name"],
                                 brand: row["brand"], source: row["source"], carbsPer100g: row["carbs"],
                                 carbsPer100ml: row["carbs_ml"], hasPortionCarbs: row["portion_carbs"],
                                 imageId: row["image_id"])
            }
        }
        let remaining = limit - userHits.count
        guard remaining > 0, let usda else { return userHits }
        return userHits + (try usda.search(input, limit: remaining))
    }
}
