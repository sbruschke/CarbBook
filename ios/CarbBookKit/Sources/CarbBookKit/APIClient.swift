import CarbBookCore
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public protocol HTTPTransport: Sendable {
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

public struct URLSessionTransport: HTTPTransport {
    let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw APIError.transport("not an HTTP response") }
        return (data, http)
    }
}

public enum APIError: Error, Equatable {
    /// 401: token missing, revoked or unknown → sign in again (pending changes are kept).
    case unauthorized
    /// Non-2xx with the server's `{ error, message }` body.
    case server(status: Int, code: String, message: String)
    /// Offline, timeout, DNS, TLS…
    case transport(String)
    case decoding(String)
}

public struct ApiUser: Codable, Equatable, Sendable {
    public var id: Int
    public var username: String
    /// "owner" | "viewer"
    public var role: String
}

public struct LoginResponse: Codable, Equatable, Sendable {
    public var user: ApiUser
    public var token: String
    public var tokenId: String

    enum CodingKeys: String, CodingKey {
        case user, token
        case tokenId = "token_id"
    }
}

public struct TokenInfo: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var label: String?
    public var createdAt: Int64
    public var lastUsedAt: Int64

    enum CodingKeys: String, CodingKey {
        case id, label
        case createdAt = "created_at"
        case lastUsedAt = "last_used_at"
    }
}

/// `GET /api/bg`
public struct BgReading: Codable, Equatable, Sendable {
    public var mgdl: Double
    public var trend: String?
    public var arrow: String?
    public var deltaMgdl: Double?
    public var readAt: Int64
    public var ageMs: Int64
    public var fresh: Bool

    enum CodingKeys: String, CodingKey {
        case mgdl, trend, arrow, fresh
        case deltaMgdl = "delta_mgdl"
        case readAt = "read_at"
        case ageMs = "age_ms"
    }

    /// Whether the reading may prefill BG: the server's `fresh` flag and, on this device's clock,
    /// at most 15 minutes old and at most 2 minutes in the future (core `isBgReadingUsable`).
    /// A stale reading is shown but the user enters BG manually.
    public func isUsable(nowMs: Int64) -> Bool {
        fresh && isBgReadingUsable(readAtMs: readAt, nowMs: nowMs)
    }
}

public struct UsdaManifest: Codable, Equatable, Sendable {
    public var version: String
    public var foodCount: Int
    public var portionCount: Int
    public var sqliteFile: String
    public var sqliteSha256: String
    public var sqliteUrl: String

    enum CodingKeys: String, CodingKey {
        case version
        case foodCount = "food_count"
        case portionCount = "portion_count"
        case sqliteFile = "sqlite_file"
        case sqliteSha256 = "sqlite_sha256"
        case sqliteUrl = "sqlite_url"
    }
}

/// One image-search hit (server `images/providers/types.ts`). Nothing is stored until it is adopted,
/// so this type never reaches the database — only `POST /api/images/adopt` sees it.
public struct ImageCandidate: Codable, Equatable, Sendable, Identifiable {
    /// "openverse" | "wikimedia" | "themealdb" | "off"
    public var provider: String
    /// Small image for the picker grid, loaded straight from the provider.
    public var thumbUrl: String
    /// What `POST /api/images/adopt` fetches and stores.
    public var fullUrl: String
    /// The provider's own claim, shown pre-adopt only; stored dimensions come from the bytes.
    public var width: Int?
    /// See `width`.
    public var height: Int?
    public var license: String?
    public var attribution: String?
    public var title: String?

    /// Stable within one result set, which is all a `LazyVGrid` needs.
    public var id: String { "\(provider):\(fullUrl)" }

    public init(provider: String, thumbUrl: String, fullUrl: String, width: Int? = nil, height: Int? = nil,
                license: String? = nil, attribution: String? = nil, title: String? = nil) {
        self.provider = provider; self.thumbUrl = thumbUrl; self.fullUrl = fullUrl
        self.width = width; self.height = height
        self.license = license; self.attribution = attribution; self.title = title
    }

    enum CodingKeys: String, CodingKey {
        case provider, width, height, license, attribution, title
        case thumbUrl = "thumb_url"
        case fullUrl = "full_url"
    }
}

