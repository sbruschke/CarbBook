import CarbBookCore
import Foundation

public enum SyncPhase: Equatable, Sendable {
    case idle
    case syncing
    case failed(message: String, retryInSeconds: Int)
    /// 401: the token was revoked or is unknown. Pending changes are kept for after re-login.
    case signedOut
}

/// Runs the sync engine on the spec §5 triggers: launch/foreground and reconnect (`syncNow`),
/// after local writes debounced by 2 s (`localWriteHappened`), and every 60 s while running.
/// Overlapping requests coalesce into one follow-up run; failures retry with exponential backoff.
public actor SyncCoordinator {
    let engine: SyncEngine
    let now: @Sendable () -> Int64
    let debounce: Duration
    let interval: Duration
    let onChange: @Sendable (SyncPhase, SyncReport?) -> Void

    private var running = false
    private var rerunRequested = false
    private var failures = 0
    private var debounceTask: Task<Void, Never>?
    private var periodicTask: Task<Void, Never>?
    private var retryTask: Task<Void, Never>?
    public private(set) var phase: SyncPhase = .idle

    public init(
        engine: SyncEngine,
        now: @escaping @Sendable () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) },
        debounce: Duration = .seconds(2),
        interval: Duration = .seconds(60),
        onChange: @escaping @Sendable (SyncPhase, SyncReport?) -> Void = { _, _ in }
    ) {
        self.engine = engine
        self.now = now
        self.debounce = debounce
        self.interval = interval
        self.onChange = onChange
    }

    /// 2 s, 4 s, 8 s … capped at 5 minutes.
    public static func backoffSeconds(afterFailures failures: Int) -> Int {
        min(300, 2 << min(max(failures - 1, 0), 8))
    }

    public func start() {
        periodicTask?.cancel()
        periodicTask = Task { [interval] in
            while !Task.isCancelled {
                await self.syncNow()
                try? await Task.sleep(for: interval)
            }
        }
    }

    public func stop() {
        periodicTask?.cancel()
        debounceTask?.cancel()
        retryTask?.cancel()
        periodicTask = nil
        debounceTask = nil
        retryTask = nil
    }

    public func localWriteHappened() {
        debounceTask?.cancel()
        debounceTask = Task { [debounce] in
            try? await Task.sleep(for: debounce)
            if Task.isCancelled { return }
            await self.syncNow()
        }
    }

    /// After a successful re-login.
    public func signedIn() {
        if phase == .signedOut { setPhase(.idle, nil) }
        start()
    }

    public func syncNow() async {
        if phase == .signedOut { return }
        if running {
            rerunRequested = true
            return
        }
        running = true
        repeat {
            rerunRequested = false
            setPhase(.syncing, nil)
            do {
                let report = try await engine.run(nowMs: now)
                failures = 0
                setPhase(.idle, report)
            } catch APIError.unauthorized {
                stop()
                setPhase(.signedOut, nil)
                rerunRequested = false
            } catch {
                failures += 1
                let delay = Self.backoffSeconds(afterFailures: failures)
                setPhase(.failed(message: String(describing: error), retryInSeconds: delay), nil)
                retryTask?.cancel()
                retryTask = Task {
                    try? await Task.sleep(for: .seconds(delay))
                    if Task.isCancelled { return }
                    await self.syncNow()
                }
                rerunRequested = false
            }
        } while rerunRequested
        running = false
    }

    private func setPhase(_ newPhase: SyncPhase, _ report: SyncReport?) {
        phase = newPhase
        onChange(newPhase, report)
    }
}
