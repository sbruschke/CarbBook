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
}
