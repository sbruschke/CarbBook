import CarbBookCore
import CarbBookKit
import Foundation
import Observation

@Observable
@MainActor
final class CalculatorModel {
    var lines: [CalculatorLine] = []
    var useNow = true
    var eatenAt = Date()
    var windowOverride: String?
    var dexcom: BgInput = .none
    var bgNote = "Checking Dexcom…"
    var manualBg = ""
    var taken = ""
    var notes = ""
    var message: String?
    private(set) var result: CalculatorResult?
    /// The last value `recompute` auto-filled into `taken`. Comparing the field against this (rather
    /// than a one-shot "was it edited" flag) tells whether the user has since typed something of
    /// their own: once `taken != lastAutoTaken`, it stays user-owned even as this keeps chasing the
    /// current estimate, so a later edit is never silently overwritten by a new auto-fill.
    private var lastAutoTaken = ""
    private(set) var catalog = InMemoryCatalog()
    private(set) var settingsVersions: [DoseSettingsData] = []
    /// Ids of dose_settings versions with a push rejection still in effect. Always threaded through
    /// to `evaluateCalculator`/`recalculateLogEntry` so a rejected edit is never used for a new
    /// estimate — the one shared source for this is `LocalStore.rejectedDoseSettingsIds()`.
    private(set) var rejectedSettingsIds: Set<Id> = []

    /// Dexcom when a usable reading is loaded, otherwise the typed BG (or nil if left blank),
    /// otherwise none. A typed value that isn't a whole number is never silently dropped: it is fed
    /// through as a non-finite BG so core's `evaluateCalculator` refuses with `invalid_input` instead
    /// of behaving as if no BG had been entered (`manualBgIsInvalid` drives the inline "Invalid BG").
    var bg: BgInput {
        if case .dexcom = dexcom { return dexcom }
        let trimmed = manualBg.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty { return .none }
        if let value = parseWholeNumber(manualBg) { return .manual(mgdl: value) }
        return .manual(mgdl: .infinity)
    }

    var manualBgIsInvalid: Bool {
        let trimmed = manualBg.trimmingCharacters(in: .whitespaces)
        return !trimmed.isEmpty && parseWholeNumber(manualBg) == nil
    }

    var activeSettings: DoseSettingsData? { result?.settings }

    /// True once the user has typed something into "Taken" that the model didn't put there itself.
    var takenEditedByUser: Bool { taken != lastAutoTaken }

    func reload(_ app: AppModel) {
        do {
            catalog = try app.store.catalog()
            settingsVersions = try app.store.doseSettingsVersions()
            rejectedSettingsIds = try app.store.rejectedDoseSettingsIds()
        } catch {
            message = "Could not read local data: \(error)"
        }
        recompute(app)
    }

    func recompute(_ app: AppModel) {
        if useNow { eatenAt = Date() }
        let lastDose = (try? app.store.lastDoseAtMs()) ?? nil
        result = evaluateCalculator(
            lines: lines, catalog: catalog, settingsVersions: settingsVersions, eatenAt: eatenAt,
            windowOverride: windowOverride, bg: bg, lastDoseAtMs: lastDose, nowMs: nowMs(),
            rejectedSettingsIds: rejectedSettingsIds)
        // "Taken" is prefilled from an ok estimate only, and only while the user hasn't typed their
        // own value; any other outcome (refusal, incomplete carbs, invalid BG) leaves it empty rather
        // than showing a stale or misleading number.
        let wasEdited = takenEditedByUser
        let auto: String
        if case .ok(let suggestion)? = result?.estimate {
            auto = formatNumber(suggestion.units, digits: 2)
        } else {
            auto = ""
        }
        if !wasEdited { taken = auto }
        lastAutoTaken = auto
    }

