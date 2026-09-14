import CarbBookCore
@testable import CarbBookKit
import Foundation
import XCTest

final class SyncCoordinatorTests: XCTestCase {
    func testBackoff() {
        XCTAssertEqual((1...10).map { SyncCoordinator.backoffSeconds(afterFailures: $0) }, [2, 4, 8, 16, 32, 64, 128, 256, 300, 300])
    }

    func testLocalWritesAreDebouncedIntoOneSync() async throws {
        let server = FakeServer()
        let store = try LocalStore(path: nil, now: { 1_000 })
        let coordinator = SyncCoordinator(engine: SyncEngine(store: store, transport: server), now: { 1_000 }, debounce: .milliseconds(100))
        for i in 0..<3 {
            try store.save("food", FoodData(id: "f\(i)", name: "Food \(i)", source: "custom", carbsPer100g: 10))
            await coordinator.localWriteHappened()
        }
        try await Task.sleep(for: .milliseconds(600))
        let pulls = await server.pullCount
        XCTAssertEqual(pulls, 1)
        XCTAssertEqual(try store.pendingCount(), 0)
        let phase = await coordinator.phase
        XCTAssertEqual(phase, .idle)
    }

    func testUnauthorizedSignsOutAndKeepsPendingChanges() async throws {
        let server = FakeServer()
        await server.setFailure(APIError.unauthorized)
        let store = try LocalStore(path: nil, now: { 1_000 })
        try store.save("food", FoodData(id: "f1", name: "Rice", source: "custom", carbsPer100g: 28.2))
        let phases = PhaseRecorder()
        let coordinator = SyncCoordinator(engine: SyncEngine(store: store, transport: server), now: { 1_000 },
                                          onChange: { phase, _ in phases.append(phase) })
        await coordinator.syncNow()
        await coordinator.syncNow() // ignored while signed out
        XCTAssertEqual(phases.all, [.syncing, .signedOut])
        XCTAssertEqual(try store.pendingCount(), 1)

        await server.setFailure(nil)
        await coordinator.signedIn()
        await coordinator.stop()
        await coordinator.syncNow()
        XCTAssertEqual(try store.pendingCount(), 0)
    }

    func testFailureSchedulesRetry() async throws {
        struct Boom: Error {}
        let server = FakeServer()
        await server.setFailure(Boom())
        let store = try LocalStore(path: nil, now: { 1_000 })
        let coordinator = SyncCoordinator(engine: SyncEngine(store: store, transport: server), now: { 1_000 })
        await coordinator.syncNow()
        let phase = await coordinator.phase
        guard case .failed(_, let retry) = phase else { return XCTFail("expected failure, got \(phase)") }
        XCTAssertEqual(retry, 2)
        await coordinator.stop()
    }
}

final class PhaseRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var phases: [SyncPhase] = []
    func append(_ phase: SyncPhase) { lock.lock(); phases.append(phase); lock.unlock() }
    var all: [SyncPhase] { lock.lock(); defer { lock.unlock() }; return phases }
}
