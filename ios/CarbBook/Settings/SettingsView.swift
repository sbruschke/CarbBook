import CarbBookCore
import CarbBookKit
import SwiftUI

struct SettingsView: View {
    @Environment(AppModel.self) private var app
    @State private var versions: [DoseSettingsData] = []
    @State private var rejectedIds: Set<Id> = []
    @State private var pending = 0
    @State private var lastSynced: Int64?

    /// The same shared filter Calculator and the Log editor use before picking an active version
    /// (`eligibleDoseSettingsVersions`, keyed on `LocalStore.rejectedDoseSettingsIds()`), so "in
    /// effect" here always agrees with what a new dose estimate would actually use.
    private var active: DoseSettingsData? {
        activeSettings(eligibleDoseSettingsVersions(versions, rejectedIds: rejectedIds), nowMs())
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Account") {
                    LabeledContent("User", value: app.user?.username ?? "—")
                    LabeledContent("Role", value: app.user?.role ?? "—")
                    NavigationLink("Signed-in devices") { TokensView() }
                    Button("Sign out", role: .destructive) { Task { await app.signOut() } }
                }
                Section("Sync") {
                    NavigationLink {
                        SyncStatusView()
                    } label: {
                        LabeledContent("Status", value: phaseText(app.syncPhase))
                    }
                    LabeledContent("Last synced", value: lastSynced.map { date(ms: $0).formatted(.relative(presentation: .named)) } ?? "never")
                    LabeledContent("Pending changes", value: String(pending))
                }
                Section("Dose settings") {
                    if let active {
                        DoseSettingsSummary(settings: active)
                    } else {
                        Text("No dose settings in effect yet.").foregroundStyle(.secondary)
                    }
                    if app.isOwner {
                        NavigationLink("New version…") { DoseSettingsEditorView(base: active) }
                    }
                    NavigationLink("Version history") { VersionHistoryView(versions: versions, rejectedIds: rejectedIds) }
                }
                Section("USDA library") {
                    Text(app.usdaStatus)
                    Button("Check for update") { Task { await app.updateUsda() } }
                }
            }
            .navigationTitle("Settings")
            .onAppear(perform: load)
            .onChange(of: app.revision) { load() }
            .onChange(of: app.syncPhase) { load() }
        }
    }

    private func load() {
        versions = (try? app.store.doseSettingsVersions()) ?? []
        rejectedIds = (try? app.store.rejectedDoseSettingsIds()) ?? []
        pending = (try? app.store.pendingCount()) ?? 0
        lastSynced = (try? app.store.lastSyncedMs()) ?? nil
    }
}

func phaseText(_ phase: SyncPhase) -> String {
    switch phase {
    case .idle: "Up to date"
    case .syncing: "Syncing…"
    case .failed(_, let retry): "Failed, retrying in \(retry)s"
    case .signedOut: "Signed out"
    }
}

struct DoseSettingsSummary: View {
    let settings: DoseSettingsData

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Effective \(date(ms: settings.effectiveFrom).formatted(date: .abbreviated, time: .shortened))")
                .font(.caption).foregroundStyle(.secondary)
            ForEach(settings.windows, id: \.name) { window in
                Text("\(window.start)  \(window.name)  1:\(formatNumber(window.ratioGPerUnit, digits: 2))").font(.callout.monospaced())
            }
            Text("Correction: above \(formatNumber(settings.correction.threshold, digits: 0)), \(formatNumber(settings.correction.unitsPerStep, digits: 2))u per \(formatNumber(settings.correction.step, digits: 0)) (\(settings.correction.mode))")
                .font(.caption)
            Text("Rounding: \(formatNumber(settings.rounding.increment, digits: 2))u" + (settings.rounding.roundDownBelowBg.map { ", down below BG \(formatNumber($0, digits: 0))" } ?? ""))
                .font(.caption)
        }
    }
}

struct VersionHistoryView: View {
    let versions: [DoseSettingsData]
    let rejectedIds: Set<Id>

    var body: some View {
        let activeId = activeSettings(eligibleDoseSettingsVersions(versions, rejectedIds: rejectedIds), nowMs())?.id
        List(versions, id: \.id) { version in
            VStack(alignment: .leading) {
                if rejectedIds.contains(version.id) {
                    Text("Rejected by the server — see Sync").font(.caption.bold()).foregroundStyle(.red)
                } else if version.id == activeId {
                    Text("In effect").font(.caption.bold()).foregroundStyle(.green)
                } else if version.effectiveFrom > nowMs() {
                    Text("Scheduled").font(.caption.bold()).foregroundStyle(.blue)
                }
                DoseSettingsSummary(settings: version)
            }
        }
        .navigationTitle("Version history")
    }
}

struct SyncStatusView: View {
    @Environment(AppModel.self) private var app
    @State private var rejections: [SyncRejection] = []
    @State private var queued: [(code: String, note: String?)] = []

    var body: some View {
        Form {
            Section {
                LabeledContent("Status", value: phaseText(app.syncPhase))
                if case .failed(let message, _) = app.syncPhase {
                    Text(message).font(.caption).foregroundStyle(.red)
                }
                Button("Sync now") { Task { await app.coordinator.syncNow() } }
            }
            Section {
                if rejections.isEmpty { Text("None").foregroundStyle(.secondary) }
                ForEach(rejections, id: \.recordId) { rejection in
                    VStack(alignment: .leading) {
                        Text("\(rejection.table) · \(rejection.reason ?? "rejected")").font(.headline)
                        Text(rejection.message ?? "").font(.caption)
                        Button("Dismiss") {
                            try? app.store.dismissRejection(table: rejection.table, recordId: rejection.recordId)
                            load()
                        }
                        .buttonStyle(.borderless)
                    }
                }
            } header: {
                Text("Rejected by the server")
            } footer: {
                Text("These changes stay on this phone but were not accepted. Edit the record to try again.")
            }
            Section("Barcodes to look up") {
                if queued.isEmpty { Text("None").foregroundStyle(.secondary) }
                ForEach(queued, id: \.code) { item in
                    LabeledContent(item.code, value: item.note ?? "")
                }
            }
        }
        .navigationTitle("Sync")
        .onAppear(perform: load)
        .onChange(of: app.syncPhase) { load() }
    }

    private func load() {
        rejections = (try? app.store.rejections()) ?? []
        queued = (try? app.store.queuedBarcodes()) ?? []
    }
}

struct TokensView: View {
    @Environment(AppModel.self) private var app
    @State private var tokens: [TokenInfo] = []
    @State private var error: String?

    var body: some View {
        List {
            if let error { Text(error).foregroundStyle(.red) }
            ForEach(tokens) { token in
                VStack(alignment: .leading) {
                    Text(token.label ?? "iOS")
                    Text("Last used \(date(ms: token.lastUsedAt).formatted(.relative(presentation: .named)))")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            .onDelete { offsets in
                let ids = offsets.map { tokens[$0].id }
                Task {
                    for id in ids { try? await app.api.revokeToken(id: id) }
                    await load()
                }
            }
        }
        .navigationTitle("Signed-in devices")
        .task { await load() }
    }

    private func load() async {
        do {
            tokens = try await app.api.tokens()
            error = nil
        } catch {
            self.error = "Could not load devices: \(error)"
        }
    }
}