/// `GET /api/images/search`. `providersFailed` names the services that did not answer: the search
/// itself never fails because one provider did.
public struct ImageSearchResult: Codable, Equatable, Sendable {
    public var candidates: [ImageCandidate]
    public var providersFailed: [String]

    public init(candidates: [ImageCandidate] = [], providersFailed: [String] = []) {
        self.candidates = candidates
        self.providersFailed = providersFailed
    }

    enum CodingKeys: String, CodingKey {
        case candidates
        case providersFailed = "providers_failed"
    }
}

/// `GET /api/barcode/:code`. Foods and drafts may have nil carbs (Open Food Facts had no data):
/// that is "missing data", not an error.
public enum BarcodeLookup: Equatable, Sendable {
    case known(FoodData, [PortionData])
    /// `imageCandidate` is set only when Open Food Facts actually has a product photo.
    case draft(OffDraft, imageCandidate: ImageCandidate?)
    case notFound(code: String)
    case unavailable(code: String, message: String)
}

/// Bearer-token client for the CarbBook server (spec §7). Every body is JSON. The token itself is
/// supplied by the app (stored in the Keychain there).
public final class APIClient: @unchecked Sendable {
    public let baseURL: URL
    let transport: HTTPTransport
    let token: @Sendable () -> String?

    public init(baseURL: URL, transport: HTTPTransport = URLSessionTransport(), token: @escaping @Sendable () -> String?) {
        self.baseURL = baseURL
        self.transport = transport
        self.token = token
    }

    func makeRequest(_ method: String, _ path: String, query: [URLQueryItem] = [], body: Data? = nil) -> URLRequest {
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        components.path = path
        components.queryItems = query.isEmpty ? nil : query
        var request = URLRequest(url: components.url!)
        request.httpMethod = method
        request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token = token() {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if method != "GET" {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            // Fastify rejects an empty body with a JSON content type, so body-less mutations send {}.
            request.httpBody = body ?? Data("{}".utf8)
        }
        return request
    }

    func send(_ request: URLRequest) async throws -> Data {
        let data: Data
        let response: HTTPURLResponse
        do {
            (data, response) = try await transport.send(request)
        } catch let error as APIError {
            throw error
        } catch {
            throw APIError.transport(String(describing: error))
        }
        if response.statusCode == 401 { throw APIError.unauthorized }
        guard (200..<300).contains(response.statusCode) else {
            struct ErrorBody: Decodable { let error: String; let message: String }
            let body = try? JSONDecoder().decode(ErrorBody.self, from: data)
            throw APIError.server(status: response.statusCode, code: body?.error ?? "http_\(response.statusCode)",
                                  message: body?.message ?? HTTPURLResponse.localizedString(forStatusCode: response.statusCode))
        }
        return data
    }

    func decode<T: Decodable>(_ type: T.Type, _ data: Data) throws -> T {
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw APIError.decoding(String(describing: error))
        }
    }

    func json<T: Encodable>(_ value: T) -> Data {
        (try? JSONEncoder().encode(value)) ?? Data("{}".utf8)
    }

    public func login(username: String, password: String, deviceName: String) async throws -> LoginResponse {
        struct Body: Encodable { let username, password, client, device_name: String }
        let body = json(Body(username: username, password: password, client: "ios", device_name: String(deviceName.prefix(64))))
        return try decode(LoginResponse.self, try await send(makeRequest("POST", "/api/auth/login", body: body)))
    }

    public func me() async throws -> ApiUser {
        struct Body: Decodable { let user: ApiUser }
        return try decode(Body.self, try await send(makeRequest("GET", "/api/auth/me"))).user
    }

    public func logout() async throws {
        _ = try await send(makeRequest("POST", "/api/auth/logout"))
    }

    public func tokens() async throws -> [TokenInfo] {
        struct Body: Decodable { let tokens: [TokenInfo] }
        return try decode(Body.self, try await send(makeRequest("GET", "/api/auth/tokens"))).tokens
    }

    public func revokeToken(id: String) async throws {
        _ = try await send(makeRequest("DELETE", "/api/auth/tokens/\(id)"))
    }

    public func bg() async throws -> BgReading {
        try decode(BgReading.self, try await send(makeRequest("GET", "/api/bg")))
    }

