import CarbBookCore
import Foundation

/// Label entry in any unit (any-unit foods addendum), mirroring web/src/foods/label.ts:
/// "amount [unit] contains N g carbs", unit ∈ g, a volume unit, or a named piece/serving.
public enum FoodLabel {
    /// Unit ids offered by label entry: "g", the core volume units, then "other" (piece/serving).
    public static let units: [String] = ["g"] + Units.volumeOrder + ["other"]
    public static let other = "other"
    /// Label of the serving portion added when a gram label is entered.
    public static let labelServing = "label serving"

    /// A portion to add or update from label entry (volume-with-weight, or a named piece/serving).
    public struct PortionPatch: Equatable, Sendable {
        public var label: String
        public var kind: String
        public var quantity: Double
        public var grams: Double?
        public var carbsG: Double?

        public init(label: String, kind: String, quantity: Double, grams: Double?, carbsG: Double?) {
            self.label = label; self.kind = kind; self.quantity = quantity; self.grams = grams; self.carbsG = carbsG
        }
    }

    public struct Basis: Equatable, Sendable {
        public var carbsPer100g: Double?
        public var carbsPer100ml: Double?
        public var portion: PortionPatch?

        public init(carbsPer100g: Double?, carbsPer100ml: Double?, portion: PortionPatch?) {
            self.carbsPer100g = carbsPer100g; self.carbsPer100ml = carbsPer100ml; self.portion = portion
        }
    }

    public static func unitName(_ unit: String) -> String {
        unit == other ? "piece / serving" : displayUnitName(unit, portions: [])
    }

    /// Carbs per 100 g rounded to 2 decimals, like the web client (`toFixed(2)`).
    static func per100g(grams: Double, carbs: Double) -> Double? {
        carbsPer100gFromLabel(servingGrams: grams, carbsPerServing: carbs).map { ($0 * 100).rounded() / 100 }
    }

    /// The carb basis a label entry maps to, or an error message. `weight` is the optional
    /// "weighs (g)" value; nil or not above 0 means no weight.
    /// - g → carbs_per_100g.
    /// - volume → carbs_per_100ml; a weight also becomes a volume portion (density for grams).
    /// - other → a count/serving portion with carbs_g (kind "serving" only when the label is literally
    ///   "serving"); a weight also sets carbs_per_100g.
    public static func basis(unit: String, amount: Double?, carbs: Double?, weight: Double?, label: String) -> Result<Basis, LabelError> {
        guard let amount, amount.isFinite, amount > 0 else { return .failure(LabelError("Enter an amount greater than 0.")) }
        guard let carbs, carbs.isFinite, carbs >= 0 else { return .failure(LabelError("Enter the carbs from the label.")) }
        let weight = weight.flatMap { $0.isFinite && $0 > 0 ? $0 : nil }

        if unit == "g" {
            let value = per100g(grams: amount, carbs: carbs)
            guard isValidCarbsPer100g(value) else { return .failure(LabelError("Carbs per 100 g must be a number from 0 to 100.")) }
            return .success(Basis(carbsPer100g: value, carbsPer100ml: nil, portion: nil))
        }

        if let ml = Units.volumeMl[unit] {
            let value = carbsPer100mlFromLabel(servingMl: amount * ml, carbsPerServing: carbs)
            guard isValidCarbsPer100ml(value) else {
                return .failure(LabelError("Carbs per 100 ml must be a number from 0 to \(NumberParsing.editText(Units.maxCarbsPer100ml))."))
            }
            let portion = weight.map { PortionPatch(label: unit, kind: "volume", quantity: amount, grams: $0, carbsG: nil) }
            return .success(Basis(carbsPer100g: nil, carbsPer100ml: value, portion: portion))
        }

        guard unit == other else { return .failure(LabelError("Pick a unit.")) }
        let trimmed = label.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return .failure(LabelError("Enter a name for the portion (e.g. \"bar\", \"slice\").")) }
        guard isValidPortionCarbs(carbs) else {
            return .failure(LabelError("Carbs per portion must be a number from 0 to \(NumberParsing.editText(Units.maxPortionCarbsG))."))
        }
        let kind = trimmed.lowercased() == "serving" ? "serving" : "count"
        var carbsPer100g: Double?
        if let weight {
            carbsPer100g = per100g(grams: weight, carbs: carbs)
            guard isValidCarbsPer100g(carbsPer100g) else { return .failure(LabelError("Carbs per 100 g must be a number from 0 to 100.")) }
        }
        return .success(Basis(carbsPer100g: carbsPer100g, carbsPer100ml: nil,
                              portion: PortionPatch(label: trimmed, kind: kind, quantity: amount, grams: weight, carbsG: carbs)))
    }

    /// Carbs in a serving of `grams` at `carbsPer100g`, 2 decimals (display/prefill only).
    public static func servingCarbs(carbsPer100g: Double?, grams: Double?) -> Double? {
        guard isValidCarbsPer100g(carbsPer100g), let grams, grams.isFinite, grams > 0 else { return nil }
        return (carbsPer100g! * grams / 100 * 100).rounded() / 100
    }

    /// The carb basis per serving where the food has one ("24 g carbs per bar", "24 g carbs per label
    /// serving (35 g)", "48 g carbs per cup"), then per 100 g; nil with no valid basis (web `foodBasisSummary`).
    public static func basisSummary(_ food: FoodData, _ portions: [PortionData]) -> String? {
        // Lowest id first, so web and iOS pick the same portion whatever order rows were loaded in.
        let byId = portions.sorted { $0.id < $1.id }
        if let piece = byId.first(where: { $0.kind != "volume" && isValidPortionCarbs($0.carbsG) }) {
            let qty = piece.quantity == 1 ? "" : "\(trim2(piece.quantity)) "
            return "\(trim2(piece.carbsG!)) g carbs per \(qty)\(piece.label)"
        }
        if isValidCarbsPer100g(food.carbsPer100g) {
            // A row with (invalid) carbs of its own is not logged from per 100 g, so it isn't a derived serving.
            if let serving = byId.first(where: { $0.kind != "volume" && $0.carbsG == nil && isValidPortionGrams($0.grams) }) {
                let qty = serving.quantity == 1 ? "" : "\(trim2(serving.quantity)) "
                return "\(trim2(food.carbsPer100g! * serving.grams! / 100)) g carbs per \(qty)\(serving.label) (\(trim2(serving.grams!)) g)"
            }
            return "\(trim2(food.carbsPer100g!)) g carbs per 100 g"
        }
        if isValidCarbsPer100ml(food.carbsPer100ml) {
            if let vp = portions.first(where: { $0.kind == "volume" && isVolumeUnit($0.label) && $0.grams != nil }) {
                let n = food.carbsPer100ml! * vp.quantity * Units.volumeMl[vp.label]! / 100
                let qty = vp.quantity == 1 ? "" : "\(trim2(vp.quantity)) "
                return "\(trim2(n)) g carbs per \(qty)\(vp.label)"
            }
            return "\(trim2(food.carbsPer100ml! * Units.volumeMl["cup"]! / 100)) g carbs per cup"
        }
        return nil
    }

    static func trim2(_ value: Double) -> String { NumberParsing.editText(value, maxFractionDigits: 2) }
}

