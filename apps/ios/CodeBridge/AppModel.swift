import CodeBridgeKit
import Foundation
import Observation

/// App-wide state: the API client, the relay connection, and who is signed in.
///
/// Personal relay (the normal case): the phone holds the owner secret from the QR code. There is no
/// account. A lost or expired session reconnects silently with that secret.
@MainActor
@Observable
final class AppModel {
    private(set) var api: APIClient
    private(set) var realtime: RealtimeClient
    private(set) var apiURL: URL
    private(set) var user: User?
    private(set) var ready = false
    /// Set once this phone is connected to a personal relay.
    private(set) var relay: RelayConnection?

    private let relayStore: RelayStore = KeychainRelayStore()
    private let defaultURL: URL

    /// Set by a `codebridge://pair?code=…` link (e.g. scanned with the system Camera).
    var pendingPairCode: String?
    /// A scanned or opened `codebridge://connect?…` link, waiting for the user to confirm the relay.
    var pendingConnect: ConnectLink?

    init() {
        let configured = Bundle.main.object(forInfoDictionaryKey: "CodeBridgeAPIURL") as? String
        defaultURL = URL(string: configured ?? "http://localhost:8080")!
        apiURL = defaultURL
        (api, realtime) = Self.makeClients(for: defaultURL)
    }

    private static func makeClients(for url: URL) -> (APIClient, RealtimeClient) {
        let api = APIClient(baseURL: url, store: KeychainTokenStore())
        var ws = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        ws.scheme = url.scheme == "https" ? "wss" : "ws"
        ws.path = "/v1/client/ws"
        return (api, RealtimeClient(url: ws.url!) { await api.freshAccessToken() })
    }

    private func use(server: URL) async {
        realtime.stop()
        apiURL = server
        (api, realtime) = Self.makeClients(for: server)
        await api.setSignedOutHandler { [weak self] in Task { @MainActor in await self?.sessionLost() } }
    }

    var isInsecure: Bool { apiURL.scheme != "https" }
    var isPersonal: Bool { relay != nil }

    /// The command that joins a computer to this relay. It contains the owner secret: show it only to the owner.
    var agentConnectCommand: String? {
        relay.map { "codebridge-agent connect '\(makeConnectLink(server: $0.server, secret: $0.secret))'" }
    }

    func restore() async {
        relay = await relayStore.load()
        await use(server: relay?.server ?? defaultURL)
        if await api.restore() { user = try? await api.me() }
        if user == nil, let relay { user = try? await api.connect(secret: relay.secret) }
        #if DEBUG
        // Test seam for simulator runs, where nobody can scan a QR code.
        if user == nil, let raw = ProcessInfo.processInfo.environment["CODEBRIDGE_AUTOCONNECT"], let link = parseConnectLink(raw) {
            try? await connect(link)
        }
        #endif
        ready = true
        if user != nil { realtime.start() }
    }

    /// Connects to the relay named in a link the user has confirmed.
    func connect(_ link: ConnectLink) async throws {
        try await APIClient.verifyPersonalRelay(at: link.server)
        await use(server: link.server)
        await api.clearTokens()
        user = try await api.connect(secret: link.secret)
        let connection = RelayConnection(server: link.server, secret: link.secret)
        await relayStore.save(connection)
        relay = connection
        realtime.start()
    }

    /// Forgets the relay and returns to the welcome screen.
    func disconnect() async {
        await api.signOut()
        await relayStore.clear()
        relay = nil
        user = nil
        realtime.stop()
        await use(server: defaultURL)
    }

    // Shared relay with email accounts.
    func signIn(email: String, password: String) async throws {
        user = try await api.signIn(email: email, password: password)
        realtime.start()
    }

    func register(email: String, password: String) async throws {
        user = try await api.register(email: email, password: password)
        realtime.start()
    }

    func signOut() async {
        if isPersonal { await disconnect(); return }
        await api.signOut()
        signedOutLocally()
    }

    func deleteAccount(password: String) async throws {
        try await api.deleteAccount(password: password)
        signedOutLocally()
    }

    /// Switches to another (shared) relay by address, before signing in with an email account.
    func useSharedRelay(_ address: String) async throws {
        guard let url = URL(string: address.trimmingCharacters(in: .whitespaces)), url.host() != nil,
              url.scheme == "https" || url.scheme == "http"
        else { throw APIError(status: 0, code: "bad_url", message: "Enter the relay address, like https://relay.example.com") }
        await use(server: url)
    }

    func handle(url: URL) {
        if let link = parseConnectLink(url.absoluteString) { pendingConnect = link }
        else if let code = codeFromQR(url.absoluteString) { pendingPairCode = code }
    }

    /// The session ended (refresh rejected, relay data wiped). A personal relay signs back in by itself.
    private func sessionLost() async {
        if let relay, (try? await api.connect(secret: relay.secret)) != nil { return }
        signedOutLocally()
    }

    private func signedOutLocally() {
        realtime.stop()
        user = nil
    }
}