    public func barcode(_ code: String) async throws -> BarcodeLookup {
        struct Body: Decodable {
            let status: String
            let food: FoodData?
            let portions: [PortionData]?
            let draft: OffDraft?
            let code: String?
            let message: String?
            let image_candidate: ImageCandidate?
        }
        let escaped = code.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? code
        let body = try decode(Body.self, try await send(makeRequest("GET", "/api/barcode/\(escaped)")))
        switch body.status {
        case "known":
            guard let food = body.food else { throw APIError.decoding("known barcode without food") }
            return .known(food, body.portions ?? [])
        case "draft":
            guard let draft = body.draft else { throw APIError.decoding("draft barcode without draft") }
            return .draft(draft, imageCandidate: body.image_candidate)
        case "not_found":
            return .notFound(code: body.code ?? code)
        default:
            return .unavailable(code: body.code ?? code, message: body.message ?? "Lookup unavailable")
        }
    }

    /// nil when the server has no USDA import yet (404 `usda_not_imported`).
    public func usdaManifest() async throws -> UsdaManifest? {
        do {
            return try decode(UsdaManifest.self, try await send(makeRequest("GET", "/api/usda/manifest")))
        } catch APIError.server(404, "usda_not_imported", _) {
            return nil
        }
    }

    /// JPEG bytes of `GET /api/images/:hash`. Content-addressed, so the response never changes and
    /// `ImageCache` keeps it on disk for good.
    public func imageBytes(hash: String) async throws -> Data {
        var request = makeRequest("GET", "/api/images/\(hash)")
        request.setValue("image/jpeg", forHTTPHeaderField: "Accept")
        return try await send(request)
    }

    /// Never throws: an unreachable search degrades the picker, it must not break the editor. A
    /// failure is reported the way the server reports a dead provider — a name in `providersFailed` —
    /// so the picker has only one thing to render.
    public func searchImages(query: String, limit: Int = 24) async -> ImageSearchResult {
        let request = makeRequest("GET", "/api/images/search",
                                  query: [URLQueryItem(name: "q", value: query), URLQueryItem(name: "limit", value: String(limit))])
        do {
            return try decode(ImageSearchResult.self, try await send(request))
        } catch {
            return ImageSearchResult(candidates: [], providersFailed: ["server"])
        }
    }

    /// Stores the candidate's bytes server-side and returns the `image` row. It does *not* attach the
    /// image to anything: the caller writes `food.image_id` / `meal.image_id` through the ordinary sync
    /// push, so that edit queues offline and resolves by last-write-wins like every other field.
    public func adoptImage(_ candidate: ImageCandidate) async throws -> ImageData {
        // The adopt schema rejects unknown and null properties, so only the keys it names are sent,
        // and nils are omitted rather than sent as null.
        var body: [String: String] = ["url": candidate.fullUrl, "source": candidate.provider]
        if let license = candidate.license { body["license"] = license }
        if let attribution = candidate.attribution { body["attribution"] = attribution }
        return try decode(ImageData.self, try await send(makeRequest("POST", "/api/images/adopt", body: json(body))))
    }

    /// Stores the user's own photo. Always JPEG: the server's libvips cannot decode HEVC-based HEIC.
    public func uploadImage(dataBase64: String) async throws -> ImageData {
        struct Body: Encodable { let data_base64: String; let mime: String }
        let body = json(Body(data_base64: dataBase64, mime: "image/jpeg"))
        return try decode(ImageData.self, try await send(makeRequest("POST", "/api/images/upload", body: body)))
    }

    /// Raw bytes of a server path such as a manifest's `sqlite_url`.
    public func download(path: String) async throws -> Data {
        var request = makeRequest("GET", path)
        request.setValue("application/vnd.sqlite3", forHTTPHeaderField: "Accept")
        request.timeoutInterval = 300
        return try await send(request)
    }
}

extension APIClient: SyncTransport {
    public func push(_ changes: [SyncChange]) async throws -> PushResponse {
        try decode(PushResponse.self, try await send(makeRequest("POST", "/api/sync/push", body: json(PushRequest(changes: changes)))))
    }

    public func pull(since: Int64, limit: Int) async throws -> PullResponse {
        let query = [URLQueryItem(name: "since", value: String(since)), URLQueryItem(name: "limit", value: String(limit))]
        return try decode(PullResponse.self, try await send(makeRequest("GET", "/api/sync/pull", query: query)))
    }
}
