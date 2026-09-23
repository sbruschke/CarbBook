import CarbBookCore
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Why a webhook post did not land. Every case is something to show next to a saved log entry —
/// the entry is already stored by the time any of this runs, so none of it is ever fatal.
public enum WebhookError: Error, Equatable {
    /// The URL in settings is wrong, revoked or points at a deleted webhook (401/403/404).
    case badWebhook
    /// Any other non-2xx answer.
    case rejected(status: Int)
    /// Offline, timeout, DNS, TLS…
    case transport(String)
    /// The stored URL is not usable at all.
    case invalidUrl(String)

    public var message: String {
        switch self {
        case .badWebhook: "Not sent: the webhook URL is wrong or has been deleted."
        case let .rejected(status): "Not sent: the webhook answered \(status)."
        case let .transport(detail): "Could not reach the webhook: \(detail)."
        case let .invalidUrl(detail): detail
        }
    }
}

/// Posts a log entry's message to the user's webhook.
///
/// Discord's incoming-webhook endpoint is what this was built for, but the payload (`{ content }`)
/// is plain enough that any endpoint accepting it works. The URL never reaches the CarbBook server:
/// the device posts to the webhook directly.
public struct WebhookSender: Sendable {
    let transport: HTTPTransport
    let timeout: TimeInterval

    public init(transport: HTTPTransport = URLSessionTransport(), timeout: TimeInterval = 8) {
        self.transport = transport
        self.timeout = timeout
    }

    /// Throws `WebhookError`. Deliberately not a typed `throws(WebhookError)`: the app target
    /// builds in the Swift 5 language mode, where a `catch` clause still binds `any Error` and
    /// `error.message` does not compile. A plain `throws` behaves the same everywhere.
    public func send(_ content: String, to urlString: String) async throws {
        if let problem = webhookUrlProblem(urlString) { throw WebhookError.invalidUrl(problem) }
        guard let url = URL(string: urlString.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            throw WebhookError.invalidUrl("That is not a valid URL.")
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = timeout
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        // The webhook is a third party: never send CarbBook's cookies with it.
        request.httpShouldHandleCookies = false
        request.httpBody = try? JSONEncoder().encode(["content": content])

        let response: HTTPURLResponse
        do {
            (_, response) = try await transport.send(request)
        } catch {
            throw WebhookError.transport((error as? APIError).map(Self.detail) ?? error.localizedDescription)
        }
        guard (200..<300).contains(response.statusCode) else {
            throw [401, 403, 404].contains(response.statusCode)
                ? WebhookError.badWebhook
                : WebhookError.rejected(status: response.statusCode)
        }
    }

    private static func detail(_ error: APIError) -> String {
        if case let .transport(detail) = error { return detail }
        return String(describing: error)
    }
}

/// The breakdown lines for a log entry's items, matching what the web sends.
///
/// The logged snapshot is the source: `displayName` and `carbsG` are what was actually counted, so
/// the message says what the log says. Only the unit needs the catalog, to turn "p:abc" back into
/// "slice (30 g)".
public func webhookItemLines(for items: [LogItemData], catalog: Catalog) -> [WebhookItemLine] {
    items.map { item in
        WebhookItemLine(
            name: item.displayName,
            // A quick row's amount IS its carb figure, which the line already ends with; printing
            // "23 g carbs · 23 g carbs" would say the same thing twice.
            amount: item.refType == .quick
                ? ""
                : "\(JS.numberString(Double(JS.toFixed(item.amount, 2)) ?? item.amount)) "
                    + displayUnitName(item.unit, portions: catalog.portions(item.refId)),
            carbsG: item.carbsG)
    }
}
