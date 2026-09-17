import Foundation

/// Mirrors packages/core/src/units.ts.
public enum Units {
    /// Mass unit ids in display order, and grams per unit.
    public static let massOrder = ["g", "kg", "oz", "lb"]
    public static let massGrams: [String: Double] = ["g": 1, "kg": 1000, "oz": 28.349523125, "lb": 453.59237]
    /// Volume unit ids in display order, and millilitres per unit (US customary).
    public static let volumeOrder = ["ml", "l", "tsp", "tbsp", "floz", "cup"]
    public static let volumeMl: [String: Double] = [
        "ml": 1, "l": 1000, "tsp": 4.92892159375, "tbsp": 14.78676478125, "floz": 29.5735295625, "cup": 236.5882365,
    ]
    public static let serving = "serving"
    public static let portionPrefix = "p:"

    /// Upper bounds shared by core math and server/web validation.
    public static let maxCarbsPer100g = 100.0
    public static let maxCarbsPer100ml = 150.0
    public static let maxPortionCarbsG = 500.0

    /// Quick carbs rows (quick-carbs spec §2): amount is grams of carbs and this is the only unit.
    public static let quick = "carbs"
    public static let quickLabelMax = 80
    public static let quickDefaultLabel = "Extra carbs"
}

public func isMassUnit(_ unit: String) -> Bool { Units.massGrams[unit] != nil }
public func isVolumeUnit(_ unit: String) -> Bool { Units.volumeMl[unit] != nil }

public func isValidAmount(_ amount: Double) -> Bool { amount.isFinite && amount >= 0 }

/// Grams of carbs on a quick row: finite and 0 ... DoseLimits.maxCarbsG. Mirrors units.ts.
public func isValidQuickCarbs(_ amount: Double) -> Bool {
    amount.isFinite && amount >= 0 && amount <= DoseLimits.maxCarbsG
}

public func quickUnits() -> [String] { [Units.quick] }

/// Stored form of a quick row's label: trimmed, at most 80 UTF-16 units (the server counts JS
/// string length), nil when blank. Mirrors units.ts `normalizeQuickLabel`.
public func normalizeQuickLabel(_ label: String?) -> String? {
    let trimmed = (label ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    let capped = String(decoding: trimmed.utf16.prefix(Units.quickLabelMax), as: UTF16.self)
        .trimmingCharacters(in: .whitespacesAndNewlines)
    return capped.isEmpty ? nil : capped
}

/// What a quick row is called on screen and in log snapshots.
public func quickDisplayName(_ label: String?) -> String {
    normalizeQuickLabel(label) ?? Units.quickDefaultLabel
}

/// ref_id to store for a row: a quick row points at itself; food and meal rows keep theirs.
public func itemRefId(_ refType: RefType, _ refId: Id, rowId: Id) -> Id {
    refType == .quick ? rowId : refId
}

private func inRange(_ value: Double?, _ max: Double) -> Bool {
    guard let value else { return false }
    return value.isFinite && value >= 0 && value <= max
}

public func isValidCarbsPer100g(_ value: Double?) -> Bool { inRange(value, Units.maxCarbsPer100g) }
public func isValidCarbsPer100ml(_ value: Double?) -> Bool { inRange(value, Units.maxCarbsPer100ml) }
public func isValidPortionCarbs(_ value: Double?) -> Bool { inRange(value, Units.maxPortionCarbsG) }
public func isValidPortionGrams(_ value: Double?) -> Bool {
    guard let value else { return false }
    return value.isFinite && value > 0
}

private func isValidQuantity(_ value: Double) -> Bool { value.isFinite && value > 0 }

public func densityOf(_ food: FoodData, _ portions: [PortionData]) -> Double? {
    if let density = food.densityGPerMl, density.isFinite, density > 0 { return density }
    var best: (id: String, density: Double)?
    for p in portions where p.kind == "volume" && isVolumeUnit(p.label)
        && isValidQuantity(p.quantity) && isValidPortionGrams(p.grams) {
        if best == nil || JS.less(p.id, best!.id) {
            best = (p.id, p.grams! / (p.quantity * Units.volumeMl[p.label]!))
        }
    }
    return best?.density
}

/// Fail closed: only a nil carb basis may fall back to another path; a present-but-invalid one
/// removes its unit family. Mirrors units.ts `foodUnits` exactly.
public func foodUnits(_ food: FoodData, _ portions: [PortionData]) -> [String] {
    let density = densityOf(food, portions)
    let gPresent = food.carbsPer100g != nil
    let mlPresent = food.carbsPer100ml != nil
    let validG = isValidCarbsPer100g(food.carbsPer100g)
    let validMl = isValidCarbsPer100ml(food.carbsPer100ml)
    // carbs_g on a volume portion is ignored everywhere.
    let hasValidPieceBasis = portions.contains { $0.kind != "volume" && $0.carbsG != nil && isValidPortionCarbs($0.carbsG) }
    // Mass: per-100 g if present; else per-100 ml + density if present; else (no basis) a placeholder
    // list, unless a valid portion carb basis makes the food portion-only.
    let massListed = gPresent ? validG : mlPresent ? (validMl && density != nil) : !hasValidPieceBasis
    // Volume: per-100 ml if present; else convertible via density, unless per-100 g is present but invalid.
    let volumeListed = mlPresent ? validMl : (density != nil && (!gPresent || validG))
    var units: [String] = []
    if massListed { units += Units.massOrder }
    if volumeListed { units += Units.volumeOrder }
    for p in portions where p.kind != "volume" {
        let listed = p.carbsG != nil ? isValidPortionCarbs(p.carbsG) : (isValidPortionGrams(p.grams) && massListed)
        if listed { units.append(Units.portionPrefix + p.id) }
    }
    return units
}

public func mealUnits(_ meal: MealData) -> [String] {
    let hasWeight = (meal.totalWeightG ?? 0) > 0
    return hasWeight ? [Units.serving] + Units.massOrder : [Units.serving]
}

public func foodAmountToGrams(_ amount: Double, _ unit: String, _ food: FoodData, _ portions: [PortionData]) -> Double? {
    guard isValidAmount(amount) else { return nil }
    if let grams = Units.massGrams[unit] { return amount * grams }
    if let ml = Units.volumeMl[unit] {
        guard let density = densityOf(food, portions) else { return nil }
        return amount * ml * density
    }
    if unit.hasPrefix(Units.portionPrefix) {
        let portionId = String(unit.dropFirst(Units.portionPrefix.count))
        guard let portion = portions.first(where: { $0.id == portionId }),
              isValidPortionGrams(portion.grams),
              isValidQuantity(portion.quantity) else { return nil }
        return amount * portion.grams! / portion.quantity
    }
    return nil
}
