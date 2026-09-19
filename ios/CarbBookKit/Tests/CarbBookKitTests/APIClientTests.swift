import CarbBookCore
@testable import CarbBookKit
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest

/// Answers requests from a closure and records them.
final class StubTransport: HTTPTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [URLRequest] = []
    let handler: @Sendable (URLRequest) throws -> (Int, Data)

    init(_ handler: @escaping @Sendable (URLRequest) throws -> (Int, Data)) {
        self.handler = handler
    }

    var requests: [URLRequest] {
        lock.lock(); defer { lock.unlock() }; return recorded
    }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        lock.lock(); recorded.append(request); lock.unlock()
        let (status, data) = try handler(request)
        return (data, HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil)!)
    }
}

final class APIClientTests: XCTestCase {
    let base = URL(string: "https://recipes.dxshdw.dev")!

    private func bodyObject(_ request: URLRequest) throws -> [String: JSONValue] {
        guard case .object(let object) = try JSONDecoder().decode(JSONValue.self, from: XCTUnwrap(request.httpBody)) else {
            throw APIError.decoding("not an object")
        }
        return object
    }

    func testLoginPostsJSONForAnIOSClient() async throws {
        let stub = StubTransport { _ in (200, json(#"{"user":{"id":1,"username":"brett","role":"owner"},"token":"tok","token_id":"abc"}"#)) }
        let api = APIClient(baseURL: base, transport: stub, token: { nil })
        let response = try await api.login(username: "brett", password: "pw", deviceName: "Brett's iPhone")
        XCTAssertEqual(response.token, "tok")
        XCTAssertEqual(response.user.role, "owner")
        let request = try XCTUnwrap(stub.requests.first)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.absoluteString, "https://recipes.dxshdw.dev/api/auth/login")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
        XCTAssertEqual(try bodyObject(request), [
            "username": .string("brett"), "password": .string("pw"), "client": .string("ios"), "device_name": .string("Brett's iPhone"),
        ])
    }

    func testBearerTokenAndUnauthorized() async throws {
        let stub = StubTransport { _ in (401, json(#"{"error":"unauthorized","message":"Sign in required"}"#)) }
        let api = APIClient(baseURL: base, transport: stub, token: { "secret" })
        do {
            _ = try await api.me()
            XCTFail("expected unauthorized")
        } catch let error as APIError {
            XCTAssertEqual(error, .unauthorized)
        }
        XCTAssertEqual(stub.requests.first?.value(forHTTPHeaderField: "Authorization"), "Bearer secret")
    }

    func testServerAndTransportErrors() async throws {
        let unavailable = APIClient(baseURL: base, transport: StubTransport { _ in
            (503, json(#"{"error":"bg_unavailable","message":"dexcom-api responded 500"}"#))
        }, token: { "t" })
        do {
            _ = try await unavailable.bg()
            XCTFail("expected an error")
        } catch let error as APIError {
            XCTAssertEqual(error, .server(status: 503, code: "bg_unavailable", message: "dexcom-api responded 500"))
        }
        struct Offline: Error {}
        let offline = APIClient(baseURL: base, transport: StubTransport { _ in throw Offline() }, token: { "t" })
        do {
            _ = try await offline.bg()
            XCTFail("expected an error")
        } catch APIError.transport {}
    }

    /// `/api/bg`: a reading is auto-used only if at most 15 min old and at most 2 min in the future.
    func testBgReadingStaleness() async throws {
        let stub = StubTransport { _ in
            (200, json(#"{"mgdl":142,"trend":"Flat","arrow":"→","delta_mgdl":null,"read_at":1000000,"age_ms":0,"fresh":true}"#))
        }
        let reading = try await APIClient(baseURL: base, transport: stub, token: { "t" }).bg()
        XCTAssertEqual(reading.mgdl, 142)
        XCTAssertNil(reading.deltaMgdl)
        XCTAssertTrue(reading.isUsable(nowMs: 1_000_000))
        XCTAssertTrue(reading.isUsable(nowMs: 1_000_000 + 15 * 60_000))
        XCTAssertFalse(reading.isUsable(nowMs: 1_000_000 + 15 * 60_000 + 1)) // too old
        XCTAssertTrue(reading.isUsable(nowMs: 1_000_000 - 2 * 60_000))
        XCTAssertFalse(reading.isUsable(nowMs: 1_000_000 - 2 * 60_000 - 1)) // too far in the future
        var serverStale = reading
        serverStale.fresh = false
        XCTAssertFalse(serverStale.isUsable(nowMs: 1_000_000)) // server says stale by its clock
    }

    func testSyncEndpoints() async throws {
        let stub = StubTransport { request in
            request.httpMethod == "POST"
                ? (200, json(#"{"results":[{"table":"food","id":"f1","status":"accepted","server_seq":3}],"server_seq":3}"#))
                : (200, json(#"{"changes":[],"next_since":3,"has_more":false}"#))
        }
        let api = APIClient(baseURL: base, transport: stub, token: { "t" })
        let change = SyncChange(table: "food", record: ["id": .string("f1"), "name": .string("Rice")])
        let push = try await api.push([change])
        XCTAssertEqual(push.results.first?.serverSeq, 3)
        let pull = try await api.pull(since: 3, limit: 500)
        XCTAssertFalse(pull.hasMore)
        XCTAssertEqual(stub.requests[1].url?.absoluteString, "https://recipes.dxshdw.dev/api/sync/pull?since=3&limit=500")
        let pushBody = try bodyObject(stub.requests[0])
        XCTAssertEqual(pushBody["changes"], .array([.object(["table": .string("food"), "record": .object(change.record)])]))
    }

    /// A pushed dose_settings record with no round-down cutoff sends `"round_down_below_bg":null`.
    func testPushSendsExplicitNullRoundDownBelowBg() async throws {
        let store = try LocalStore(path: nil, now: { 1_000 })
        try store.save("dose_settings", DoseSettingsData(
            id: "s1", effectiveFrom: 0, windows: [DoseWindow(name: "All", start: "00:00", ratioGPerUnit: 10)],
            correction: CorrectionRule(threshold: 200, step: 50, unitsPerStep: 1, mode: "started"),
            rounding: RoundingRule(increment: 1, roundDownBelowBg: nil)))
        let stub = StubTransport { _ in
            (200, json(#"{"results":[{"table":"dose_settings","id":"s1","status":"accepted","server_seq":1}],"server_seq":1}"#))
        }
        let api = APIClient(baseURL: base, transport: stub, token: { "t" })
        _ = try await api.push(try await store.pendingChanges(limit: 500))
        let body = String(decoding: try XCTUnwrap(stub.requests.first?.httpBody), as: UTF8.self)
        XCTAssertTrue(body.contains(#""round_down_below_bg":null"#), body)
    }

    func testBarcodeStatusesManifestAndBodylessMutations() async throws {
        let stub = StubTransport { request in
            switch request.url!.path {
            case "/api/barcode/0737628064502":
                return (200, json(#"{"status":"draft","draft":{"food":{"name":"Granola","brand":null,"source":"off","source_ref":"0737628064502","carbs_per_100g":64,"fiber_per_100g":7},"portions":[],"barcode":"0737628064502","serving_size":null}}"#))
            case "/api/barcode/123456":
                return (200, json(#"{"status":"unavailable","code":"123456","message":"Open Food Facts timed out"}"#))
            case "/api/usda/manifest":
                return (404, json(#"{"error":"usda_not_imported","message":"Run `carbbook import-usda` on the server first"}"#))
            default:
                return (200, json(#"{"ok":true}"#))
            }
        }
        let api = APIClient(baseURL: base, transport: stub, token: { "t" })
        guard case .draft(let draft) = try await api.barcode("0737628064502") else { return XCTFail("expected a draft") }
        XCTAssertEqual(draft.food.carbsPer100g, 64)
        let unavailable = try await api.barcode("123456")
        XCTAssertEqual(unavailable, .unavailable(code: "123456", message: "Open Food Facts timed out"))
        let manifest = try await api.usdaManifest()
        XCTAssertNil(manifest)
        try await api.revokeToken(id: "abc")
        let revoke = try XCTUnwrap(stub.requests.last)
        XCTAssertEqual(revoke.httpMethod, "DELETE")
        XCTAssertEqual(revoke.httpBody, Data("{}".utf8))
        XCTAssertEqual(revoke.value(forHTTPHeaderField: "Content-Type"), "application/json")
    }

    /// Null carbs mean "data missing", not an error: both drafts and known foods decode with nil carbs.
    func testBarcodeResultsWithNullCarbsDecode() async throws {
        let stub = StubTransport { request in
            switch request.url!.path {
            case "/api/barcode/111111":
                return (200, json(#"{"status":"draft","draft":{"food":{"name":"Mystery bar","brand":null,"source":"off","source_ref":"111111","carbs_per_100g":null,"fiber_per_100g":null},"portions":[],"barcode":"111111","serving_size":null}}"#))
            default:
                return (200, json(#"{"status":"known","food":{"id":"f9","name":"Tea","brand":null,"source":"off","source_ref":"222222","derived_from":null,"carbs_per_100g":null,"fiber_per_100g":null,"density_g_per_ml":null,"notes":null,"updated_at":1,"updated_by":"web","deleted":0,"server_seq":4},"portions":[]}"#))
            }
        }
        let api = APIClient(baseURL: base, transport: stub, token: { "t" })
        guard case .draft(let draft) = try await api.barcode("111111") else { return XCTFail("expected a draft") }
        XCTAssertNil(draft.food.carbsPer100g)
        guard case .known(let food, let portions) = try await api.barcode("222222") else { return XCTFail("expected known") }
        XCTAssertEqual(food.id, "f9")
        XCTAssertNil(food.carbsPer100g)
        XCTAssertEqual(portions, [])
    }

    func testImageBytesGetsTheHashPathWithTheToken() async throws {
        let bytes = Data([0xFF, 0xD8, 0xFF, 0xE0])
        let stub = StubTransport { _ in (200, bytes) }
        let api = APIClient(baseURL: base, transport: stub, token: { "tok" })
        let hash = String(repeating: "a", count: 64)
        let fetched = try await api.imageBytes(hash: hash)
        XCTAssertEqual(fetched, bytes)
        XCTAssertEqual(stub.requests.first?.url?.path, "/api/images/\(hash)")
        XCTAssertEqual(stub.requests.first?.value(forHTTPHeaderField: "Authorization"), "Bearer tok")
    }
}
