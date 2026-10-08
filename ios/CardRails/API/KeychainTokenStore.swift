import Foundation
import Security

protocol TokenStoring: AnyObject {
    func save(_ token: String)
    func load() -> String?
    func clear()
}

/// Session token in the keychain: generic password,
/// `com.pokoin.cardrails` / `session`, readable after first unlock.
final class KeychainTokenStore: TokenStoring {
    static let service = "com.pokoin.cardrails"
    static let account = "session"

    func save(_ token: String) {
        let query = baseQuery
        SecItemDelete(query as CFDictionary)

        var attributes = query
        attributes[kSecValueData as String] = Data(token.utf8)
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(attributes as CFDictionary, nil)
    }

    func load() -> String? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard
            status == errSecSuccess,
            let data = result as? Data,
            let token = String(data: data, encoding: .utf8)
        else { return nil }
        return token
    }

    func clear() {
        SecItemDelete(baseQuery as CFDictionary)
    }

    private var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.service,
            kSecAttrAccount as String: Self.account,
        ]
    }
}
