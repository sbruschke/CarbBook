import CarbBookCore
import CarbBookKit
import SwiftUI

/// Copy a day to a date, or the displayed week to the next one (spec §4). When any destination slot
/// already has a plan, the user picks replace / merge / skip before anything is written.
struct PlanCopySheet: View {
    @Environment(\.dismiss) private var dismiss
    let scope: PlanModel.CopyScope
    /// Destination keys that already hold a plan, for the chosen target.
    let occupied: ([String: String]) -> [String]
    let offsets: (String) -> [String: String]
    let onCopy: ([String: String], PlanEditing.CopyMode) -> Void

    @State private var target: Date
    @State private var mode: PlanEditing.CopyMode = .skip

    init(scope: PlanModel.CopyScope, occupied: @escaping ([String: String]) -> [String],
         offsets: @escaping (String) -> [String: String], onCopy: @escaping ([String: String], PlanEditing.CopyMode) -> Void) {
        self.scope = scope
        self.occupied = occupied
        self.offsets = offsets
        self.onCopy = onCopy
        // Never defaults to the source day itself (spec §4) — a day copy defaults one day later.
        let initial: String? = { if case .day(let date) = scope { PlanEditing.defaultCopyTarget(source: date) } else { nil } }()
        _target = State(initialValue: initial.flatMap(PlanDate.date) ?? Date())
    }

    private var sourceDate: String? { if case .day(let date) = scope { date } else { nil } }
    private var targetDateString: String { PlanDate.string(target) }
    private var currentOffsets: [String: String] { offsets(targetDateString) }
    private var clashes: [String] { occupied(currentOffsets) }
    private var isSelfCopy: Bool { PlanEditing.isSelfCopy(sourceDate: sourceDate, targetDate: targetDateString) }

    var body: some View {
        NavigationStack {
            Form {
                switch scope {
                case .day:
                    Section("Copy to") {
                        DatePicker("Date", selection: $target, displayedComponents: .date)
                        if isSelfCopy {
                            Text("Choose a different day — this is the day you're copying from.")
                                .font(.caption).foregroundStyle(.red)
                        }
                    }
                case .week:
                    Section { Text("Copies this week onto next week, day by day.") }
                }
                if clashes.isEmpty {
                    Section { Text("Nothing is planned in the destination yet.").foregroundStyle(.secondary) }
                } else {
                    Section {
                        Picker("When a slot already has a plan", selection: $mode) {
                            ForEach(PlanEditing.CopyMode.allCases, id: \.self) { Text($0.label).tag($0) }
                        }
                        .pickerStyle(.segmented)
                    } footer: {
                        Text("\(clashes.count) destination day(s) already have a plan: "
                             + "Replace clears everything planned on those days, Merge appends, Skip leaves them alone.")
                    }
                }
            }
            .navigationTitle(scope == .week ? "Copy week" : "Copy day")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Copy") {
                        onCopy(currentOffsets, mode)
                        dismiss()
                    }
                    .disabled(isSelfCopy)
                }
            }
            // No conflicts at the current target: any previously chosen mode no longer applies to
            // anything, so Copy always behaves as a plain (conflict-free) copy.
            .onChange(of: target) { if clashes.isEmpty { mode = .skip } }
        }
    }
}

extension PlanModel.CopyScope: Identifiable {
    var id: String {
        switch self {
        case .day(let date): "day-\(date)"
        case .week: "week"
        }
    }
}
