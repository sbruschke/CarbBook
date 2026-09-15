import CarbBookCore
import Foundation

/// Confirming an Open Food Facts draft (spec §6), kept out of the SwiftUI target so it runs in Linux
/// tests. When OFF lists a serving weight, carbs are entered per serving (the number on the package)
/// and saved as a "serving" portion with grams + carbs_g plus carbs_per_100g from it — the same records
/// web `prefillFromDraft` → FoodEditor "From label" produces. Without a serving weight, per 100 g.
public struct OffDraftEntry: Equatable, Sendable {
    public struct Output: Equatable, Sendable {
        public var food: FoodData
        public var portions: [PortionData]
        public var barcode: BarcodeData
    }

    /// Portion name for a draft entered per serving (web `DRAFT_SERVING_LABEL`).
    public static let servingLabel = "serving"

    public let draft: OffDraft
    public var name: String
    public var brand: String
    /// Carbs per serving when `servingGrams` is set, else carbs per 100 g.
    public var carbs: String
    /// Fiber per 100 g.
    public var fiber: String

    public init(draft: OffDraft) {
        self.draft = draft
        name = draft.food.name
        brand = draft.food.brand ?? ""
        fiber = NumberParsing.editText(draft.food.fiberPer100g, maxFractionDigits: 2)
        if let grams = Self.servingGrams(draft) {
            carbs = NumberParsing.editText(FoodLabel.servingCarbs(carbsPer100g: draft.food.carbsPer100g, grams: grams), maxFractionDigits: 2)
        } else {
            carbs = NumberParsing.editText(draft.food.carbsPer100g, maxFractionDigits: 2)
        }
    }

    private static func servingGrams(_ draft: OffDraft) -> Double? {
        draft.portions.first(where: { $0.grams.isFinite && $0.grams > 0 })?.grams
    }

    private static func blank(_ text: String) -> Bool { text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    /// The label serving weight; carbs are entered per serving when set.
    public var servingGrams: Double? { Self.servingGrams(draft) }

    public var carbsMissing: Bool { Self.blank(carbs) }

    /// "= 68.57 g carbs per 100 g" for a valid per-serving entry.
    public var per100gText: String? {
        guard let grams = servingGrams, let value = NumberParsing.parseNonNegative(carbs),
              let per100g = FoodLabel.per100g(grams: grams, carbs: value), isValidCarbsPer100g(per100g) else { return nil }
        return "= \(FoodLabel.trim2(per100g)) g carbs per 100 g"
    }

    /// Validates and builds the records to save, or returns every problem found.
    public func build(newId: () -> Id) -> Result<Output, FoodFormErrors> {
        var problems: [String] = []
        if Self.blank(name) { problems.append("Name is required.") }

        var carbsPer100g: Double?
        var portionCarbs: Double?
        if carbsMissing {
            problems.append("Carbs are missing: enter them from the label.")
        } else if let value = NumberParsing.parseNonNegative(carbs) {
            if let grams = servingGrams {
                if !isValidPortionCarbs(value) {
                    problems.append("Carbs per serving must be a number from 0 to \(NumberParsing.editText(Units.maxPortionCarbsG)).")
                } else if let per100g = FoodLabel.per100g(grams: grams, carbs: value), isValidCarbsPer100g(per100g) {
                    carbsPer100g = per100g
                    portionCarbs = value
                } else {
                    problems.append("Carbs per serving can't be more than the serving weight (\(FoodLabel.trim2(grams)) g).")
                }
            } else if isValidCarbsPer100g(value) {
                carbsPer100g = value
            } else {
                problems.append("Carbs per 100 g must be a number from 0 to 100.")
            }
        } else {
            problems.append("Carbs isn't a valid number.")
        }

        var fiberValue: Double?
        if !Self.blank(fiber) {
            if let value = NumberParsing.parseNonNegative(fiber), value <= 100 {
                fiberValue = value
                if let carbsPer100g, value > carbsPer100g { problems.append("Fiber per 100 g cannot be more than carbs per 100 g.") }
            } else {
                problems.append("Fiber per 100 g must be a number from 0 to 100.")
            }
        }
        guard problems.isEmpty else { return .failure(FoodFormErrors(messages: problems)) }

        let food = FoodData(id: newId(), name: name.trimmingCharacters(in: .whitespacesAndNewlines),
                            brand: Self.blank(brand) ? nil : brand.trimmingCharacters(in: .whitespacesAndNewlines),
                            source: "off", sourceRef: draft.food.sourceRef, carbsPer100g: carbsPer100g, fiberPer100g: fiberValue)
        if let message = validateFood(food) { return .failure(FoodFormErrors(messages: [message])) }
        let portions: [PortionData]
        if let grams = servingGrams, let portionCarbs {
            portions = [PortionData(id: newId(), foodId: food.id, label: Self.servingLabel, kind: "serving", quantity: 1,
                                    grams: grams, carbsG: portionCarbs)]
        } else {
            portions = draft.portions.map {
                PortionData(id: newId(), foodId: food.id, label: $0.label, kind: $0.kind, quantity: $0.quantity, grams: $0.grams)
            }
        }
        return .success(Output(food: food, portions: portions, barcode: BarcodeData(id: newId(), code: draft.barcode, foodId: food.id)))
    }
}