    func refreshBg(_ app: AppModel) async {
        do {
            let reading = try await app.api.bg()
            let now = nowMs()
            if reading.fresh && isBgReadingUsable(readAtMs: reading.readAt, nowMs: now) {
                dexcom = .dexcom(mgdl: reading.mgdl, trend: reading.trend)
                bgNote = "Dexcom \(formatNumber(reading.mgdl, digits: 0)) \(reading.arrow ?? "") · \(max(0, now - reading.readAt) / 60_000) min ago"
            } else if reading.readAt > now {
                dexcom = .none
                bgNote = "Dexcom reading is timestamped in the future. Enter BG manually."
            } else {
                dexcom = .none
                bgNote = "Latest Dexcom reading is \((now - reading.readAt) / 60_000) min old. Enter BG manually."
            }
        } catch {
            dexcom = .none
            bgNote = "Dexcom unavailable (offline or no data). Enter BG manually."
        }
        recompute(app)
    }

    func carbs(for line: CalculatorLine) -> CarbResult {
        guard let index = lines.firstIndex(where: { $0.id == line.id }), let result, index < result.lineCarbs.count else {
            return itemCarbs(catalog, line.refType, line.refId, line.amount, line.unit)
        }
        return result.lineCarbs[index]
    }

    func units(for line: CalculatorLine) -> [String] {
        switch line.refType {
        case .food: catalog.food(line.refId).map { foodUnits($0, catalog.portions(line.refId)) } ?? [line.unit]
        case .meal: catalog.meal(line.refId).map { mealUnits($0) } ?? [line.unit]
        }
    }

    /// Adds a search hit; USDA foods are copied into the synced food table first.
    func add(_ hit: SearchHit, _ app: AppModel) throws {
        switch hit.kind {
        case .meal:
            append(.meal, hit.id, hit.name, amount: 1, unit: Units.serving)
        case .food:
            addFood(id: hit.id, name: hit.name)
        case .usda:
            guard let fdcId = hit.usdaFdcId, let usda = app.usda else { return }
            let id = try app.store.adoptUsdaFood(fdcId: fdcId, library: usda)
            app.revision += 1
            reload(app)
            addFood(id: id, name: hit.name)
        }
        recompute(app)
    }

    func addFood(id: Id, name: String) {
        // First valid portion, else 100 g, else 1 cup (any-unit foods); unknown foods default to 100 g.
        let initial = catalog.food(id).map { defaultFoodAmountAndUnit($0, catalog.portions(id)) } ?? (amount: 100, unit: "g")
        append(.food, id, name, amount: initial.amount, unit: initial.unit)
    }

    private func append(_ refType: RefType, _ refId: Id, _ name: String, amount: Double, unit: String) {
        lines.append(CalculatorLine(id: UUID().uuidString, refType: refType, refId: refId, displayName: name, amount: amount, unit: unit))
    }

    func logIt(_ app: AppModel) throws {
        recompute(app)
        guard let result, !lines.isEmpty else { return }
        let records = buildLogRecords(
            lines: lines, result: result, bg: bg, eatenAt: eatenAt, takenUnits: parseNumber(taken),
            notes: notes.isEmpty ? nil : notes, newId: app.store.newId)
        try app.save([SyncChange.encode("log_entry", records.entry)] + records.items.map { try SyncChange.encode("log_item", $0) })
        message = "Logged \(formatNumber(records.entry.totalCarbsG))g" + (records.entry.takenUnits.map { ", \(formatNumber($0, digits: 2))u taken" } ?? "")
        lines = []
        taken = ""
        lastAutoTaken = ""
        notes = ""
        manualBg = ""
        windowOverride = nil
        useNow = true
        recompute(app)
    }

    func saveMeal(name: String, yieldServings: Double, totalWeightG: Double?, _ app: AppModel) throws {
        let records = buildMealRecords(name: name, yieldServings: yieldServings, totalWeightG: totalWeightG, lines: lines, newId: app.store.newId)
        try app.save([SyncChange.encode("meal", records.meal)] + records.items.map { try SyncChange.encode("meal_item", $0) })
        message = "Saved meal \(name)"
        reload(app)
    }
}
