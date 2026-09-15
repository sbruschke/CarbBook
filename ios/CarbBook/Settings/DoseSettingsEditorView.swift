import CarbBookCore
import CarbBookKit
import SwiftUI

/// Owner-only editor. Always saves a new version with an effective date; existing versions are
/// never edited or deleted because the server rejects that (`append_only`). Validated the same way
/// core's estimator will validate it later: server field checks (`validateDoseSettings`) plus the
/// app's sanity ceilings (`hasInvalidSettings`/`DoseLimits`), so a version that would silently make
/// every future dose estimate refuse with `invalid_settings` is never saved in the first place.
struct DoseSettingsEditorView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let base: DoseSettingsData?

    private struct WindowDraft: Identifiable {
        let id = UUID()
        var name: String
        var start: Date
        var ratio: String
    }

    @State private var windows: [WindowDraft] = []
    @State private var threshold = "200"
    @State private var step = "50"
    @State private var unitsPerStep = "1"
    @State private var mode = "started"
    @State private var increment = "1"
    @State private var roundDownEnabled = true
    @State private var roundDownBelow = "130"
    @State private var effectiveFrom = Date()
    @State private var error: String?
    @State private var loaded = false

    var body: some View {
        Form {
            if !app.isOwner {
                Section { Text("Only the owner can change dose settings.").foregroundStyle(.orange) }
            }
            Section {
                ForEach($windows) { $window in
                    VStack {
                        TextField("Name", text: $window.name)
                        DatePicker("Starts", selection: $window.start, displayedComponents: .hourAndMinute)
                        NumberField(label: "Carb ratio 1:", text: $window.ratio, unit: "g/u")
                    }
                }
                .onDelete { windows.remove(atOffsets: $0) }
                Button("Add window") {
                    windows.append(WindowDraft(name: "", start: Calendar.current.startOfDay(for: Date()), ratio: "10"))
                }
            } header: {
                Text("Meal windows")
            } footer: {
                Text("Each window runs until the next one starts; the last wraps past midnight. Ratio must be > 0 and at most \(formatNumber(DoseLimits.maxRatioGPerUnit, digits: 0)) g/u.")
            }
            Section("Correction") {
                NumberField(label: "Above BG", text: $threshold, unit: "mg/dL")
                NumberField(label: "Every", text: $step, unit: "mg/dL")
                NumberField(label: "Add", text: $unitsPerStep, unit: "u")
                Picker("Mode", selection: $mode) {
                    Text("Started step").tag("started")
                    Text("Full steps").tag("full")
                    Text("Proportional").tag("proportional")
                }
            }
            Section("Rounding") {
                NumberField(label: "Increment", text: $increment, unit: "u")
                Toggle("Round down when BG is low", isOn: $roundDownEnabled)
                if roundDownEnabled {
                    NumberField(label: "Round down below", text: $roundDownBelow, unit: "mg/dL")
                }
            }
            Section {
                DatePicker("Effective from", selection: $effectiveFrom)
            } footer: {
                Text("Saved as a new version. Earlier versions stay in the history unchanged.")
            }
            if let error { Section { Text(error).foregroundStyle(.red) } }
        }
        .navigationTitle("New dose settings")
        .toolbar {
            ToolbarItem(placement: .confirmationAction) { Button("Save version") { save() }.disabled(!app.isOwner) }
        }
        .onAppear(perform: load)
    }

    private func load() {
        guard !loaded else { return }
        loaded = true
        guard let base else {
            windows = [WindowDraft(name: "All day", start: Calendar.current.startOfDay(for: Date()), ratio: "10")]
            return
        }
        windows = base.windows.map { window in
            let minutes = (try? parseHHMM(window.start)) ?? 0
            let start = Calendar.current.date(byAdding: .minute, value: minutes, to: Calendar.current.startOfDay(for: Date()))!
            return WindowDraft(name: window.name, start: start, ratio: NumberParsing.editText(window.ratioGPerUnit))
        }
        threshold = NumberParsing.editText(base.correction.threshold)
        step = NumberParsing.editText(base.correction.step)
        unitsPerStep = NumberParsing.editText(base.correction.unitsPerStep)
        mode = base.correction.mode
        increment = NumberParsing.editText(base.rounding.increment)
        roundDownEnabled = base.rounding.roundDownBelowBg != nil
        roundDownBelow = NumberParsing.editText(base.rounding.roundDownBelowBg ?? 130)
    }

    private func hhmm(_ date: Date) -> String {
        let parts = Calendar.current.dateComponents([.hour, .minute], from: date)
        return String(format: "%02d:%02d", parts.hour ?? 0, parts.minute ?? 0)
    }

    private func save() {
        guard app.isOwner else {
            error = "Only the owner can change dose settings."
            return
        }
        // Every amount is parsed strictly; a malformed field becomes NaN (never a silent 0), which
        // both validateDoseSettings and hasInvalidSettings reject via their isFinite checks below.
        let draft = DoseSettingsData(
            id: "draft",
            effectiveFrom: ms(effectiveFrom),
            windows: windows.map { DoseWindow(name: $0.name.trimmingCharacters(in: .whitespaces), start: hhmm($0.start),
                                              ratioGPerUnit: parseNumber($0.ratio) ?? .nan) },
            correction: CorrectionRule(threshold: parseNumber(threshold) ?? .nan, step: parseNumber(step) ?? .nan,
                                       unitsPerStep: parseNumber(unitsPerStep) ?? .nan, mode: mode),
            rounding: RoundingRule(increment: parseNumber(increment) ?? .nan,
                                   roundDownBelowBg: roundDownEnabled ? (parseNumber(roundDownBelow) ?? .nan) : nil))
        let version = newDoseSettingsVersion(from: draft, effectiveFrom: ms(effectiveFrom), newId: app.store.newId)
        if let message = validateDoseSettings(version) {
            error = message
            return
        }
        if hasInvalidSettings(version) {
            error = "These settings are outside the app's sanity limits: ratio ≤ \(formatNumber(DoseLimits.maxRatioGPerUnit, digits: 0)) g/u, "
                + "threshold ≤ \(formatNumber(DoseLimits.maxCorrectionThreshold, digits: 0)), step ≤ \(formatNumber(DoseLimits.maxCorrectionStep, digits: 0)), "
                + "units per step ≤ \(formatNumber(DoseLimits.maxUnitsPerStep, digits: 0)), rounding increment ≤ \(formatNumber(DoseLimits.maxRoundingIncrement, digits: 0)), "
                + "round-down BG ≤ \(formatNumber(DoseLimits.maxRoundDownBelowBg, digits: 0))."
            return
        }
        do {
            try app.save([SyncChange.encode("dose_settings", version)])
            dismiss()
        } catch {
            self.error = "Could not save: \(error)"
        }
    }
}
