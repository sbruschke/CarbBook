import CarbBookCore
import CarbBookKit
import Foundation
import Observation

struct InvalidAmountError: LocalizedError {
    var errorDescription: String? { "\(AmountInput.invalidMessage). Fix it before saving." }
}

@Observable
@MainActor
final class CalculatorModel {
    var lines: [CalculatorLine] = []
    var useNow = true
    var eatenAt = Date()
    var windowOverride: String?
    /// The last Dexcom fetch. Re-validated against the clock on every recompute (`recomputeCalculator`),
    /// so a reading that goes stale while the screen is open stops feeding the estimate.
    private(set) var dexcomFetch: DexcomFetch = .notLoaded
    /// `.dexcom` only while the loaded reading is usable now, otherwise `.none`.
    private(set) var dexcom: BgInput = .none
    private(set) var bgNote = "Checking Dexcom…"
    var manualBg = ""
    var notes = ""
    var message: String?
    private(set) var result: CalculatorResult?
    /// "Taken": prefilled from the estimate until the user types in it (see `TakenField`).
    private(set) var takenField = TakenField()
    private(set) var catalog = InMemoryCatalog()
    private(set) var settingsVersions: [DoseSettingsData] = []
    /// Ids of dose_settings versions with a push rejection still in effect. Always threaded through
    /// to `evaluateCalculator`/`recalculateLogEntry` so a rejected edit is never used for a new
    /// estimate — the one shared source for this is `LocalStore.rejectedDoseSettingsIds()`.
    private(set) var rejectedSettingsIds: Set<Id> = []
    /// The planned slot offered for the current date + window, or nil (spec §5).
    private(set) var suggestion: PlanSuggestion?
    /// The slot whose items were loaded in this session; "Log it" marks it `logged`.
    private(set) var loadedSlotId: Id?

    /// Dexcom when a usable reading is loaded, otherwise the typed BG (or none if left blank). A typed
    /// value that isn't a whole number is fed through as a non-finite BG so core refuses with
    /// `invalid_input` (`manualBgIsInvalid` drives the inline "Invalid BG").
    var bg: BgInput {
        if case .dexcom = dexcom { return dexcom }
        return manualBgInput(manualBg)
    }

    var manualBgIsInvalid: Bool { NumberParsing.isMalformed(manualBg, using: NumberParsing.parseWholeNumber) }

    var activeSettings: DoseSettingsData? { result?.settings }

    /// The carb goal of the window the estimate is using, if it has one.
    var currentWindowGoal: CarbGoal? {
        guard let name = windowOverride ?? result?.estimate?.window?.name else { return nil }
        return activeSettings?.windows.first { $0.name == name }?.carbGoal
    }

    var taken: String { takenField.text }

    /// Called only from the text field's binding, i.e. when the user types.
    func setTaken(_ text: String) { takenField.userTyped(text) }

    var takenIsMalformed: Bool { TakenDoseInput.isMalformed(taken) }

    /// True whenever the user has typed in "Taken", even if the text equals the estimate.
    var takenEditedByUser: Bool { takenField.editedByUser }

    func reload(_ app: AppModel) {
        do {
            catalog = try app.store.catalog()
            settingsVersions = try app.store.doseSettingsVersions()
            rejectedSettingsIds = try app.store.rejectedDoseSettingsIds()
        } catch {
            message = "Could not read local data: \(error)"
        }
        recompute(app)
        refreshSuggestion(app)
    }

    /// Clock tick (every 30 s while visible, and on returning to the foreground): re-validates the
    /// Dexcom reading and recomputes the estimate and recent-dose warning for the current time.
    func tick(_ app: AppModel) {
        recompute(app)
    }

    func recompute(_ app: AppModel) {
        let lastDose = (try? app.store.lastDoseAtMs()) ?? nil
        let now = nowMs()
        let snapshot = recomputeCalculator(
            CalculatorInputs(lines: lines, catalog: catalog, settingsVersions: settingsVersions, useNow: useNow,
                             eatenAt: eatenAt, windowOverride: windowOverride, manualBg: manualBg,
                             lastDoseAtMs: lastDose, rejectedSettingsIds: rejectedSettingsIds),
            dexcom: dexcomFetch, nowMs: now)
        if useNow { eatenAt = snapshot.eatenAt }
        if dexcom != snapshot.dexcomBg { dexcom = snapshot.dexcomBg }
        let note = bgNoteText(snapshot.bgStatus, nowMs: now)
        if bgNote != note { bgNote = note }
        result = snapshot.result
        // "Taken" is prefilled from an ok estimate only, and only while the user hasn't typed in it;
        // any other outcome (refusal, incomplete carbs, invalid BG) leaves it empty rather than
        // showing a stale or misleading number.
        if case .ok(let suggestion) = snapshot.result.estimate {
            takenField.applyEstimate(NumberParsing.editText(suggestion.units, maxFractionDigits: 2))
        } else {
            takenField.applyEstimate("")
        }
        refreshSuggestion(app)
    }

