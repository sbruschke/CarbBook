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
}

public func isMassUnit(_ unit: String) -> Bool { Units.massGrams[unit] != nil }
public func isVolumeUnit(_ unit: String) -> Bool { Units.volumeMl[unit] != nil }

private func isValidAmount(_ amount: Double) -> Bool { amount.isFinite && amount >= 0 }

public func densityOf(_ food: FoodData, _ portions: [PortionData]) -> Double? {
    if let density = food.densityGPerMl, density.isFinite, density > 0 { return density }
    var best: PortionData?
    for p in portions where p.kind == "volume" && isVolumeUnit(p.label)
        && p.quantity.isFinite && p.quantity > 0 && p.grams.isFinite && p.grams > 0 {
        if best == nil || JS.less(p.id, best!.id) { best = p }
    }
    guard let best else { return nil }
    return best.grams / (best.quantity * Units.volumeMl[best.label]!)
}

public func foodUnits(_ food: FoodData, _ portions: [PortionData]) -> [String] {
    var units = Units.massOrder
    if densityOf(food, portions) != nil { units += Units.volumeOrder }
    for p in portions where p.kind != "volume" { units.append(Units.portionPrefix + p.id) }
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
              portion.grams.isFinite, portion.grams > 0,
              portion.quantity.isFinite, portion.quantity > 0 else { return nil }
        return amount * portion.grams / portion.quantity
    }
    return nil
}
