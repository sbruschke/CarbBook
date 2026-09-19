import Foundation
@testable import CarbBookKit
import XCTest

final class ImageCacheTests: XCTestCase {
    private let imageHash = String(repeating: "a", count: 64)

    private func makeCache(fetch: @escaping (String) async throws -> Data) throws -> (ImageCache, URL) {
        let dir = try temporaryDirectory().appendingPathComponent("images")
        return (ImageCache(directory: dir, fetch: fetch), dir)
    }

    func testFetchesOnceThenServesFromDisk() async throws {
        let counter = Counter()
        let (cache, _) = try makeCache { _ in
            await counter.increment()
            return Data([0xFF, 0xD8, 0xFF, 0xE0])
        }
        let first = try await cache.fileURL(for: imageHash)
        let second = try await cache.fileURL(for: imageHash)
        XCTAssertEqual(first, second)
        let calls = await counter.value
        XCTAssertEqual(calls, 1)
        XCTAssertTrue(FileManager.default.fileExists(atPath: first.path))
    }

    func testRefetchesAfterEviction() async throws {
        let counter = Counter()
        let (cache, _) = try makeCache { _ in
            await counter.increment()
            return Data([0xFF, 0xD8, 0xFF, 0xE0])
        }
        let url = try await cache.fileURL(for: imageHash)
        // The OS can purge Caches at any time; a miss must refetch, not throw.
        try FileManager.default.removeItem(at: url)
        _ = try await cache.fileURL(for: imageHash)
        let calls = await counter.value
        XCTAssertEqual(calls, 2)
    }

    func testRejectsAMalformedHashWithoutFetching() async throws {
        let counter = Counter()
        let (cache, _) = try makeCache { _ in
            await counter.increment()
            return Data()
        }
        for bad in ["../../etc/passwd", String(repeating: "A", count: 64), "", "zz"] {
            do {
                _ = try await cache.fileURL(for: bad)
                XCTFail("expected a rejection for \(bad)")
            } catch {}
        }
        let calls = await counter.value
        XCTAssertEqual(calls, 0)
    }

    func testRecordsWhyAFetchFailed() async throws {
        // A thumbnail is silent when it cannot load, so the reason has to be readable somewhere or
        // a device we cannot attach to tells us nothing.
        let (cache, _) = try makeCache { _ in throw URLError(.notConnectedToInternet) }
        _ = try? await cache.fileURL(for: imageHash)
        let failures = await cache.failures
        let reason = await cache.lastFailure
        XCTAssertEqual(failures, 1)
        XCTAssertNotNil(reason)
        XCTAssertTrue(reason?.hasPrefix(String(imageHash.prefix(8))) == true, reason ?? "nil")
    }

    func testRecordsARejectedHashWithoutFetching() async throws {
        let (cache, _) = try makeCache { _ in Data([0xFF, 0xD8, 0xFF, 0xE0]) }
        _ = try? await cache.fileURL(for: "nope")
        let failures = await cache.failures
        XCTAssertEqual(failures, 1)
        let reason = await cache.lastFailure
        XCTAssertTrue(reason?.contains("not a hash") == true, reason ?? "nil")
    }

    func testTreatsAnEmptyBodyAsAFailureRatherThanCachingIt() async throws {
        // An empty file written to the content-addressed path would be served for ever.
        let (cache, _) = try makeCache { _ in Data() }
        do {
            _ = try await cache.fileURL(for: imageHash)
            XCTFail("expected a rejection")
        } catch {}
        let failures = await cache.failures
        XCTAssertEqual(failures, 1)
    }

    func testPropagatesAFetchFailure() async throws {
        let (cache, _) = try makeCache { _ in throw URLError(.notConnectedToInternet) }
        do {
            _ = try await cache.fileURL(for: imageHash)
            XCTFail("expected a rejection")
        } catch {}
    }

    func testCoalescesConcurrentRequestsForTheSameHash() async throws {
        // Two views appearing at once must not download the same image twice.
        let counter = Counter()
        let (cache, _) = try makeCache { _ in
            await counter.increment()
            try? await Task.sleep(nanoseconds: 20_000_000)
            return Data([0xFF, 0xD8, 0xFF, 0xE0])
        }
        async let a = cache.fileURL(for: imageHash)
        async let b = cache.fileURL(for: imageHash)
        _ = try await (a, b)
        let calls = await counter.value
        XCTAssertEqual(calls, 1)
    }
}

/// Minimal actor so a test's fetch counter is not a data race.
actor Counter {
    private(set) var value = 0
    func increment() { value += 1 }
}
