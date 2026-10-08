import Foundation
import Security
import os

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

    private let logger = Logger(subsystem: "com.pokoin.cardrails", category: "keychain")

    func save(_ token: String) {
        let data = Data(token.utf8)
        let query = baseQuery

        // Update in place when the item exists; add it otherwise. Removing and
        // re-adding (the old implementation) could silently lose the token.
        let status = SecItemUpdate(
            query as CFDictionary,
            [kSecValueData as String: data] as CFDictionary
        )

        switch status {
        case errSecSuccess:
            return
        case errSecItemNotFound:
            var attributes = query
            attributes[kSecValueData as String] = data
            attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            let addStatus = SecItemAdd(attributes as CFDictionary, nil)
            if addStatus != errSecSuccess {
                logger.error("keychain add failed: OSStatus \(addStatus, privacy: .public)")
            }
        default:
            logger.error("keychain update failed: OSStatus \(status, privacy: .public)")
        }
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
        let status = SecItemDelete(baseQuery as CFDictionary)
        if status != errSecSuccess, status != errSecItemNotFound {
            logger.error("keychain delete failed: OSStatus \(status, privacy: .public)")
        }
    }

    private var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.service,
            kSecAttrAccount as String: Self.account,
        ]
    }
}
