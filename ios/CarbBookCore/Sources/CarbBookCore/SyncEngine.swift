import Foundation

/// Local persistence the sync engine drives. The iOS app implements it with GRDB; tests use an actor.
public protocol SyncStore: Sendable {
    /// Unpushed local changes (full records), oldest first, at most `limit`.
    func pendingChanges(limit: Int) async throws -> [SyncChange]
    /// accepted/ignored: clear the pending mark if the row still has the pushed version.
    /// rejected: keep the row, save the rejection for Settings → Sync, clear the pending mark.
    func recordPushResults(_ pushed: [SyncChange], _ results: [PushResult]) async throws
    func pullCursor() async throws -> Int64
    /// Applies pulled records using `shouldApplyPulled` and stores `nextSince`, atomically.
    func applyPull(_ changes: [SyncChange], nextSince: Int64) async throws
    func setLastSynced(_ ms: Int64) async throws
}

/// The server API. The iOS app implements it with URLSession.
public protocol SyncTransport: Sendable {
    func push(_ changes: [SyncChange]) async throws -> PushResponse
    func pull(since: Int64, limit: Int) async throws -> PullResponse
}

public struct SyncReport: Equatable, Sendable {
    public var accepted = 0
    public var ignored = 0
    public var rejected: [PushResult] = []
    public var pulled = 0

    public init() {}
}

/// Spec §5: push pending changes, then pull until drained. Any thrown error leaves pending
/// changes and the pull cursor as they were, so the next run retries.
public struct SyncEngine: Sendable {
    public static let maxPushChanges = 500
    public static let pullLimit = 500
    /// Bounds the push loop if rows keep changing while a push is in flight.
    public static let maxPushBatches = 20

    public let store: SyncStore
    public let transport: SyncTransport

    public init(store: SyncStore, transport: SyncTransport) {
        self.store = store
        self.transport = transport
    }

    public func run(nowMs: @Sendable () -> Int64) async throws -> SyncReport {
        var report = SyncReport()
        for _ in 0..<Self.maxPushBatches {
            let batch = try await store.pendingChanges(limit: Self.maxPushChanges)
            if batch.isEmpty { break }
            let response = try await transport.push(batch)
            try await store.recordPushResults(batch, response.results)
            for result in response.results {
                switch result.status {
                case "accepted": report.accepted += 1
                case "ignored": report.ignored += 1
                default: report.rejected.append(result)
                }
            }
            if batch.count < Self.maxPushChanges { break }
        }

        var since = try await store.pullCursor()
        while true {
            let page = try await transport.pull(since: since, limit: Self.pullLimit)
            try await store.applyPull(page.changes, nextSince: page.nextSince)
            report.pulled += page.changes.count
            let advanced = page.nextSince > since
            since = page.nextSince
            if !page.hasMore || !advanced { break }
        }
        try await store.setLastSynced(nowMs())
        return report
    }
}
