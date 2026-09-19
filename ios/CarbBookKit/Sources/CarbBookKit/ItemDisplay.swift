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
