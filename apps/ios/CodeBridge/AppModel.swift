import CodeBridgeKit
import Foundation
import Observation

/// App-wide state: the API client, the relay connection, and who is signed in.
@MainActor
@Observable
final class AppModel {
    let api: APIClient
    let realtime: RealtimeClient
    let apiURL: URL
    private(set) var user: User?
    private(set) var ready = false

    /// Set by a `codebridge://pair?code=…` link (e.g. scanned with the system Camera).
    var pendingPairCode: String?

    init() {
        let configured = Bundle.main.object(forInfoDictionaryKey: "CodeBridgeAPIURL") as? String
        apiURL = URL(string: configured ?? "http://localhost:8080")!
        api = APIClient(baseURL: apiURL, store: KeychainTokenStore())
        var ws = URLComponents(url: apiURL, resolvingAgainstBaseURL: false)!
        ws.scheme = apiURL.scheme == "https" ? "wss" : "ws"
        ws.path = "/v1/client/ws"
        let api = self.api
        realtime = RealtimeClient(url: ws.url!) { await api.freshAccessToken() }
    }

    var isInsecure: Bool { apiURL.scheme != "https" }

    func restore() async {
        await api.setSignedOutHandler { [weak self] in Task { @MainActor in self?.signedOutLocally() } }
        if await api.restore() {
            user = try? await api.me()
        }
        ready = true
        if user != nil { realtime.start() }
    }

    func signIn(email: String, password: String) async throws {
        user = try await api.signIn(email: email, password: password)
        realtime.start()
    }

    func register(email: String, password: String) async throws {
        user = try await api.register(email: email, password: password)
        realtime.start()
    }

    func signOut() async {
        await api.signOut()
        signedOutLocally()
    }

    func deleteAccount(password: String) async throws {
        try await api.deleteAccount(password: password)
        signedOutLocally()
    }

    func handle(url: URL) {
        if let code = codeFromQR(url.absoluteString) { pendingPairCode = code }
    }

    private func signedOutLocally() {
        realtime.stop()
        user = nil
    }
}
