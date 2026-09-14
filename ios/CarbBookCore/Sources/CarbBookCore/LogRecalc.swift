import Foundation

/// Log → "Recalculate from current meal": refreshes each item's name and carbs from the current
/// catalog, the entry total, and the suggested dose (with the entry's own settings version and
/// window when they still exist). `taken_units`, BG and time are left as logged.
public func recalculateLogEntry(
    entry: LogEntryData,
    items: [LogItemData],
    catalog: Catalog,
    settingsVersions: [DoseSettingsData],
    calendar: Calendar = .current
) -> (entry: LogEntryData, items: [LogItemData], complete: Bool) {
    var newItems: [LogItemData] = []
    var results: [CarbResult] = []
    for item in items {
        let carbs = itemCarbs(catalog, item.refType, item.refId, item.amount, item.unit)
        var updated = item
        updated.carbsG = carbs.carbsG
        switch item.refType {
        case .food: if let food = catalog.food(item.refId) { updated.displayName = food.name }
        case .meal: if let meal = catalog.meal(item.refId) { updated.displayName = meal.name }
        }
        newItems.append(updated)
        results.append(carbs)
    }
    let total = sumCarbs(results)
    var newEntry = entry
    newEntry.totalCarbsG = total.carbsG

    let settings = settingsVersions.first(where: { $0.id == entry.settingsVersionId })
        ?? activeSettings(settingsVersions, entry.eatenAt)
    newEntry.settingsVersionId = settings?.id
    newEntry.suggestedUnits = nil
    if let settings {
        let eatenAt = Date(timeIntervalSince1970: Double(entry.eatenAt) / 1000)
        var minutes = minutesOfDay(eatenAt, calendar: calendar)
        if let name = entry.windowName, let window = settings.windows.first(where: { $0.name == name }),
           let start = try? parseHHMM(window.start) {
            minutes = start
        }
        let estimate = estimateDose(DoseInput(settings: settings, minutes: minutes, carbs: total, bg: entry.bgMgdl))
        if case .ok(let s) = estimate { newEntry.suggestedUnits = s.units }
        newEntry.windowName = estimate.window?.name ?? entry.windowName
    }
    return (newEntry, newItems, total.complete)
}
