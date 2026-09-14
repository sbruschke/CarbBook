import Foundation

/// Carbs per 100 g from a nutrition label ("serving 30 g, 22 g carbs" → 73.33).
/// nil when the serving weight is not positive, carbs are negative, or carbs exceed the serving.
public func carbsPer100gFromLabel(servingGrams: Double, carbsPerServing: Double) -> Double? {
    guard servingGrams.isFinite, servingGrams > 0, carbsPerServing.isFinite, carbsPerServing >= 0,
          carbsPerServing <= servingGrams else { return nil }
    return carbsPerServing / servingGrams * 100
}

/// Food editor validation with the server's push rules: non-empty name, `carbs_per_100g` and
/// `fiber_per_100g` within 0...100 (or empty), density above zero (or empty). nil when valid.
public func validateFood(_ food: FoodData) -> String? {
    if food.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "name must not be empty" }
    if let carbs = food.carbsPer100g, !(carbs.isFinite && carbs >= 0 && carbs <= 100) { return "carbs_per_100g must be between 0 and 100" }
    if let fiber = food.fiberPer100g, !(fiber.isFinite && fiber >= 0 && fiber <= 100) { return "fiber_per_100g must be between 0 and 100" }
    if let density = food.densityGPerMl, !(density.isFinite && density > 0) { return "density_g_per_ml must be > 0" }
    return nil
}

/// A row of the USDA SQLite bundle's `usda_food` table.
public struct UsdaFood: Equatable, Sendable {
    public var fdcId: Int64
    public var name: String
    public var carbsPer100g: Double?
    public var fiberPer100g: Double?

    public init(fdcId: Int64, name: String, carbsPer100g: Double?, fiberPer100g: Double?) {
        self.fdcId = fdcId; self.name = name; self.carbsPer100g = carbsPer100g; self.fiberPer100g = fiberPer100g
    }
}

/// A row of the USDA SQLite bundle's `usda_portion` table.
public struct UsdaPortion: Equatable, Sendable {
    public var id: Int64
    public var fdcId: Int64
    public var label: String
    public var kind: String
    public var quantity: Double
    public var grams: Double
    public var description: String

    public init(id: Int64, fdcId: Int64, label: String, kind: String, quantity: Double, grams: Double, description: String) {
        self.id = id; self.fdcId = fdcId; self.label = label; self.kind = kind
        self.quantity = quantity; self.grams = grams; self.description = description
    }
}

/// Deterministic ids for a copied USDA food, byte-identical to the web client's scheme
/// (carbbook-web-data plan, decision 1 / web/src/lib/ids.ts `usdaFoodId`/`usdaPortionId`):
/// `usda-<fdc_id>` for the food, `usda-portion-<usda portion row id>` for each portion.
public func usdaFoodId(_ fdcId: Int64) -> Id { "usda-\(fdcId)" }
public func usdaPortionId(_ usdaPortionRowId: Int64) -> Id { "usda-portion-\(usdaPortionRowId)" }

/// The synced copy of a USDA food used in a meal or log: `source = "usda"`, `source_ref = fdc_id`,
/// portions copied in bundle order. Ids are deterministic (`usdaFoodId`/`usdaPortionId`), not fresh
/// UUIDv7s, so two devices copying the same USDA food offline converge on one row via LWW instead
/// of creating duplicates.
public func copyUsdaFood(_ usda: UsdaFood, portions: [UsdaPortion]) -> (food: FoodData, portions: [PortionData]) {
    let food = FoodData(id: usdaFoodId(usda.fdcId), name: usda.name, source: "usda", sourceRef: String(usda.fdcId),
                        carbsPer100g: usda.carbsPer100g, fiberPer100g: usda.fiberPer100g)
    let copied = portions.map {
        PortionData(id: usdaPortionId($0.id), foodId: food.id, label: $0.label, kind: $0.kind, quantity: $0.quantity, grams: $0.grams)
    }
    return (food, copied)
}

/// `draft` from GET /api/barcode/:code (server normalize.ts `FoodDraft`).
public struct OffDraft: Codable, Equatable, Sendable {
    public struct Food: Codable, Equatable, Sendable {
        public var name: String
        public var brand: String?
        public var source: String
        public var sourceRef: String
        public var carbsPer100g: Double?
        public var fiberPer100g: Double?

        enum CodingKeys: String, CodingKey {
            case name, brand, source
            case sourceRef = "source_ref"
            case carbsPer100g = "carbs_per_100g"
            case fiberPer100g = "fiber_per_100g"
        }
    }

    public struct Portion: Codable, Equatable, Sendable {
        public var label: String
        public var kind: String
        public var quantity: Double
        public var grams: Double
    }

    public var food: Food
    public var portions: [Portion]
    public var barcode: String
    public var servingSize: String?

    enum CodingKeys: String, CodingKey {
        case food, portions, barcode
        case servingSize = "serving_size"
    }
}

/// A barcode row as synced (§3 `barcode`).
public struct BarcodeData: Codable, Equatable, Sendable {
    public var id: Id
    public var code: String
    public var foodId: Id

    public init(id: Id, code: String, foodId: Id) {
        self.id = id; self.code = code; self.foodId = foodId
    }

    enum CodingKeys: String, CodingKey {
        case id, code
        case foodId = "food_id"
    }
}

/// Records to save once the user confirms an Open Food Facts draft (possibly after editing `food`).
public func recordsFromOffDraft(_ draft: OffDraft, confirmed food: OffDraft.Food, newId: () -> Id)
    -> (food: FoodData, portions: [PortionData], barcode: BarcodeData) {
    let saved = FoodData(id: newId(), name: food.name, brand: food.brand, source: "off", sourceRef: food.sourceRef,
                         carbsPer100g: food.carbsPer100g, fiberPer100g: food.fiberPer100g)
    let portions = draft.portions.map {
        PortionData(id: newId(), foodId: saved.id, label: $0.label, kind: $0.kind, quantity: $0.quantity, grams: $0.grams)
    }
    return (saved, portions, BarcodeData(id: newId(), code: draft.barcode, foodId: saved.id))
}
