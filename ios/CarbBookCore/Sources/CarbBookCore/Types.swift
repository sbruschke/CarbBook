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
    /// Volume carb basis (any-unit foods addendum). Valid when finite 0...150.
    public var carbsPer100ml: Double?
    public var fiberPer100g: Double?
    public var densityGPerMl: Double?
    public var notes: String?
    /// Optional image, referencing `image.id` (images spec). A dangling id renders as no image.
    public var imageId: Id?
    public var deleted: Int?

    public init(id: Id, name: String, brand: String? = nil, source: String? = nil, sourceRef: String? = nil,
                derivedFrom: Id? = nil, carbsPer100g: Double?, carbsPer100ml: Double? = nil, fiberPer100g: Double? = nil,
                densityGPerMl: Double? = nil, notes: String? = nil, imageId: Id? = nil, deleted: Int? = nil) {
        self.id = id; self.name = name; self.brand = brand; self.source = source; self.sourceRef = sourceRef
        self.derivedFrom = derivedFrom; self.carbsPer100g = carbsPer100g; self.carbsPer100ml = carbsPer100ml
        self.fiberPer100g = fiberPer100g
        self.densityGPerMl = densityGPerMl; self.notes = notes; self.imageId = imageId; self.deleted = deleted
    }

    enum CodingKeys: String, CodingKey {
        case id, name, brand, source, notes, deleted
        case sourceRef = "source_ref"
        case imageId = "image_id"
        case derivedFrom = "derived_from"
        case carbsPer100g = "carbs_per_100g"
        case carbsPer100ml = "carbs_per_100ml"
        case fiberPer100g = "fiber_per_100g"
        case densityGPerMl = "density_g_per_ml"
    }

    /// Explicit, so nil `carbs_per_100ml` is sent as JSON `null` rather than omitted (synthesized
    /// Codable uses `encodeIfPresent`). The server treats a missing key as "keep the stored value",
    /// so explicit `null` is the unambiguous way to clear it.
    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(name, forKey: .name)
        try container.encodeIfPresent(brand, forKey: .brand)
        try container.encodeIfPresent(source, forKey: .source)
        try container.encodeIfPresent(sourceRef, forKey: .sourceRef)
        try container.encodeIfPresent(derivedFrom, forKey: .derivedFrom)
        try container.encodeIfPresent(carbsPer100g, forKey: .carbsPer100g)
        try container.encode(carbsPer100ml, forKey: .carbsPer100ml)
        try container.encodeIfPresent(fiberPer100g, forKey: .fiberPer100g)
        try container.encodeIfPresent(densityGPerMl, forKey: .densityGPerMl)
        try container.encodeIfPresent(notes, forKey: .notes)
        try container.encodeIfPresent(imageId, forKey: .imageId)
        try container.encodeIfPresent(deleted, forKey: .deleted)
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
    /// Weight of `quantity` portions; nil when unknown. Valid when finite > 0.
    public var grams: Double?
    /// Carbs for `quantity` portions; nil when unknown. Valid when finite 0...500.
    public var carbsG: Double?
    public var deleted: Int?

    public init(id: Id, foodId: Id, label: String, kind: String, quantity: Double, grams: Double?, carbsG: Double? = nil,
                deleted: Int? = nil) {
        self.id = id; self.foodId = foodId; self.label = label; self.kind = kind
        self.quantity = quantity; self.grams = grams; self.carbsG = carbsG; self.deleted = deleted
    }

    enum CodingKeys: String, CodingKey {
        case id, label, kind, quantity, grams, deleted
        case foodId = "food_id"
        case carbsG = "carbs_g"
    }

    /// Explicit, so nil `grams`/`carbs_g` are sent as JSON `null` rather than omitted. The server
    /// treats a missing key as "keep the stored value", so explicit `null` is the unambiguous clear.
    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(foodId, forKey: .foodId)
        try container.encode(label, forKey: .label)
        try container.encode(kind, forKey: .kind)
        try container.encode(quantity, forKey: .quantity)
        try container.encode(grams, forKey: .grams)
        try container.encode(carbsG, forKey: .carbsG)
        try container.encodeIfPresent(deleted, forKey: .deleted)
    }
}

