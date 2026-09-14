import CarbBookCore
import Crypto
import Foundation

/// Downloads the USDA SQLite bundle once and again whenever the server's version changes (spec §5/§6).
public struct UsdaInstaller: Sendable {
    public enum Outcome: Equatable, Sendable {
        case upToDate(version: String)
        case installed(version: String)
        case notImportedOnServer
    }

    let api: APIClient
    let store: LocalStore
    /// e.g. Application Support/usda
    let directory: URL

    public init(api: APIClient, store: LocalStore, directory: URL) {
        self.api = api
        self.store = store
        self.directory = directory
    }

    /// The installed bundle, if any.
    public func installedLibrary() throws -> UsdaLibrary? {
        guard let name = try store.dbQueue.read({ db in try store.state(db, "usda_file") }) else { return nil }
        let url = directory.appendingPathComponent(name)
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        return try UsdaLibrary(path: url.path)
    }

    public func update() async throws -> Outcome {
        guard let manifest = try await api.usdaManifest() else { return .notImportedOnServer }
        if let library = try installedLibrary(), library.version == manifest.version {
            return .upToDate(version: manifest.version)
        }
        let data = try await api.download(path: manifest.sqliteUrl)
        let actual = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        guard actual == manifest.sqliteSha256 else {
            throw UsdaError.checksumMismatch(expected: manifest.sqliteSha256, actual: actual)
        }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let final = directory.appendingPathComponent(manifest.sqliteFile)
        let partial = directory.appendingPathComponent(manifest.sqliteFile + ".partial")
        try data.write(to: partial, options: .atomic)
        let downloadedVersion = try UsdaLibrary(path: partial.path).version
        guard downloadedVersion == manifest.version else {
            try? FileManager.default.removeItem(at: partial)
            throw UsdaError.versionMismatch(expected: manifest.version, actual: downloadedVersion)
        }
        if FileManager.default.fileExists(atPath: final.path) { try FileManager.default.removeItem(at: final) }
        try FileManager.default.moveItem(at: partial, to: final)
        try await store.dbQueue.write { db in try store.setState(db, "usda_file", manifest.sqliteFile) }
        for old in try FileManager.default.contentsOfDirectory(atPath: directory.path) where old != manifest.sqliteFile {
            try? FileManager.default.removeItem(at: directory.appendingPathComponent(old))
        }
        return .installed(version: manifest.version)
    }
}
