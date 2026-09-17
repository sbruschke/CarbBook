import Foundation

/// Log → "Recalculate from current meal": refreshes each item's name and carbs from the current
/// catalog, the entry total, and the suggested dose (with the entry's own settings version and
/// window when they still exist). `taken_units`, BG and time are left as logged.
///
/// An item whose food/meal no longer resolves keeps its existing `carbsG` (never overwritten
/// with 0, so the total is never silently lowered by a dangling reference) and marks the result
/// incomplete so the caller can refuse to save or show a warning. Likewise, if the entry's
/// `settingsVersionId` no longer resolves (deleted, or in `rejectedSettingsIds` — belt-and-braces
/// against a sync rejection that a store implementation failed to restore locally, spec item d),
/// the original id is kept rather than silently replaced by whatever version is currently active.
public func recalculateLogEntry(
    entry: LogEntryData,
    items: [LogItemData],
    catalog: Catalog,
    settingsVersions: [DoseSettingsData],
    rejectedSettingsIds: Set<Id> = [],
    calendar: Calendar = .current
) -> (entry: LogEntryData, items: [LogItemData], complete: Bool) {
    let usableSettings = eligibleDoseSettingsVersions(settingsVersions, rejectedIds: rejectedSettingsIds)

    var newItems: [LogItemData] = []
    var itemsComplete = true
    for item in items {
        let carbs = itemCarbs(catalog, item.refType, item.refId, item.amount, item.unit)
        var updated = item
        if carbs.complete {
            updated.carbsG = carbs.carbsG
        } else {
            itemsComplete = false
            // Leave updated.carbsG as item.carbsG: never overwrite a resolved carb count with 0.
        }
        switch item.refType {
        case .food: if let food = catalog.food(item.refId) { updated.displayName = food.name }
        case .meal: if let meal = catalog.meal(item.refId) { updated.displayName = meal.name }
        case .quick: break // a quick row keeps its logged label
        }
        newItems.append(updated)
    }
    let total = newItems.reduce(0.0) { $0 + $1.carbsG }
    var newEntry = entry
    newEntry.totalCarbsG = total

    var settings: DoseSettingsData?
    if let currentId = entry.settingsVersionId {
        settings = usableSettings.first(where: { $0.id == currentId })
        // Keep the original id even if it no longer resolves — never silently swap it out.
    } else {
        settings = activeSettings(usableSettings, entry.eatenAt)
        newEntry.settingsVersionId = settings?.id
    }
    let settingsComplete = settings != nil
    newEntry.suggestedUnits = nil
    if let settings {
        let eatenAt = Date(timeIntervalSince1970: Double(entry.eatenAt) / 1000)
        var minutes = minutesOfDay(eatenAt, calendar: calendar)
        if let name = entry.windowName, let window = settings.windows.first(where: { $0.name == name }),
           let start = try? parseHHMM(window.start) {
            minutes = start
        }
        let carbResult = CarbResult(carbsG: total, complete: itemsComplete)
        let estimate = estimateDose(DoseInput(settings: settings, minutes: minutes, carbs: carbResult, bg: entry.bgMgdl))
        if case .ok(let s) = estimate { newEntry.suggestedUnits = s.units }
        newEntry.windowName = estimate.window?.name ?? entry.windowName
    }
    return (newEntry, newItems, itemsComplete && settingsComplete)
}
