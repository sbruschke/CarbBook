import CarbBookCore
@testable import CarbBookKit
import Crypto
import Foundation
import XCTest

final class UsdaInstallerTests: XCTestCase {
    func testInstallerVerifiesChecksumInstallsAndSkipsSameVersion() async throws {
        let source = try temporaryDirectory().appendingPathComponent("src.sqlite").path
        try makeUsdaBundle(at: source, version: "2026-09-14-abc")
        let bytes = try Data(contentsOf: URL(fileURLWithPath: source))
        let sha = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        let badSha = TestClock(0) // reused as a mutable flag holder: ms == 1 → serve a wrong checksum
        let stub = StubTransport { request in
            switch request.url!.path {
            case "/api/usda/manifest":
                let checksum = badSha.ms == 1 ? String(repeating: "0", count: 64) : sha
                return (200, json(#"{"version":"2026-09-14-abc","food_count":3,"portion_count":2,"sqlite_file":"usda-abc.sqlite","sqlite_sha256":"\#(checksum)","sqlite_url":"/api/usda/files/usda-abc.sqlite","json_file":"usda-abc.json.gz","json_sha256":"x","json_url":"/api/usda/files/usda-abc.json.gz","created_at":"2026-09-14T00:00:00Z"}"#))
            case "/api/usda/files/usda-abc.sqlite":
                return (200, bytes)
            default:
                return (404, json(#"{"error":"not_found","message":"no"}"#))
            }
        }
        let store = try LocalStore(path: nil, now: { 1_000 })
        let directory = try temporaryDirectory().appendingPathComponent("usda")
        let installer = UsdaInstaller(api: APIClient(baseURL: URL(string: "https://x.test")!, transport: stub, token: { "t" }),
                                      store: store, directory: directory)

        badSha.ms = 1
        do {
            _ = try await installer.update()
            XCTFail("expected a checksum error")
        } catch UsdaError.checksumMismatch {}
        XCTAssertNil(try installer.installedLibrary())

        badSha.ms = 0
        let first = try await installer.update()
        XCTAssertEqual(first, .installed(version: "2026-09-14-abc"))
        let second = try await installer.update()
        XCTAssertEqual(second, .upToDate(version: "2026-09-14-abc"))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path), ["usda-abc.sqlite"])
        XCTAssertEqual(try installer.installedLibrary()?.search("kale", limit: 1).first?.name, "Kale, raw")
        // One download for the rejected checksum, one for the install, none when already up to date.
        XCTAssertEqual(stub.requests.filter { $0.url!.path.hasPrefix("/api/usda/files/") }.count, 2)
    }

    /// A new server version atomically replaces the installed file (no delete-then-move window).
    func testInstallerAtomicallyReplacesAnExistingFileOnVersionChange() async throws {
        let firstSource = try temporaryDirectory().appendingPathComponent("first.sqlite").path
        try makeUsdaBundle(at: firstSource, version: "2026-09-01-a")
        let firstBytes = try Data(contentsOf: URL(fileURLWithPath: firstSource))
        let firstSha = SHA256.hash(data: firstBytes).map { String(format: "%02x", $0) }.joined()

        let secondSource = try temporaryDirectory().appendingPathComponent("second.sqlite").path
        try makeUsdaBundle(at: secondSource, version: "2026-09-14-b")
        let secondBytes = try Data(contentsOf: URL(fileURLWithPath: secondSource))
        let secondSha = SHA256.hash(data: secondBytes).map { String(format: "%02x", $0) }.joined()

        let clock = TestClock(0)
        let stub = StubTransport { request in
            switch request.url!.path {
            // Same sqlite_file name across versions (the server keeps a stable bundle filename),
            // so installing the second version must atomically replace the first, not delete-then-move.
            case "/api/usda/manifest" where clock.ms == 0:
                return (200, json(#"{"version":"2026-09-01-a","food_count":3,"portion_count":2,"sqlite_file":"usda.sqlite","sqlite_sha256":"\#(firstSha)","sqlite_url":"/api/usda/files/usda.sqlite","json_file":"usda.json.gz","json_sha256":"x","json_url":"/api/usda/files/usda.json.gz","created_at":"2026-09-01T00:00:00Z"}"#))
            case "/api/usda/manifest":
                return (200, json(#"{"version":"2026-09-14-b","food_count":3,"portion_count":2,"sqlite_file":"usda.sqlite","sqlite_sha256":"\#(secondSha)","sqlite_url":"/api/usda/files/usda.sqlite","json_file":"usda.json.gz","json_sha256":"x","json_url":"/api/usda/files/usda.json.gz","created_at":"2026-09-14T00:00:00Z"}"#))
            case "/api/usda/files/usda.sqlite":
                return (200, clock.ms == 0 ? firstBytes : secondBytes)
            default:
                return (404, json(#"{"error":"not_found","message":"no"}"#))
            }
        }
        let store = try LocalStore(path: nil, now: { 1_000 })
        let directory = try temporaryDirectory().appendingPathComponent("usda")
        let installer = UsdaInstaller(api: APIClient(baseURL: URL(string: "https://x.test")!, transport: stub, token: { "t" }),
                                      store: store, directory: directory)

        let first = try await installer.update()
        XCTAssertEqual(first, .installed(version: "2026-09-01-a"))
        clock.ms = 1
        let second = try await installer.update()
        XCTAssertEqual(second, .installed(version: "2026-09-14-b"))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path), ["usda.sqlite"])
        XCTAssertEqual(try installer.installedLibrary()?.version, "2026-09-14-b")
    }
}
