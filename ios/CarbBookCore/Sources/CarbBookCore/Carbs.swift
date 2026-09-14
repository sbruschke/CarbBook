import Foundation

/// Mirrors packages/core/src/carbs.ts.
public protocol Catalog: Sendable {
    func food(_ id: Id) -> FoodData?
    func portions(_ foodId: Id) -> [PortionData]
    func meal(_ id: Id) -> MealData?
    func mealItems(_ mealId: Id) -> [MealItemData]
}

public struct CarbResult: Equatable, Sendable {
    public var carbsG: Double
    public var complete: Bool

    public init(carbsG: Double, complete: Bool) {
        self.carbsG = carbsG
        self.complete = complete
    }

    public static let incomplete = CarbResult(carbsG: 0, complete: false)
}

public struct InMemoryCatalog: Catalog {
    private let foods: [Id: FoodData]
    private let portionsByFood: [Id: [PortionData]]
    private let meals: [Id: MealData]
    private let itemsByMeal: [Id: [MealItemData]]

    /// Rows with `deleted == 1` are skipped. Meal items are ordered by `position`, keeping input
    /// order for equal positions (JS `Array.prototype.sort` is stable).
    public init(foods: [FoodData] = [], portions: [PortionData] = [], meals: [MealData] = [], mealItems: [MealItemData] = []) {
        var foodMap: [Id: FoodData] = [:]
        for f in foods where f.deleted != 1 { foodMap[f.id] = f }
        var mealMap: [Id: MealData] = [:]
        for m in meals where m.deleted != 1 { mealMap[m.id] = m }
        var portionMap: [Id: [PortionData]] = [:]
        for p in portions where p.deleted != 1 { portionMap[p.foodId, default: []].append(p) }
        var itemMap: [Id: [(Int, MealItemData)]] = [:]
        for (index, item) in mealItems.enumerated() where item.deleted != 1 {
            itemMap[item.mealId, default: []].append((index, item))
        }
        self.foods = foodMap
        self.meals = mealMap
        self.portionsByFood = portionMap
        self.itemsByMeal = itemMap.mapValues { list in
            list.sorted { $0.1.position != $1.1.position ? $0.1.position < $1.1.position : $0.0 < $1.0 }.map(\.1)
        }
    }

    public func food(_ id: Id) -> FoodData? { foods[id] }
    public func portions(_ foodId: Id) -> [PortionData] { portionsByFood[foodId] ?? [] }
    public func meal(_ id: Id) -> MealData? { meals[id] }
    public func mealItems(_ mealId: Id) -> [MealItemData] { itemsByMeal[mealId] ?? [] }
}

/// Mass path: carbs_per_100g if valid. Only a nil carbs_per_100g falls back to carbs_per_100ml +
/// density; a present-but-invalid value fails closed (incomplete).
private func carbsForGrams(_ food: FoodData, _ portions: [PortionData], _ grams: Double) -> CarbResult {
    if food.carbsPer100g != nil {
        return isValidCarbsPer100g(food.carbsPer100g)
            ? CarbResult(carbsG: grams * food.carbsPer100g! / 100, complete: true)
            : .incomplete
    }
    if isValidCarbsPer100ml(food.carbsPer100ml), let density = densityOf(food, portions) {
        return CarbResult(carbsG: (grams / density) * food.carbsPer100ml! / 100, complete: true)
    }
    return .incomplete
}

