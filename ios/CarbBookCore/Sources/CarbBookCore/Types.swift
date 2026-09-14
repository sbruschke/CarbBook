import Foundation

/// Mirrors packages/core/src/types.ts. Property names are Swift-cased; coding keys are the
/// §3 column names so the same structs decode test vectors and sync records.
public typealias Id = String

public struct FoodData: Codable, Equatable, Sendable {
    public var id: Id
    public var name: String
    public var brand: String?
    public var source: String?
    public var sourceRef: String?
    public var derivedFrom: Id?
    public var carbsPer100g: Double?
    public var fiberPer100g: Double?
    public var densityGPerMl: Double?
    public var notes: String?
    public var deleted: Int?

    public init(id: Id, name: String, brand: String? = nil, source: String? = nil, sourceRef: String? = nil,
                derivedFrom: Id? = nil, carbsPer100g: Double?, fiberPer100g: Double? = nil,
                densityGPerMl: Double? = nil, notes: String? = nil, deleted: Int? = nil) {
        self.id = id; self.name = name; self.brand = brand; self.source = source; self.sourceRef = sourceRef
        self.derivedFrom = derivedFrom; self.carbsPer100g = carbsPer100g; self.fiberPer100g = fiberPer100g
        self.densityGPerMl = densityGPerMl; self.notes = notes; self.deleted = deleted
    }

    enum CodingKeys: String, CodingKey {
        case id, name, brand, source, notes, deleted
        case sourceRef = "source_ref"
        case derivedFrom = "derived_from"
        case carbsPer100g = "carbs_per_100g"
        case fiberPer100g = "fiber_per_100g"
        case densityGPerMl = "density_g_per_ml"
    }
}

public struct PortionData: Codable, Equatable, Sendable {
    public var id: Id
    public var foodId: Id
    /// For kind "volume" this must be a volume unit id (e.g. "cup"); otherwise free text ("slice").
    public var label: String
    /// "volume" | "count" | "serving"
    public var kind: String
    public var quantity: Double
    public var grams: Double
    public var deleted: Int?

    public init(id: Id, foodId: Id, label: String, kind: String, quantity: Double, grams: Double, deleted: Int? = nil) {
        self.id = id; self.foodId = foodId; self.label = label; self.kind = kind
        self.quantity = quantity; self.grams = grams; self.deleted = deleted
    }

    enum CodingKeys: String, CodingKey {
        case id, label, kind, quantity, grams, deleted
        case foodId = "food_id"
    }
}

public struct MealData: Codable, Equatable, Sendable {
    public var id: Id
    public var name: String
    public var yieldServings: Double
    public var totalWeightG: Double?
    public var notes: String?
    public var deleted: Int?

    public init(id: Id, name: String, yieldServings: Double, totalWeightG: Double? = nil, notes: String? = nil, deleted: Int? = nil) {
        self.id = id; self.name = name; self.yieldServings = yieldServings
        self.totalWeightG = totalWeightG; self.notes = notes; self.deleted = deleted
    }

    enum CodingKeys: String, CodingKey {
        case id, name, notes, deleted
        case yieldServings = "yield_servings"
        case totalWeightG = "total_weight_g"
    }
}

public enum RefType: String, Codable, Sendable {
    case food, meal
}

public struct MealItemData: Codable, Equatable, Sendable {
    public var id: Id
    public var mealId: Id
    public var refType: RefType
    public var refId: Id
    public var amount: Double
    public var unit: String
    public var position: Int
    public var deleted: Int?

    public init(id: Id, mealId: Id, refType: RefType, refId: Id, amount: Double, unit: String, position: Int, deleted: Int? = nil) {
        self.id = id; self.mealId = mealId; self.refType = refType; self.refId = refId
        self.amount = amount; self.unit = unit; self.position = position; self.deleted = deleted
    }

    enum CodingKeys: String, CodingKey {
        case id, amount, unit, position, deleted
        case mealId = "meal_id"
        case refType = "ref_type"
        case refId = "ref_id"
    }
}

public struct DoseWindow: Codable, Equatable, Sendable {
    public var name: String
    /// "HH:MM", 24-hour local time
    public var start: String
    public var ratioGPerUnit: Double

    public init(name: String, start: String, ratioGPerUnit: Double) {
        self.name = name; self.start = start; self.ratioGPerUnit = ratioGPerUnit
    }

    enum CodingKeys: String, CodingKey {
        case name, start
        case ratioGPerUnit = "ratio_g_per_unit"
    }
}

