import Foundation

/// Hash-keyed on-disk cache for `GET /api/images/:hash`.
///
/// The URL is the content hash, so a cached file never needs revalidating. Files live in Caches,
/// which the OS may purge at any time, so every read treats a miss as "fetch again" rather than an
/// error. `fileURL(for:)` returns a real path because UNNotificationAttachment requires one.
public actor ImageCache {
    public enum CacheError: Error, Equatable {
        case notAnImageHash(String)
        case emptyResponse(String)
    }

    private let directory: URL
    private let fetch: @Sendable (String) async throws -> Data
    /// Coalesces concurrent requests for the same hash into one download.
    private var inFlight: [String: Task<URL, Error>] = [:]

    /// Why the last fetch failed, and how many have. A thumbnail is deliberately silent when it
    /// cannot load — which also makes it undiagnosable on a device we cannot attach to, so the
    /// reason is kept here and surfaced in Settings rather than only thrown away by a `try?`.
    public private(set) var failures = 0
    public private(set) var lastFailure: String?

    public init(directory: URL, fetch: @escaping @Sendable (String) async throws -> Data) {
        self.directory = directory
        self.fetch = fetch
    }

    /// The server's own hash shape: a lowercase sha256 hex digest. Written out rather than as a
    /// regex literal because this target builds in Swift 5 language mode, where bare `/…/` literals
    /// are off.
    private static func isImageHash(_ hash: String) -> Bool {
        hash.count == 64 && hash.allSatisfy { ($0 >= "0" && $0 <= "9") || ($0 >= "a" && $0 <= "f") }
    }

    /// The hash is checked before anything touches the filesystem, so an id from a synced row — which
    /// the server validates but which may be anything after a bad pull — can never name a path
    /// outside the cache.
    public func fileURL(for hash: String) async throws -> URL {
        guard Self.isImageHash(hash) else {
            note("not a hash: \(hash.prefix(12))…")
            throw CacheError.notAnImageHash(hash)
        }
        let target = directory.appendingPathComponent("\(hash).jpg")
        if FileManager.default.fileExists(atPath: target.path) { return target }

        if let existing = inFlight[hash] { return try await existing.value }
        let task = Task<URL, Error> { [fetch, directory] in
            let data = try await fetch(hash)
            if data.isEmpty { throw CacheError.emptyResponse(hash) }
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            // `.atomic` writes a temporary file and renames it into place, so a cancelled or failed
            // download never leaves a truncated file at the content-addressed path, where it would
            // be served for ever.
            try data.write(to: target, options: .atomic)
            return target
        }
        inFlight[hash] = task
        defer { inFlight[hash] = nil }
        do {
            return try await task.value
        } catch {
            note("\(hash.prefix(8))…: \(error)")
            throw error
        }
    }

    private func note(_ reason: String) {
        failures += 1
        lastFailure = reason
    }
}
