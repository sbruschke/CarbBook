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
}

public func isMassUnit(_ unit: String) -> Bool { Units.massGrams[unit] != nil }
public func isVolumeUnit(_ unit: String) -> Bool { Units.volumeMl[unit] != nil }

public func isValidAmount(_ amount: Double) -> Bool { amount.isFinite && amount >= 0 }

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

public func foodUnits(_ food: FoodData, _ portions: [PortionData]) -> [String] {
    let density = densityOf(food, portions)
    let validG = isValidCarbsPer100g(food.carbsPer100g)
    let validMl = isValidCarbsPer100ml(food.carbsPer100ml)
    let listedPortions = portions.filter {
        $0.kind != "volume" && (isValidPortionCarbs($0.carbsG) || isValidPortionGrams($0.grams))
    }
    let hasMassPath = validG || (validMl && density != nil)
    let hasAnyBasis = validG || validMl || portions.contains { $0.kind != "volume" && isValidPortionCarbs($0.carbsG) }
    var units: [String] = []
    if hasMassPath || !hasAnyBasis { units += Units.massOrder }
    if validMl || density != nil { units += Units.volumeOrder }
    for p in listedPortions { units.append(Units.portionPrefix + p.id) }
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