public struct LabelError: Error, Equatable, Sendable {
    public var message: String
    public init(_ message: String) { self.message = message }
}

/// Display name for a unit id from core `foodUnits`/`mealUnits`: "floz" → "fl oz", "serving" →
/// "servings", `p:<id>` → "slice (30 g)" per one portion, or just the label when its weight is unknown.
public func displayUnitName(_ unit: String, portions: [PortionData]) -> String {
    if unit.hasPrefix(Units.portionPrefix) {
        let id = String(unit.dropFirst(Units.portionPrefix.count))
        guard let portion = portions.first(where: { $0.id == id }) else { return "missing portion" }
        guard let grams = portion.grams, portion.quantity > 0 else { return portion.label }
        return "\(portion.label) (\(NumberParsing.editText(grams / portion.quantity, maxFractionDigits: 1)) g)"
    }
    switch unit {
    case "floz": return "fl oz"
    case Units.serving: return "servings"
    case Units.quick: return "g carbs"
    default: return unit
    }
}

/// Unit picker rows: the valid units, plus the current unit flagged invalid when it isn't one of
/// them (web UnitPicker), so a line whose food lost its basis still shows its unit and "missing data".
public func unitPickerOptions(units: [String], current: String) -> [(unit: String, valid: Bool)] {
    let rows = units.map { (unit: $0, valid: true) }
    return units.contains(current) ? rows : [(unit: current, valid: false)] + rows
}

/// Default amount and unit for a food added to a calculator/meal: its first listed portion (1),
/// else 100 g when mass is listed, else 1 of the first listed volume unit (cup preferred), else 100 g
/// (not valid → "missing data").
public func defaultFoodAmountAndUnit(_ food: FoodData, _ portions: [PortionData]) -> (amount: Double, unit: String) {
    let units = foodUnits(food, portions)
    if let portion = units.first(where: { $0.hasPrefix(Units.portionPrefix) }) { return (1, portion) }
    if units.contains("g") { return (100, "g") }
    if units.contains("cup") { return (1, "cup") }
    if let volume = units.first(where: isVolumeUnit) { return (1, volume) }
    return (100, "g")
}