private func foodItemCarbs(_ catalog: Catalog, _ foodId: Id, _ amount: Double, _ unit: String) -> CarbResult {
    guard let food = catalog.food(foodId), isValidAmount(amount) else { return .incomplete }
    let portions = catalog.portions(foodId)
    if isVolumeUnit(unit) {
        if food.carbsPer100ml != nil {
            // Present per-100 ml basis: use it or fail closed; never fall back to density.
            guard isValidCarbsPer100ml(food.carbsPer100ml) else { return .incomplete }
            return CarbResult(carbsG: amount * Units.volumeMl[unit]! * food.carbsPer100ml! / 100, complete: true)
        }
        // Nil per-100 ml: per-100 g + density only.
        guard let grams = foodAmountToGrams(amount, unit, food, portions),
              isValidCarbsPer100g(food.carbsPer100g) else { return .incomplete }
        return CarbResult(carbsG: grams * food.carbsPer100g! / 100, complete: true)
    }
    if unit.hasPrefix(Units.portionPrefix) {
        let portionId = String(unit.dropFirst(Units.portionPrefix.count))
        guard let portion = portions.first(where: { $0.id == portionId }) else { return .incomplete }
        // carbs_g on volume portions is ignored (grams path only).
        if portion.kind != "volume", portion.carbsG != nil {
            // Present portion carbs: use them or fail closed; never fall back to grams.
            guard isValidPortionCarbs(portion.carbsG), portion.quantity.isFinite, portion.quantity > 0 else {
                return .incomplete
            }
            return CarbResult(carbsG: (amount / portion.quantity) * portion.carbsG!, complete: true)
        }
    }
    // Mass units, and portions without carbs (or volume portions), go through a known weight.
    guard let grams = foodAmountToGrams(amount, unit, food, portions) else { return .incomplete }
    return carbsForGrams(food, portions, grams)
}

private func mealTotalCarbs(_ catalog: Catalog, _ mealId: Id, _ visiting: inout Set<Id>) -> CarbResult {
    if visiting.contains(mealId) || catalog.meal(mealId) == nil { return .incomplete }
    visiting.insert(mealId)
    let items = catalog.mealItems(mealId)
    var results: [CarbResult] = []
    for item in items {
        results.append(resolveItem(catalog, item.refType, item.refId, item.amount, item.unit, &visiting))
    }
    let total = items.isEmpty ? .incomplete : sumCarbs(results)
    visiting.remove(mealId)
    return total
}

private func mealItemCarbs(_ catalog: Catalog, _ mealId: Id, _ amount: Double, _ unit: String, _ visiting: inout Set<Id>) -> CarbResult {
    guard let meal = catalog.meal(mealId), amount.isFinite, amount >= 0 else { return .incomplete }
    var factor: Double?
    if unit == Units.serving && meal.yieldServings.isFinite && meal.yieldServings > 0 {
        factor = amount / meal.yieldServings
    } else if let grams = Units.massGrams[unit], let weight = meal.totalWeightG, weight.isFinite, weight > 0 {
        factor = amount * grams / weight
    }
    guard let factor else { return .incomplete }
    let total = mealTotalCarbs(catalog, mealId, &visiting)
    return CarbResult(carbsG: total.carbsG * factor, complete: total.complete)
}

private func resolveItem(_ catalog: Catalog, _ refType: RefType, _ refId: Id, _ amount: Double, _ unit: String,
                         _ visiting: inout Set<Id>) -> CarbResult {
    switch refType {
    case .food: foodItemCarbs(catalog, refId, amount, unit)
    case .meal: mealItemCarbs(catalog, refId, amount, unit, &visiting)
    }
}

/// Carbs for one line item (a food or a meal) at the given amount and unit.
public func itemCarbs(_ catalog: Catalog, _ refType: RefType, _ refId: Id, _ amount: Double, _ unit: String) -> CarbResult {
    var visiting = Set<Id>()
    return resolveItem(catalog, refType, refId, amount, unit, &visiting)
}

public func sumCarbs(_ results: [CarbResult]) -> CarbResult {
    results.reduce(CarbResult(carbsG: 0, complete: true)) {
        CarbResult(carbsG: $0.carbsG + $1.carbsG, complete: $0.complete && $1.complete)
    }
}

/// True if adding `candidateMealId` as a component of `mealId` would make a meal contain itself.
public func wouldCreateCycle(_ catalog: Catalog, _ mealId: Id, _ candidateMealId: Id) -> Bool {
    if candidateMealId == mealId { return true }
    var stack = [candidateMealId]
    var seen = Set<Id>()
    while let current = stack.popLast() {
        if seen.contains(current) { continue }
        seen.insert(current)
        for item in catalog.mealItems(current) where item.refType == .meal {
            if item.refId == mealId { return true }
            stack.append(item.refId)
        }
    }
    return false
}
