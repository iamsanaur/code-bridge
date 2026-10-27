import Foundation
#if canImport(Security)
import Security
#endif

/// Persists CodeBridge session tokens. Only CodeBridge tokens are stored – never Anthropic API keys.
public protocol TokenStore: Sendable {
    func load() async -> TokenPair?
    func save(_ tokens: TokenPair) async
    func clear() async
}

public actor InMemoryTokenStore: TokenStore {
    private var tokens: TokenPair?
    public init(_ tokens: TokenPair? = nil) { self.tokens = tokens }
    public func load() -> TokenPair? { tokens }
    public func save(_ tokens: TokenPair) { self.tokens = tokens }
    public func clear() { tokens = nil }
}

#if canImport(Security)
/// iOS Keychain storage: `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`, so tokens are
/// excluded from backups and never migrate to another device.
public struct KeychainTokenStore: TokenStore {
    private let service = "dev.codebridge.app"
    private let account = "tokens.v1"

    public init() {}

    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }

    public func load() async -> TokenPair? {
        var q = query
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return try? JSONDecoder().decode(TokenPair.self, from: data)
    }

    public func save(_ tokens: TokenPair) async {
        guard let data = try? JSONEncoder().encode(tokens) else { return }
        let attrs: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        if SecItemUpdate(query as CFDictionary, attrs as CFDictionary) == errSecItemNotFound {
            var add = query
            attrs.forEach { add[$0.key] = $0.value }
            SecItemAdd(add as CFDictionary, nil)
        }
    }

    public func clear() async {
        SecItemDelete(query as CFDictionary)
    }
}
#endif
