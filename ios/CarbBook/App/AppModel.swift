import CarbBookCore
import CarbBookKit
import Foundation
import Network
import Observation
import UIKit

/// Forwards sync coordinator callbacks (any thread) to the main-actor model.
final class SyncRelay: @unchecked Sendable {
    weak var model: AppModel?
}

@Observable
@MainActor
final class AppModel {
    static let serverURL = URL(string: "https://recipes.dxshdw.dev")!

    let store: LocalStore
    let api: APIClient
    let coordinator: SyncCoordinator
    let usdaInstaller: UsdaInstaller
    var usda: UsdaLibrary?
    var usdaStatus = "USDA library not downloaded yet"
    var user: ApiUser?
    var needsLogin: Bool
    var syncPhase: SyncPhase = .idle
    /// Bumped after local writes and completed syncs so screens reload.
    var revision = 0

    @ObservationIgnored private let pathMonitor = NWPathMonitor()
    @ObservationIgnored private var wasOnline = true
    @ObservationIgnored private var started = false

    init() {
        let support = try! FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        do {
            store = try LocalStore(path: support.appendingPathComponent("carbbook.sqlite").path)
        } catch {
            fatalError("CarbBook could not open its database: \(error)")
        }
        api = APIClient(baseURL: Self.serverURL, token: { Keychain.loadToken() })
        let relay = SyncRelay()
        coordinator = SyncCoordinator(engine: SyncEngine(store: store, transport: api), onChange: { phase, report in
            Task { @MainActor in relay.model?.syncChanged(phase, report) }
        })
        usdaInstaller = UsdaInstaller(api: api, store: store, directory: support.appendingPathComponent("usda"))
        needsLogin = Keychain.loadToken() == nil
        user = UserDefaults.standard.data(forKey: "user").flatMap { try? JSONDecoder().decode(ApiUser.self, from: $0) }
        usda = try? usdaInstaller.installedLibrary()
        if let version = usda?.version { usdaStatus = "USDA library \(version)" }
        relay.model = self
        let coordinator = coordinator
        store.setLocalWriteHandler { Task { await coordinator.localWriteHappened() } }
    }

    var isOwner: Bool { user?.role == "owner" }

    func start() {
        guard !started else { return }
        started = true
        pathMonitor.pathUpdateHandler = { [weak self] path in
            let online = path.status == .satisfied
            Task { @MainActor in self?.networkChanged(online: online) }
        }
        pathMonitor.start(queue: .main)
        guard !needsLogin else { return }
        Task {
            await coordinator.start()
            await updateUsda()
        }
    }

    func foreground() {
        guard !needsLogin else { return }
        Task { await coordinator.syncNow() }
    }

    private func networkChanged(online: Bool) {
        defer { wasOnline = online }
        if online && !wasOnline && !needsLogin {
            Task { await coordinator.syncNow() }
        }
    }

    private func syncChanged(_ phase: SyncPhase, _ report: SyncReport?) {
        syncPhase = phase
        if phase == .signedOut { needsLogin = true }
        if report != nil { revision += 1 }
    }

    func signIn(username: String, password: String) async throws {
        let response = try await api.login(username: username, password: password, deviceName: UIDevice.current.name)
        try Keychain.saveToken(response.token)
        user = response.user
        UserDefaults.standard.set(try JSONEncoder().encode(response.user), forKey: "user")
        needsLogin = false
        await coordinator.signedIn()
        await updateUsda()
    }

    /// Revokes this device's token when reachable. Local data and pending changes stay on the phone.
    func signOut() async {
        try? await api.logout()
        Keychain.deleteToken()
        await coordinator.stop()
        needsLogin = true
    }

    func updateUsda() async {
        do {
            switch try await usdaInstaller.update() {
            case .installed(let version), .upToDate(let version):
                usda = try usdaInstaller.installedLibrary()
                usdaStatus = "USDA library \(version)"
            case .notImportedOnServer:
                usdaStatus = "The server has no USDA library yet"
            }
        } catch {
            usdaStatus = "USDA update failed: \(error)"
        }
    }

    func save(_ changes: [SyncChange]) throws {
        try store.save(changes)
        revision += 1
    }

    func delete(_ table: String, id: Id) throws {
        try store.softDelete(table, id: id)
        revision += 1
    }
}
