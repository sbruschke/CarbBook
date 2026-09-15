import CarbBookCore
import Foundation

public enum BarcodeResolution: Equatable, Sendable {
    /// Already in the local database (works offline).
    case local(FoodData, [PortionData])
    /// Known to the server but not pulled yet; the caller should sync. Carbs may be nil (missing data).
    case known(FoodData, [PortionData])
    /// Open Food Facts draft for the user to confirm. Carbs may be nil (missing data, not an error).
    case draft(OffDraft)
    /// Nothing anywhere; offer manual entry prefilled with the code.
    case notFound(code: String)
    /// OFF failed or timed out; offer manual entry prefilled with the code.
    case unavailable(code: String, message: String)
    /// Offline and unknown locally; queued with a note to look up later (spec §6).
    case queuedOffline(code: String)
    /// Not a plausible barcode (not 6-14 digits); no request made, nothing queued.
    case invalid(code: String)
}

public struct BarcodeResolver: Sendable {
    let store: LocalStore
    let api: APIClient

    public init(store: LocalStore, api: APIClient) {
        self.store = store
        self.api = api
    }

    /// Throws only `APIError.unauthorized` (and database errors); network and server trouble queues the code.
    public func resolve(_ code: String) async throws -> BarcodeResolution {
        guard code.range(of: "^[0-9]{6,14}$", options: .regularExpression) != nil else {
            return .invalid(code: code)
        }
        if let hit = try store.foodForBarcode(code) { return .local(hit.food, hit.portions) }
        do {
            switch try await api.barcode(code) {
            case .known(let food, let portions): return .known(food, portions)
            case .draft(let draft): return .draft(draft)
            case .notFound(let code): return .notFound(code: code)
            case .unavailable(let code, let message):
                try store.queueBarcode(code, note: message)
                return .unavailable(code: code, message: message)
            }
        } catch APIError.transport {
            try store.queueBarcode(code, note: "Scanned offline; look up when back online")
            return .queuedOffline(code: code)
        } catch APIError.server(let status, _, let message) where status >= 500 {
            try store.queueBarcode(code, note: message)
            return .queuedOffline(code: code)
        }
    }
}
