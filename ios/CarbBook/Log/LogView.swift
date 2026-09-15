import CarbBookCore
import CarbBookKit
import SwiftUI

struct LogView: View {
    @Environment(AppModel.self) private var app
    @State private var day = Date()
    @State private var entries: [LogEntryData] = []

    var body: some View {
        NavigationStack {
            List {
                Section {
                    DatePicker("Day", selection: $day, displayedComponents: .date)
                    LabeledContent("Carbs", value: "\(formatNumber(entries.reduce(0) { $0 + $1.totalCarbsG }))g")
                    LabeledContent("Insulin taken", value: "\(formatNumber(entries.reduce(0) { $0 + ($1.takenUnits ?? 0) }, digits: 2))u")
                }
                Section("Entries") {
                    ForEach(entries, id: \.id) { entry in
                        NavigationLink {
                            LogEntryView(entry: entry)
                        } label: {
                            row(entry)
                        }
                    }
                    .onDelete(perform: delete)
                }
            }
            .overlay {
                if entries.isEmpty {
                    ContentUnavailableView("Nothing logged", systemImage: "list.bullet.rectangle")
                }
            }
            .navigationTitle("Log")
            .onAppear(perform: load)
            .onChange(of: day) { load() }
            .onChange(of: app.revision) { load() }
        }
    }

    private func row(_ entry: LogEntryData) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(date(ms: entry.eatenAt).formatted(date: .omitted, time: .shortened))
                Text(entry.windowName ?? "").foregroundStyle(.secondary)
                Spacer()
                Text("\(formatNumber(entry.totalCarbsG))g").monospacedDigit()
            }
            HStack {
                if let bg = entry.bgMgdl {
                    Text("BG \(formatNumber(bg, digits: 0))").foregroundStyle(Theme.glucoseColor(bg))
                }
                Spacer()
                Text("suggested \(entry.suggestedUnits.map { formatNumber($0, digits: 2) } ?? "—") · taken \(entry.takenUnits.map { formatNumber($0, digits: 2) } ?? "—")")
                    .foregroundStyle(.secondary)
            }
            .font(.caption)
        }
    }

    private func load() {
        let start = Calendar.current.startOfDay(for: day)
        let end = Calendar.current.date(byAdding: .day, value: 1, to: start)!
        entries = (try? app.store.logEntries(from: ms(start), to: ms(end))) ?? []
    }

    private func delete(_ offsets: IndexSet) {
        for index in offsets {
            let entry = entries[index]
            for item in (try? app.store.logItems(entryId: entry.id)) ?? [] {
                try? app.delete("log_item", id: item.id)
            }
            try? app.delete("log_entry", id: entry.id)
        }
    }
}