    private func bgNoteText(_ status: BgStatus, nowMs: Int64) -> String {
        switch status {
        case .checking:
            return "Checking Dexcom…"
        case .usable(let minutesAgo):
            guard case .reading(let reading) = dexcomFetch else { return "" }
            return "Dexcom \(formatNumber(reading.mgdl, digits: 0)) \(reading.arrow ?? "") · \(minutesAgo) min ago"
        case .future:
            return "Dexcom reading is timestamped in the future. Enter BG manually."
        case .stale(let minutesOld):
            return "Latest Dexcom reading is \(minutesOld) min old. Enter BG manually."
        case .unavailable:
            return "Dexcom unavailable (offline or no data). Enter BG manually."
        }
    }

    func refreshBg(_ app: AppModel) async {
        do {
            dexcomFetch = .reading(try await app.api.bg())
        } catch {
            dexcomFetch = .failed
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
        itemUnits(line.refType, line.refId, currentUnit: line.unit, catalog: catalog)
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

    /// "+ Carbs": a carbs-only row. Its ref_id is set to the stored row's id when it is logged or saved.
    func addQuick(label: String?, grams: Double) {
        lines.append(CalculatorLine(id: UUID().uuidString, refType: .quick, refId: "", displayName: quickDisplayName(label),
                                    amount: grams, unit: Units.quick, label: label))
    }

    private func append(_ refType: RefType, _ refId: Id, _ name: String, amount: Double, unit: String) {
        lines.append(CalculatorLine(id: UUID().uuidString, refType: refType, refId: refId, displayName: name, amount: amount, unit: unit))
    }

    /// The window the estimate is using (or the override), which decides which slot to offer.
    private var suggestedWindowName: String? {
        windowOverride ?? result?.estimate?.window?.name
    }

    /// Re-reads the planned slot for the current date + window. Called from `reload` and after every
    /// recompute, because changing the time or the window changes which slot applies.
    func refreshSuggestion(_ app: AppModel) {
        // Once a slot is loaded this session, no suggestion is ever shown again — the slot is still
        // `planned` in storage, so recomputing (a clock tick, a window change) must never re-offer it
        // (`PlanSuggestion.shown`, matching web `Calculator.tsx:75`).
        guard loadedSlotId == nil, let windowName = suggestedWindowName else {
            if suggestion != nil { suggestion = nil }
            return
        }
        let date = PlanDate.string(eatenAt)
        do {
            let entry = try app.store.planEntry(date: date, windowName: windowName)
            var items: [PlanItemData] = []
            if let entry { items = try app.store.planItems(entryIds: [entry.id])[entry.id] ?? [] }
            let computed = PlanSuggestion.make(entry: entry, items: items, catalog: catalog,
                                               dismissed: PlanDismissals.load())
            let next = PlanSuggestion.shown(computed: computed, loadedSlotId: loadedSlotId)
            // Assigning an unchanged value would re-trigger the view update that called this.
            if next != suggestion { suggestion = next }
        } catch {
            if suggestion != nil { suggestion = nil }
        }
    }

    /// Load: appends the slot's items as ordinary editable rows and remembers the slot. A second Load
    /// call for the same slot is a no-op: `refreshSuggestion` never re-shows a suggestion once
    /// `loadedSlotId` is set, so `suggestion` is nil by the time any second call could reach here.
    func loadSuggestion(_ app: AppModel) {
        guard let suggestion else { return }
        do {
            let items = (try app.store.planItems(entryIds: [suggestion.entryId])[suggestion.entryId]) ?? []
            lines.append(contentsOf: PlanSuggestion.lines(for: items, catalog: catalog,
                                                          newLineId: { UUID().uuidString }))
            loadedSlotId = suggestion.entryId
            self.suggestion = nil
            recompute(app)
        } catch {
            message = "Could not load the planned meal: \(error)"
        }
    }

    /// Skip: sets the slot to `skipped` (synced).
    func skipSuggestion(_ app: AppModel) {
        guard let suggestion,
              let entry = try? app.store.planEntry(date: suggestion.date, windowName: suggestion.windowName) else { return }
        do {
            try app.savePlan([PlanEditing.statusChange(entry, to: .skipped)])
            self.suggestion = nil
        } catch {
            message = "Could not skip the planned meal: \(error)"
        }
    }

    /// Dismiss: hides the suggestion for this slot on this device only. Never synced.
    func dismissSuggestion(_ app: AppModel) {
        guard let suggestion else { return }
        PlanDismissals.dismiss(date: suggestion.date, windowName: suggestion.windowName)
        self.suggestion = nil
    }

    func logIt(_ app: AppModel) throws {
        recompute(app)
        guard let result, !lines.isEmpty else { return }
        guard !AmountInput.hasInvalidAmount(lines) else {
            message = "\(AmountInput.invalidMessage). Fix it before logging."
            return
        }
        let takenUnits: Double?
        do {
            takenUnits = try TakenDoseInput.unitsForLog(taken)
        } catch {
            message = TakenDoseError.malformed.message
            return
        }
        let records = buildLogRecords(
            lines: lines, result: result, bg: bg, eatenAt: eatenAt, takenUnits: takenUnits,
            notes: notes.isEmpty ? nil : notes, newId: app.store.newId)
        var changes = [try SyncChange.encode("log_entry", records.entry)]
            + (try records.items.map { try SyncChange.encode("log_item", $0) })
        // Logging while a slot is loaded marks that slot logged and stores the link (spec §5).
        // Logging without loading changes nothing about the plan.
        if let loadedSlotId, let entry = (try? app.store.records("plan_entry", "WHERE deleted = 0 AND id = ?",
                                                                 [loadedSlotId]) as [PlanEntryData])?.first,
           let linked = PlanLogLink.loggedChange(entry, loggedTo: records.entry) {
            changes.append(linked)
        }
        try app.save(changes)
        let logged = "Logged \(formatNumber(records.entry.totalCarbsG))g" + (records.entry.takenUnits.map { ", \(formatNumber($0, digits: 2))u taken" } ?? "")
        message = logged
        postToWebhook(records.entry, items: records.items, logged: logged)
        lines = []
        loadedSlotId = nil
        takenField.reset()
        notes = ""
        manualBg = ""
        windowOverride = nil
        useNow = true
        recompute(app)
    }

    /// Posts the entry's accountability text, with its breakdown, to the device's webhook.
    ///
    /// Only logging posts, never a later edit — so nothing has to remember what was already sent.
    /// The entry is saved by the time this runs: a failure is a note appended to the status line,
    /// never a reason to unwind the log or to hold up the screen, so it runs off the save path.
    private func postToWebhook(_ entry: LogEntryData, items: [LogItemData], logged: String) {
        guard let url = Keychain.loadWebhook() else { return }
        let content = webhookMessage(
            AccountabilityInput(
                when: accountabilityStamp.string(from: Date(timeIntervalSince1970: Double(entry.eatenAt) / 1000)),
                bgMgdl: entry.bgMgdl, carbsG: entry.totalCarbsG, units: entry.takenUnits),
            items: webhookItemLines(for: items, catalog: catalog))
        Task { [weak self] in
            do {
                try await WebhookSender().send(content, to: url)
            } catch {
                // Only if the screen has not moved on to saying something else about a later action.
                guard let self, self.message == logged else { return }
                let detail = (error as? WebhookError)?.message ?? "The webhook could not be posted to."
                self.message = "\(logged). \(detail)"
            }
        }
    }

    func saveMeal(name: String, yieldServings: Double, totalWeightG: Double?, _ app: AppModel) throws {
        guard !AmountInput.hasInvalidAmount(lines) else { throw InvalidAmountError() }
        let records = buildMealRecords(name: name, yieldServings: yieldServings, totalWeightG: totalWeightG, lines: lines, newId: app.store.newId)
        try app.save([SyncChange.encode("meal", records.meal)] + records.items.map { try SyncChange.encode("meal_item", $0) })
        message = "Saved meal \(name)"
        reload(app)
    }
}
