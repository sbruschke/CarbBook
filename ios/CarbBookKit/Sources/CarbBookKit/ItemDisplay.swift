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
