import CarbBookCore
@testable import CarbBookKit
import Foundation
import XCTest

final class BarcodeResolverTests: XCTestCase {
    func testLocalHitThenServerThenOfflineQueue() async throws {
        struct Offline: Error {}
        let store = try LocalStore(path: nil, now: { 1_000 })
        try store.save("food", FoodData(id: "f1", name: "Granola", source: "off", carbsPer100g: 64))
        try store.save("barcode", BarcodeData(id: "b1", code: "0737628064502", foodId: "f1"))
        let offlineApi = APIClient(baseURL: URL(string: "https://x.test")!, transport: StubTransport { _ in throw Offline() }, token: { "t" })
        let resolver = BarcodeResolver(store: store, api: offlineApi)

        guard case .local(let food, _) = try await resolver.resolve("737628064502") else { return XCTFail("expected local") }
        XCTAssertEqual(food.id, "f1")
        let queued = try await resolver.resolve("4006381333931")
        XCTAssertEqual(queued, .queuedOffline(code: "4006381333931"))
        XCTAssertEqual(try store.queuedBarcodes().map(\.code), ["4006381333931"])

        let onlineApi = APIClient(baseURL: URL(string: "https://x.test")!, transport: StubTransport { _ in
            (200, json(#"{"status":"not_found","code":"4006381333931"}"#))
        }, token: { "t" })
        let notFound = try await BarcodeResolver(store: store, api: onlineApi).resolve("4006381333931")
        XCTAssertEqual(notFound, .notFound(code: "4006381333931"))
    }

    /// Null carbs are "missing data" (the user fills them in). `unavailable` is a result, not an
    /// error, but is also queued so it can be retried automatically.
    func testNullCarbDraftAndUnavailableAreResultsNotErrors() async throws {
        let store = try LocalStore(path: nil, now: { 1_000 })
        let api = APIClient(baseURL: URL(string: "https://x.test")!, transport: StubTransport { request in
            request.url!.path == "/api/barcode/111111"
                ? (200, json(#"{"status":"draft","draft":{"food":{"name":"Mystery bar","brand":null,"source":"off","source_ref":"111111","carbs_per_100g":null,"fiber_per_100g":null},"portions":[],"barcode":"111111","serving_size":null}}"#))
                : (200, json(#"{"status":"unavailable","code":"222222","message":"Open Food Facts timed out"}"#))
        }, token: { "t" })
        let resolver = BarcodeResolver(store: store, api: api)
        guard case .draft(let draft, _) = try await resolver.resolve("111111") else { return XCTFail("expected a draft") }
        XCTAssertNil(draft.food.carbsPer100g)
        let unavailable = try await resolver.resolve("222222")
        XCTAssertEqual(unavailable, .unavailable(code: "222222", message: "Open Food Facts timed out"))
        XCTAssertEqual(try store.queuedBarcodes().map(\.code), ["222222"])
    }

    /// A 5xx from the server is treated like being offline: queue and let the user retry later.
    func testServerErrorQueuesForRetry() async throws {
        let store = try LocalStore(path: nil, now: { 1_000 })
        let api = APIClient(baseURL: URL(string: "https://x.test")!, transport: StubTransport { _ in
            (503, json(#"{"error":"unavailable","message":"Database unreachable"}"#))
        }, token: { "t" })
        let result = try await BarcodeResolver(store: store, api: api).resolve("333333")
        XCTAssertEqual(result, .queuedOffline(code: "333333"))
        XCTAssertEqual(try store.queuedBarcodes().map(\.code), ["333333"])
    }

    /// Not a plausible barcode: no request, nothing queued.
    func testInvalidCodeIsRejectedWithoutARequestOrQueue() async throws {
        let store = try LocalStore(path: nil, now: { 1_000 })
        let stub = StubTransport { _ in (200, json(#"{"status":"not_found","code":"x"}"#)) }
        let api = APIClient(baseURL: URL(string: "https://x.test")!, transport: stub, token: { "t" })
        let result = try await BarcodeResolver(store: store, api: api).resolve("abc123")
        XCTAssertEqual(result, .invalid(code: "abc123"))
        XCTAssertEqual(stub.requests.count, 0)
        XCTAssertEqual(try store.queuedBarcodes().count, 0)

        let tooShort = try await BarcodeResolver(store: store, api: api).resolve("12345")
        XCTAssertEqual(tooShort, .invalid(code: "12345"))
        XCTAssertEqual(stub.requests.count, 0)
    }

    func testUnauthorizedIsThrownNotQueued() async throws {
        let store = try LocalStore(path: nil, now: { 1_000 })
        let api = APIClient(baseURL: URL(string: "https://x.test")!, transport: StubTransport { _ in
            (401, json(#"{"error":"unauthorized","message":"Sign in required"}"#))
        }, token: { "t" })
        do {
            _ = try await BarcodeResolver(store: store, api: api).resolve("123456")
            XCTFail("expected unauthorized")
        } catch APIError.unauthorized {}
        XCTAssertEqual(try store.queuedBarcodes().count, 0)
    }
}
