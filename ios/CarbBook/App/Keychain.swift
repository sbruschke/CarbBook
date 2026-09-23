import Foundation
import Security

/// Small secrets kept on this device: the bearer token from `POST /api/auth/login` (spec §7) and
/// the log webhook URL. Adapted from ChaosControl's KeychainService.
enum Keychain {
    private static let service = "dev.dxshdw.carbbook"
    private static let tokenAccount = "bearer_token"
    /// Where a log's accountability message is posted. A webhook URL is a bearer secret of its own
    /// — anyone holding it can post to that channel — so it lives here rather than in UserDefaults,
    /// and it is never synced to the server or to another device.
    static let webhookAccount = "log_webhook_url"

    enum KeychainError: Error {
        case saveFailed(OSStatus)
    }

    static func load(account: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func save(_ value: String, account: String) throws {
        delete(account: account)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecValueData as String: Data(value.utf8),
            // Background syncs after the first unlock still need the token.
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else { throw KeychainError.saveFailed(status) }
    }

    static func delete(account: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }

    static func loadToken() -> String? { load(account: tokenAccount) }
    static func saveToken(_ token: String) throws { try save(token, account: tokenAccount) }
    static func deleteToken() { delete(account: tokenAccount) }

    /// The webhook survives signing out: it belongs to the device, not to the session.
    static func loadWebhook() -> String? { load(account: webhookAccount) }
    static func saveWebhook(_ url: String) throws { try save(url, account: webhookAccount) }
    static func deleteWebhook() { delete(account: webhookAccount) }
}
