import CarbBookCore
import Foundation

/// Maps one row of the food editor's Portions section (Quantity + Unit + optional Carbs + optional
/// Weight) to what gets saved. Mirrors the any-unit foods addendum's volume rule: a volume portion
/// can never carry `carbs_g` (server rule), so carbs entered against a volume unit set the food's
/// `carbsPer100ml` instead of the portion row, and a carbs-only row (no weight) saves no portion row
/// at all — only `carbsPer100ml`. A named piece/serving (not a volume unit) works as before: quantity
/// + optional grams + optional carbs, at least one of grams/carbs required by the caller.
public enum PortionEntry {
    public struct Input: Equatable, Sendable {
        /// A core volume unit id ("ml", "l", "tsp", "tbsp", "floz", "cup"), or any other string for a
        /// named piece/serving (the name itself, e.g. "slice", "serving").
        public var unit: String
        public var quantity: Double
        /// nil = not entered.
        public var grams: Double?
        /// nil = not entered.
        public var carbs: Double?

        public init(unit: String, quantity: Double, grams: Double?, carbs: Double?) {
            self.unit = unit; self.quantity = quantity; self.grams = grams; self.carbs = carbs
        }
    }

    public struct Output: Equatable, Sendable {
        /// The portion row to save, or nil for a volume row that only had carbs (no weight).
        public var portion: FoodLabel.PortionPatch?
        /// Set (unvalidated against the max) when a volume unit's carbs were entered: replaces the
        /// food's `carbsPer100ml`. Callers range-check it with `isValidCarbsPer100ml`.
        public var carbsPer100ml: Double?

        public init(portion: FoodLabel.PortionPatch?, carbsPer100ml: Double?) {
            self.portion = portion; self.carbsPer100ml = carbsPer100ml
        }
    }

    /// `input.quantity` must already be validated (> 0) by the caller.
    public static func map(_ input: Input) -> Output {
        if let mlPerUnit = Units.volumeMl[input.unit] {
            let carbsPer100ml = input.carbs.flatMap {
                carbsPer100mlFromLabel(servingMl: input.quantity * mlPerUnit, carbsPerServing: $0)
            }
            let portion = input.grams.map {
                FoodLabel.PortionPatch(label: input.unit, kind: "volume", quantity: input.quantity, grams: $0, carbsG: nil)
            }
            return Output(portion: portion, carbsPer100ml: carbsPer100ml)
        }
        let trimmed = input.unit.trimmingCharacters(in: .whitespacesAndNewlines)
        let kind = trimmed.lowercased() == "serving" ? "serving" : "count"
        let portion = FoodLabel.PortionPatch(label: trimmed, kind: kind, quantity: input.quantity, grams: input.grams, carbsG: input.carbs)
        return Output(portion: portion, carbsPer100ml: nil)
    }
}
