import CarbBookCore
import CarbBookKit
import SwiftUI

struct LogView: View {
    @Environment(AppModel.self) private var app
    @State private var day = Date()
    @State private var entries: [LogEntryData] = []
    @State private var windows: [DoseWindow] = []
    /// The day's items grouped by entry, and the catalog that turns an item's reference into its
    /// food's or meal's photo. Both are read once per load — never once per row.
    @State private var itemsByEntry: [Id: [LogItemData]] = [:]
    @State private var catalog = InMemoryCatalog()

    /// The goal of the window an entry was logged in, if that window still has one.
    private func goal(for entry: LogEntryData) -> CarbGoal? {
        guard let name = entry.windowName else { return nil }
        return windows.first { $0.name == name }?.carbGoal
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    DatePicker("Day", selection: $day, displayedComponents: .date)
                    HStack {
                        Text("Carbs")
                        Spacer()
                        // Per spec: carb goals are per meal/snack only, never a cumulative day goal.
                        // This is a plain gram total with no goal colour or goal text.
                        Text("\(formatNumber(entries.reduce(0) { $0 + $1.totalCarbsG }, digits: 0)) g")
                            .monospacedDigit()
                            .foregroundStyle(.secondary)
                    }
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
        let items = itemsByEntry[entry.id] ?? []
        return HStack {
            // The log is where recognising what was eaten at a glance matters most, so the entry's
            // items show as a carb-ordered stack. The carbs are the logged snapshot already on each
            // item row, so nothing is recomputed here.
            ImageStackView(entries: loggedStackEntries(items, catalog: catalog), size: 28)
            VStack(alignment: .leading, spacing: 2) {
                HStack {
                    Text(date(ms: entry.eatenAt).formatted(date: .omitted, time: .shortened))
                    Text(entry.windowName ?? "").foregroundStyle(.secondary)
                    Spacer()
                    GoalBadge(style: goalStyle(CarbResult(carbsG: entry.totalCarbsG, complete: true), goal(for: entry)),
                              font: .body)
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
    }

    private func load() {
        let start = Calendar.current.startOfDay(for: day)
        let end = Calendar.current.date(byAdding: .day, value: 1, to: start)!
        entries = (try? app.store.logEntries(from: ms(start), to: ms(end))) ?? []
        itemsByEntry = (try? app.store.logItems(entryIds: entries.map(\.id))) ?? [:]
        catalog = (try? app.store.catalog()) ?? InMemoryCatalog()
        let versions = (try? app.store.doseSettingsVersions()) ?? []
        let usable = eligibleDoseSettingsVersions(versions, rejectedIds: (try? app.store.rejectedDoseSettingsIds()) ?? [])
        windows = activeSettings(usable, ms(day))?.windows ?? []
    }

    /// Deletes each entry and its items, and returns any slot pointing at it to `planned` with the
    /// link cleared — all in one transaction (`LocalStore.deleteLogEntry`, spec §5), so the Plan
    /// screen is right immediately and offline; the server applies the same rule when this delete
    /// pushes.
    private func delete(_ offsets: IndexSet) {
        for index in offsets {
            try? app.deleteLogEntry(entries[index].id)
        }
    }
}
