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

    @State private var target = Date()
    @State private var mode: PlanEditing.CopyMode = .skip

    private var currentOffsets: [String: String] { offsets(PlanDate.string(target)) }
    private var clashes: [String] { occupied(currentOffsets) }

    var body: some View {
        NavigationStack {
            Form {
                switch scope {
                case .day:
                    Section("Copy to") { DatePicker("Date", selection: $target, displayedComponents: .date) }
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
                        Text("\(clashes.count) destination slot(s) already planned: "
                             + "Replace overwrites their items, Merge appends, Skip leaves them alone.")
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
                }
            }
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
