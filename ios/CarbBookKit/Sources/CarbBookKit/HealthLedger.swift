import Foundation

/// Remembers which log entries have already been written to Apple Health, so re-saving an entry
/// cannot duplicate its samples (spec §1, "write once at save time").
///
/// Backed by an injected load/store pair rather than UserDefaults directly, so the rules are
/// testable on Linux. Order is oldest-first; the cap keeps the list from growing without bound.
public struct HealthLedger {
    public static let limit = 500

    private let load: () -> [String]
    private let store: ([String]) -> Void

    public init(load: @escaping () -> [String], store: @escaping ([String]) -> Void) {
        self.load = load
        self.store = store
    }

    public func wasWritten(_ id: String) -> Bool { load().contains(id) }

    public func markWritten(_ id: String) {
        var ids = load()
        guard !ids.contains(id) else { return }
        ids.append(id)
        if ids.count > Self.limit { ids.removeFirst(ids.count - Self.limit) }
        store(ids)
    }
}
