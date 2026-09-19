import CarbBookCore
import Foundation

/// Name for any item row — food, meal or quick carbs — shared by the Calculator, meal editor, plan
/// editor and plan grid so they cannot drift. A reference that has not synced yet reads "Unknown item".
public func itemDisplayName(_ refType: RefType, _ refId: Id, label: String?, catalog: Catalog) -> String {
    switch refType {
    case .food: catalog.food(refId)?.name ?? "Unknown item"
    case .meal: catalog.meal(refId)?.name ?? "Unknown item"
    case .quick: quickDisplayName(label)
    }
}

/// Units a row can use; an unresolved food or meal keeps its current unit so the picker still shows it.
public func itemUnits(_ refType: RefType, _ refId: Id, currentUnit: String, catalog: Catalog) -> [String] {
    switch refType {
    case .food: catalog.food(refId).map { foodUnits($0, catalog.portions(refId)) } ?? [currentUnit]
    case .meal: catalog.meal(refId).map { mealUnits($0) } ?? [currentUnit]
    case .quick: quickUnits()
    }
}

/// The image of the food or meal a row points at, for a row's leading thumbnail. Quick-carbs rows
/// have no record and so never have one, and an unresolved reference reads as no image rather than
/// as an error — the same rule as `itemDisplayName`'s "Unknown item".
public func itemImageId(_ refType: RefType, _ refId: Id, catalog: Catalog) -> Id? {
    switch refType {
    case .food: catalog.food(refId)?.imageId
    case .meal: catalog.meal(refId)?.imageId
    case .quick: nil
    }
}

/// The parts of an item row a stack needs. Meal components and plan items share them, and both
/// compute their carbs live, so one function serves both; conformance is declared here rather than
/// in core because this is the only thing that wants it.
public protocol StackableItem {
    var refType: RefType { get }
    var refId: Id { get }
    var amount: Double { get }
    var unit: String { get }
}

extension MealItemData: StackableItem {}
extension PlanItemData: StackableItem {}

/// Stack entries for rows whose carbs are computed live (meal components, plan items). The image and
/// the carbs both come out of the catalog the screen already holds, so this costs no query. Carbs
/// that cannot be worked out count as unknown rather than zero, so such a row sorts to the back of
/// the stack but keeps its photo.
public func itemStackEntries(_ items: [some StackableItem], catalog: Catalog) -> [StackEntry] {
    items.map { item in
        let carbs = itemCarbs(catalog, item.refType, item.refId, item.amount, item.unit)
        return StackEntry(imageId: itemImageId(item.refType, item.refId, catalog: catalog),
                          carbs: carbs.complete ? carbs.carbsG : nil)
    }
}

/// Stack entries for logged rows. Unlike a plan or a meal, a log entry is a snapshot: `carbs_g` is
/// what was actually counted at the time, so it is used as stored and never recomputed. Only the
/// photo needs the catalog, and a quick-carbs row has none — it still counts towards the badge.
public func loggedStackEntries(_ items: [LogItemData], catalog: Catalog) -> [StackEntry] {
    items.map { item in
        StackEntry(imageId: itemImageId(item.refType, item.refId, catalog: catalog),
                   carbs: item.carbsG.isFinite ? item.carbsG : nil)
    }
}