public struct CorrectionRule: Codable, Equatable, Sendable {
    public var threshold: Double
    public var step: Double
    public var unitsPerStep: Double
    /// "started" | "full" | "proportional" — kept as a string so bad stored values refuse
    /// with `invalid_settings` instead of failing to decode.
    public var mode: String

    public init(threshold: Double, step: Double, unitsPerStep: Double, mode: String) {
        self.threshold = threshold; self.step = step; self.unitsPerStep = unitsPerStep; self.mode = mode
    }

    enum CodingKeys: String, CodingKey {
        case threshold, step, mode
        case unitsPerStep = "units_per_step"
    }
}

public struct RoundingRule: Codable, Equatable, Sendable {
    public var increment: Double
    public var roundDownBelowBg: Double?

    public init(increment: Double, roundDownBelowBg: Double?) {
        self.increment = increment; self.roundDownBelowBg = roundDownBelowBg
    }

    enum CodingKeys: String, CodingKey {
        case increment
        case roundDownBelowBg = "round_down_below_bg"
    }

    /// Explicit, since synthesized Codable uses `encodeIfPresent` for optionals and would omit
    /// `round_down_below_bg` entirely when nil. The server requires the key present (as JSON
    /// `null`, not missing) even when there is no cutoff.
    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(increment, forKey: .increment)
        try container.encode(roundDownBelowBg, forKey: .roundDownBelowBg)
    }
}

public struct DoseSettingsData: Codable, Equatable, Sendable {
    public var id: Id
    /// ms since epoch
    public var effectiveFrom: Int64
    public var windows: [DoseWindow]
    public var correction: CorrectionRule
    public var rounding: RoundingRule
    public var deleted: Int?

    public init(id: Id, effectiveFrom: Int64, windows: [DoseWindow], correction: CorrectionRule, rounding: RoundingRule,
                deleted: Int? = nil) {
        self.id = id; self.effectiveFrom = effectiveFrom; self.windows = windows
        self.correction = correction; self.rounding = rounding; self.deleted = deleted
    }

    enum CodingKeys: String, CodingKey {
        case id, windows, correction, rounding, deleted
        case effectiveFrom = "effective_from"
    }
}

public struct LogEntryData: Codable, Equatable, Sendable {
    public var id: Id
    public var eatenAt: Int64
    public var windowName: String?
    public var bgMgdl: Double?
    /// "dexcom" | "manual" | "none"
    public var bgSource: String
    public var bgTrend: String?
    public var totalCarbsG: Double
    public var suggestedUnits: Double?
    public var takenUnits: Double?
    public var settingsVersionId: Id?
    public var notes: String?

    public init(id: Id, eatenAt: Int64, windowName: String?, bgMgdl: Double?, bgSource: String, bgTrend: String?,
                totalCarbsG: Double, suggestedUnits: Double?, takenUnits: Double?, settingsVersionId: Id?, notes: String?) {
        self.id = id; self.eatenAt = eatenAt; self.windowName = windowName; self.bgMgdl = bgMgdl
        self.bgSource = bgSource; self.bgTrend = bgTrend; self.totalCarbsG = totalCarbsG
        self.suggestedUnits = suggestedUnits; self.takenUnits = takenUnits
        self.settingsVersionId = settingsVersionId; self.notes = notes
    }

    enum CodingKeys: String, CodingKey {
        case id, notes
        case eatenAt = "eaten_at"
        case windowName = "window_name"
        case bgMgdl = "bg_mgdl"
        case bgSource = "bg_source"
        case bgTrend = "bg_trend"
        case totalCarbsG = "total_carbs_g"
        case suggestedUnits = "suggested_units"
        case takenUnits = "taken_units"
        case settingsVersionId = "settings_version_id"
    }
}

public struct LogItemData: Codable, Equatable, Sendable {
    public var id: Id
    public var logEntryId: Id
    public var refType: RefType
    public var refId: Id
    public var displayName: String
    public var amount: Double
    public var unit: String
    public var carbsG: Double

    public init(id: Id, logEntryId: Id, refType: RefType, refId: Id, displayName: String, amount: Double, unit: String, carbsG: Double) {
        self.id = id; self.logEntryId = logEntryId; self.refType = refType; self.refId = refId
        self.displayName = displayName; self.amount = amount; self.unit = unit; self.carbsG = carbsG
    }

    enum CodingKeys: String, CodingKey {
        case id, amount, unit
        case logEntryId = "log_entry_id"
        case refType = "ref_type"
        case refId = "ref_id"
        case displayName = "display_name"
        case carbsG = "carbs_g"
    }
}
