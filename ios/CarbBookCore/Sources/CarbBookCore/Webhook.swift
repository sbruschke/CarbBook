import Foundation

/// Discord refuses a message whose `content` is longer than this.
public let discordContentLimit = 2000

/// One line of the breakdown — the mirror of the TS core's `WebhookItemLine`.
public struct WebhookItemLine: Equatable, Sendable {
    /// The item's logged display name.
    public var name: String
    /// The amount with its unit, already formatted, e.g. "1 cup". Empty when there is nothing worth
    /// saying — a quick-carbs row's amount is its carb figure, which the line already ends with.
    public var amount: String
    /// Carbs for this item in grams; non-finite means the snapshot is missing.
    public var carbsG: Double

    public init(name: String, amount: String, carbsG: Double) {
        self.name = name
        self.amount = amount
        self.carbsG = carbsG
    }
}

/// Trailing zeros are noise: 24 not 24.0. Mirrors Accountability.swift's `number`.
private func grams(_ value: Double) -> String {
    JS.numberString(Double(JS.toFixed(value, 1)) ?? value)
}

private func itemLine(_ item: WebhookItemLine) -> String {
    let amount = item.amount.trimmingCharacters(in: .whitespacesAndNewlines)
    let carbs = item.carbsG.isFinite ? "\(grams(item.carbsG)) g carbs" : nil
    let tail = [amount, carbs].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    return tail.isEmpty ? "• \(item.name)" : "• \(item.name) — \(tail)"
}

/// The webhook message for one log entry: the accountability sentence, then what the entry was made
/// of. Identical to the TS core's `webhookMessage` (shared vectors: `testdata/webhook-vectors.json`).
///
/// The sentence always survives: if the breakdown would push the message past `limit`, item lines
/// are dropped from the end and replaced with a count, rather than the message being cut mid-word
/// or the post being refused by Discord.
public func webhookMessage(
    _ input: AccountabilityInput, items: [WebhookItemLine], limit: Int = discordContentLimit
) -> String {
    let sentence = accountabilityText(input)
    if items.isEmpty { return sentence }

    let lines = items.map(itemLine)
    func build(_ kept: ArraySlice<String>, dropped: Int) -> String {
        let shown = dropped > 0 ? Array(kept) + ["• …and \(dropped) more"] : Array(kept)
        return "\(sentence)\n\nIn it:\n\(shown.joined(separator: "\n"))"
    }

    var kept = lines[...]
    var message = build(kept, dropped: 0)
    while message.count > limit, kept.count > 1 {
        kept = kept.dropLast()
        message = build(kept, dropped: lines.count - kept.count)
    }
    // Not even one line fits: the sentence alone is the most that can be said. A breakdown that is
    // nothing but "…and 3 more" would take up room to say less than nothing.
    return message.count > limit ? sentence : message
}

private let discordHosts: Set<String> = ["discord.com", "discordapp.com", "ptb.discord.com", "canary.discord.com"]

/// scheme, host and path of an absolute URL, or nil when it is not one.
///
/// Hand-rolled rather than `URL(string:)`, exactly as the TS core hand-rolls it rather than using
/// `new URL()`: Foundation's parser is far more forgiving (it takes "not a url" as a relative path)
/// and core's whole point is that both languages answer the same. The shapes that matter here are
/// narrow — an absolute https URL with a host.
private func urlParts(_ url: String) -> (scheme: String, host: String, path: String)? {
    let pattern = #"^([A-Za-z][A-Za-z0-9+.-]*)://([^/?#]*)([^?#]*)"#
    guard let regex = try? NSRegularExpression(pattern: pattern),
          let match = regex.firstMatch(in: url, range: NSRange(url.startIndex..., in: url))
    else { return nil }
    func group(_ index: Int) -> String {
        Range(match.range(at: index), in: url).map { String(url[$0]) } ?? ""
    }
    // Strip any userinfo and port; whitespace anywhere in the authority means it is not a URL.
    let authority = group(2)
    if authority.rangeOfCharacter(from: .whitespacesAndNewlines) != nil { return nil }
    let afterUserInfo = authority.contains("@") ? String(authority[authority.index(after: authority.lastIndex(of: "@")!)...]) : authority
    let host = afterUserInfo.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? ""
    return (group(1).lowercased(), host.lowercased(), group(3))
}

/// True for a Discord webhook endpoint. Only a hint for the UI — any https URL is accepted.
public func isDiscordWebhookUrl(_ url: String) -> Bool {
    guard let parsed = urlParts(url.trimmingCharacters(in: .whitespacesAndNewlines)),
          parsed.scheme == "https", discordHosts.contains(parsed.host)
    else { return false }
    return parsed.path.range(of: #"^/api(/v\d+)?/webhooks/\d+/[\w-]+/?$"#, options: .regularExpression) != nil
}

/// Why this URL cannot be used as a webhook, or nil when it can. https only: the URL is a bearer
/// secret in its own right — anyone holding it can post as you — so it must never travel in clear.
public func webhookUrlProblem(_ url: String) -> String? {
    let trimmed = url.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty { return "Enter a webhook URL." }
    guard let parsed = urlParts(trimmed), !parsed.host.isEmpty else { return "That is not a valid URL." }
    if parsed.scheme == "https" { return nil }
    // An http URL is a real address that is simply refused; anything else (ftp:, javascript:) is not
    // a webhook address at all.
    return parsed.scheme == "http" ? "The webhook URL must start with https://." : "That is not a valid URL."
}
