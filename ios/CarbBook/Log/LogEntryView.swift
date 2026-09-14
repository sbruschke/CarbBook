import CarbBookCore
import CarbBookKit
import SwiftUI

/// Edit any log entry; "Recalculate from current meal" refreshes its snapshot (spec §8).
///
/// `taken_units` and BG are only changed if the user actually edits those fields: re-displaying a
/// stored value through `formatNumber` and parsing it back can lose precision (e.g. a Dexcom
/// `bg_mgdl` of 120.4 round-trips through the whole-number BG field as 120), so a field whose text
/// still equals what it was loaded with is saved back verbatim from `entry` instead of the parsed
/// text — `bgEdited`/`takenEdited` compare against the originally loaded text, not a change flag,
/// so this holds regardless of when SwiftUI happens to evaluate the field during `onAppear`.
struct LogEntryView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let entry: LogEntryData

    @State private var eatenAt = Date()
    @State private var bg = ""
    @State private var loadedBgText = ""
    @State private var taken = ""
    @State private var loadedTakenText = ""
    @State private var notes = ""
    @State private var items: [LogItemData] = []
    @State private var draft: LogEntryData?
    @State private var message: String?
    @State private var loaded = false

    private var current: LogEntryData { draft ?? entry }
    private var bgEdited: Bool { bg != loadedBgText }
    private var takenEdited: Bool { taken != loadedTakenText }

    var body: some View {
        Form {
            Section("Entry") {
                DatePicker("Eaten at", selection: $eatenAt)
                NumberField(label: "BG", text: $bg, unit: "mg/dL")
                if bgEdited && !bg.trimmingCharacters(in: .whitespaces).isEmpty && parseWholeNumber(bg) == nil {
                    Text("Invalid BG. Enter a whole number of mg/dL.").font(.caption).foregroundStyle(.red)
                }
                LabeledContent("Window", value: current.windowName ?? "—")
                LabeledContent("Carbs", value: "\(formatNumber(current.totalCarbsG))g")
                LabeledContent("Suggested", value: current.suggestedUnits.map { "\(formatNumber($0, digits: 2))u" } ?? "—")
                NumberField(label: "Taken", text: $taken, unit: "u")
                TextField("Notes", text: $notes, axis: .vertical)
            }
            if showsRecentDoseWarning {
                Section {
                    Label("Another dose was logged within 4 hours of this one. Insulin on board is not subtracted.",
                         systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.red)
                }
            }
            Section("Items") {
                ForEach(items, id: \.id) { item in
                    HStack {
                        VStack(alignment: .leading) {
                            Text(item.displayName)
                            Text("\(formatNumber(item.amount, digits: 2)) \(item.unit.hasPrefix(Units.portionPrefix) ? "portion" : unitLabel(item.unit, portions: []))")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Text("\(formatNumber(item.carbsG))g").monospacedDigit()
                    }
                }
                Button("Recalculate from current meal") { recalculate() }
            }
            if let message { Section { Text(message).foregroundStyle(.secondary) } }
        }
        .navigationTitle("Log entry")
        .toolbar {
            ToolbarItem(placement: .confirmationAction) { Button("Save") { save() } }
        }
        .onAppear(perform: load)
    }

    private var showsRecentDoseWarning: Bool {
        guard let lastOtherDose = (try? app.store.lastDoseAtMs(excluding: entry.id)) ?? nil else { return false }
        return recentDoseWarning(lastOtherDose, ms(eatenAt))
    }

    private func load() {
        guard !loaded else { return }
        loaded = true
        eatenAt = date(ms: entry.eatenAt)
        bg = formatNumber(entry.bgMgdl, digits: 0)
        loadedBgText = bg
        taken = formatNumber(entry.takenUnits, digits: 2)
        loadedTakenText = taken
        notes = entry.notes ?? ""
        items = (try? app.store.logItems(entryId: entry.id)) ?? []
    }

    private func recalculate() {
        do {
            let result = recalculateLogEntry(
                entry: current, items: items, catalog: try app.store.catalog(),
                settingsVersions: try app.store.doseSettingsVersions(),
                rejectedSettingsIds: try app.store.rejectedDoseSettingsIds())
            draft = result.entry
            items = result.items
            message = result.complete
                ? "Recalculated from current data. Save to keep it."
                : "Recalculated, but some items are missing data, so there is no suggested dose. Carbs were not lowered. Save to keep it."
        } catch {
            message = "Could not recalculate: \(error)"
        }
    }

    private func save() {
        if bgEdited, !bg.trimmingCharacters(in: .whitespaces).isEmpty, parseWholeNumber(bg) == nil {
            message = "Invalid BG. Enter a whole number of mg/dL, or clear the field."
            return
        }
        var updated = current
        updated.eatenAt = ms(eatenAt)
        if bgEdited {
            let bgValue = parseWholeNumber(bg)
            updated.bgMgdl = bgValue
            updated.bgSource = bgValue == nil ? "none" : "manual"
            updated.bgTrend = nil
        }
        if takenEdited {
            updated.takenUnits = parseNumber(taken)
        }
        updated.notes = notes.isEmpty ? nil : notes
        do {
            try app.save([SyncChange.encode("log_entry", updated)] + items.map { try SyncChange.encode("log_item", $0) })
            dismiss()
        } catch {
            message = "Could not save: \(error)"
        }
    }
}
