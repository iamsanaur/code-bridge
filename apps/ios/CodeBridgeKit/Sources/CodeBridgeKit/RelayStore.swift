import Foundation
#if canImport(Security)
import Security
#endif

/// The relay this phone is connected to and the secret that lets it sign in again.
/// The secret stays on this device (Keychain, never backed up) so an expired or lost session
/// reconnects silently instead of asking the user to scan again.
public struct RelayConnection: Codable, Equatable, Sendable {
    public let server: URL
    public let secret: String
    public init(server: URL, secret: String) { self.server = server; self.secret = secret }
}

public protocol RelayStore: Sendable {
    func load() async -> RelayConnection?
    func save(_ relay: RelayConnection) async
    func clear() async
}

public actor InMemoryRelayStore: RelayStore {
    private var relay: RelayConnection?
    public init(_ relay: RelayConnection? = nil) { self.relay = relay }
    public func load() -> RelayConnection? { relay }
    public func save(_ relay: RelayConnection) { self.relay = relay }
    public func clear() { relay = nil }
}

#if canImport(Security)
public struct KeychainRelayStore: RelayStore {
    private let service = "com.e404.codebridge"
    private let account = "relay.v1"

    public init() {}

    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }

    public func load() async -> RelayConnection? {
        var q = query
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return try? JSONDecoder().decode(RelayConnection.self, from: data)
    }

    public func save(_ relay: RelayConnection) async {
        guard let data = try? JSONEncoder().encode(relay) else { return }
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