public struct MealData: Codable, Equatable, Sendable {
    public var id: Id
    public var name: String
    public var yieldServings: Double
    public var totalWeightG: Double?
    public var notes: String?
    /// Optional image, referencing `image.id` (images spec). A dangling id renders as no image.
    public var imageId: Id?
    public var deleted: Int?

    public init(id: Id, name: String, yieldServings: Double, totalWeightG: Double? = nil, notes: String? = nil,
                imageId: Id? = nil, deleted: Int? = nil) {
        self.id = id; self.name = name; self.yieldServings = yieldServings
        self.totalWeightG = totalWeightG; self.notes = notes; self.imageId = imageId; self.deleted = deleted
    }

    enum CodingKeys: String, CodingKey {
        case id, name, notes, deleted
        case yieldServings = "yield_servings"
        case totalWeightG = "total_weight_g"
        case imageId = "image_id"
    }
}

public enum RefType: String, Codable, Sendable {
    /// `quick`: a carbs-only row with no food (quick-carbs spec §2) — amount is grams of carbs, unit "carbs".
    case food, meal, quick
}

public struct MealItemData: Codable, Equatable, Sendable {
    public var id: Id
    public var mealId: Id
    public var refType: RefType
    public var refId: Id
    public var amount: Double
    public var unit: String
    public var position: Int
    /// Quick carbs rows only: optional text, at most 80 characters.
    public var label: String?
    public var deleted: Int?

    public init(id: Id, mealId: Id, refType: RefType, refId: Id, amount: Double, unit: String, position: Int,
                label: String? = nil, deleted: Int? = nil) {
        self.id = id; self.mealId = mealId; self.refType = refType; self.refId = refId
        self.amount = amount; self.unit = unit; self.position = position; self.label = label; self.deleted = deleted
    }

    enum CodingKeys: String, CodingKey {
        case id, amount, unit, position, label, deleted
        case mealId = "meal_id"
        case refType = "ref_type"
        case refId = "ref_id"
    }

    /// Explicit, so a nil `label` is sent as JSON `null`: the server reads a missing key as "keep the
    /// stored value", so only an explicit null clears a label.
    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(mealId, forKey: .mealId)
        try container.encode(refType, forKey: .refType)
        try container.encode(refId, forKey: .refId)
        try container.encode(amount, forKey: .amount)
        try container.encode(unit, forKey: .unit)
        try container.encode(position, forKey: .position)
        try container.encode(label, forKey: .label)
        try container.encodeIfPresent(deleted, forKey: .deleted)
    }
}

public struct DoseWindow: Codable, Equatable, Sendable {
    public var name: String
    /// "HH:MM", 24-hour local time
    public var start: String
    public var ratioGPerUnit: Double
    /// Per-window carb target, or nil for no goal. Dose math ignores it (spec §2).
    public var carbGoal: CarbGoal?

    public init(name: String, start: String, ratioGPerUnit: Double, carbGoal: CarbGoal? = nil) {
        self.name = name; self.start = start; self.ratioGPerUnit = ratioGPerUnit; self.carbGoal = carbGoal
    }

    enum CodingKeys: String, CodingKey {
        case name, start
        case ratioGPerUnit = "ratio_g_per_unit"
        case carbGoal = "carb_goal"
    }

    /// Explicit, so "no goal" is sent as JSON `null` rather than omitted: a missing key means "keep
    /// the stored value" on the server, so only an explicit null clears a goal.
    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(name, forKey: .name)
        try container.encode(start, forKey: .start)
        try container.encode(ratioGPerUnit, forKey: .ratioGPerUnit)
        try container.encode(carbGoal, forKey: .carbGoal)
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
