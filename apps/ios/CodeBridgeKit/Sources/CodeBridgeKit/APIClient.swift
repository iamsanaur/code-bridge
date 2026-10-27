import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public struct APIError: Error, LocalizedError, Equatable, Sendable {
    public var status: Int
    public var code: String
    public var message: String
    public var isNetwork: Bool { status == 0 }
    public var errorDescription: String? { message }
    public init(status: Int, code: String, message: String) { self.status = status; self.code = code; self.message = message }
}

private struct ErrorBody: Decodable {
    var code: String?
    var message: String?
}

private struct Empty: Decodable {}

/// REST client with bearer auth and transparent token refresh. Concurrent 401s
/// share one in-flight refresh; a rejected refresh clears tokens and signs out.
public actor APIClient {
    public nonisolated let baseURL: URL
    private let store: TokenStore
    private let session: URLSession
    private var tokens: TokenPair?
    private var refreshTask: Task<Bool, Never>?
    private let now: @Sendable () -> Date
    private var signedOutHandler: (@Sendable () -> Void)?

    public init(baseURL: URL, store: TokenStore, session: URLSession = .shared, now: @escaping @Sendable () -> Date = Date.init) {
        self.baseURL = baseURL
        self.store = store
        self.session = session
        self.now = now
    }

    public func setSignedOutHandler(_ handler: @escaping @Sendable () -> Void) {
        signedOutHandler = handler
    }

    public var isSignedIn: Bool { tokens != nil }

    @discardableResult
    public func restore() async -> Bool {
        tokens = await store.load()
        return tokens != nil
    }

    public func setTokens(_ t: TokenPair) async {
        tokens = t
        await store.save(t)
    }

    public func clearTokens() async {
        tokens = nil
        await store.clear()
    }

    private static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static func parse(_ s: String) -> Date? {
        iso.date(from: s) ?? ISO8601DateFormatter().date(from: s)
    }

    /// A valid access token, refreshed first if it expires within 30 seconds.
    public func freshAccessToken() async -> String? {
        guard let t = tokens else { return nil }
        if let exp = Self.parse(t.accessExpiresAt), exp.addingTimeInterval(-30) < now() {
            _ = await refresh(stale: t.accessToken)
        }
        return tokens?.accessToken
    }

    private func refresh(stale: String?) async -> Bool {
        if let task = refreshTask { return await task.value }
        guard let current = tokens else { return false }
        if let stale, current.accessToken != stale { return true } // someone already refreshed
        let task = Task<Bool, Never> {
            do {
                let data = try await self.raw("POST", "/v1/auth/refresh", body: try JSONEncoder().encode(["refreshToken": current.refreshToken]), headers: [:], token: nil)
                let res = try JSONDecoder().decode(RefreshResponse.self, from: data)
                await self.setTokens(res.tokens)
                return true
            } catch let e as APIError where e.status == 401 {
                await self.clearTokens()
                await self.notifySignedOut()
                return false
            } catch {
                return false
            }
        }
        refreshTask = task
        let ok = await task.value
        refreshTask = nil
        return ok
    }

    private func notifySignedOut() { signedOutHandler?() }

    private func raw(_ method: String, _ path: String, body: Data?, headers: [String: String], token: String?) async throws -> Data {
        guard let url = URL(string: path, relativeTo: baseURL) else { throw APIError(status: 0, code: "bad_url", message: "Invalid URL") }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if body != nil || ["POST", "PUT", "PATCH"].contains(method) {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = body ?? Data("{}".utf8)
        }
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        headers.forEach { req.setValue($0.value, forHTTPHeaderField: $0.key) }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: req)
        } catch {
            throw APIError(status: 0, code: "network_error", message: "Cannot reach the CodeBridge server. Check your connection.")
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let err = try? JSONDecoder().decode(ErrorBody.self, from: data)
            throw APIError(status: status, code: err?.code ?? "http_error", message: err?.message ?? "Request failed (\(status))")
        }
        return data
    }

    public func request<T: Decodable>(_ method: String, _ path: String, body: Encodable? = nil, headers: [String: String] = [:], auth: Bool = true, as type: T.Type = T.self) async throws -> T {
        let encoded = try body.map { try JSONEncoder().encode($0) }
        let token = auth ? await freshAccessToken() : nil
        let data: Data
        do {
            data = try await raw(method, path, body: encoded, headers: headers, token: token)
        } catch let e as APIError where auth && e.status == 401 && tokens != nil {
            guard await refresh(stale: token) else { throw e }
            data = try await raw(method, path, body: encoded, headers: headers, token: tokens?.accessToken)
        }
        return try JSONDecoder().decode(T.self, from: data.isEmpty ? Data("{}".utf8) : data)
    }

    private func send(_ method: String, _ path: String, body: Encodable? = nil, idempotent: Bool = false) async throws {
        _ = try await request(method, path, body: body, headers: idempotent ? idem() : [:], as: Empty.self)
    }

    private func idem() -> [String: String] { ["Idempotency-Key": UUID().uuidString.lowercased()] }

    // MARK: Auth

    public func register(email: String, password: String) async throws -> User { try await authenticate("/v1/auth/register", email, password) }
    public func signIn(email: String, password: String) async throws -> User { try await authenticate("/v1/auth/login", email, password) }

    private func authenticate(_ path: String, _ email: String, _ password: String) async throws -> User {
        let res = try await request("POST", path, body: ["email": email, "password": password], auth: false, as: AuthResponse.self)
        await setTokens(res.tokens)
        return res.user
    }

    /// Personal relay: exchanges the owner secret from the QR code for session tokens. No account involved.
    public func connect(secret: String) async throws -> User {
        let res = try await request("POST", "/v1/auth/connect", body: ["secret": secret], auth: false, as: AuthResponse.self)
        await setTokens(res.tokens)
        return res.user
    }

    /// Checks that an address really is a personal CodeBridge relay before any secret is sent to it.
    public static func verifyPersonalRelay(at baseURL: URL, session: URLSession = .shared) async throws {
        struct Info: Decodable { let service: String; let mode: String }
        var req = URLRequest(url: baseURL.appending(path: "v1/relay/info"))
        req.timeoutInterval = 15
        let data: Data
        do { (data, _) = try await session.data(for: req) }
        catch { throw APIError(status: 0, code: "unreachable", message: "Couldn’t reach \(baseURL.host() ?? "the relay"). Is it running?") }
        guard let info = try? JSONDecoder().decode(Info.self, from: data), info.service == "codebridge-relay" else {
            throw APIError(status: 0, code: "not_a_relay", message: "That address isn’t a CodeBridge relay.")
        }
        guard info.mode == "personal" else {
            throw APIError(status: 0, code: "not_personal", message: "That relay uses email accounts. Use “Sign in to a shared relay” instead.")
        }
    }

    public func me() async throws -> User { try await request("GET", "/v1/me") }

    public func signOut() async {
        try? await send("POST", "/v1/auth/logout")
        await clearTokens()
    }

    public func deleteAccount(password: String) async throws {
        try await send("DELETE", "/v1/me", body: ["password": password])
        await clearTokens()
    }

    // MARK: Pairing & devices

    public func claimPairing(code: String) async throws -> PairingClaim { try await request("POST", "/v1/pairing/claim", body: ["code": code]) }
    public func decidePairing(id: String, approve: Bool) async throws { try await send("POST", "/v1/pairing/\(id)/\(approve ? "approve" : "deny")") }
    public func devices() async throws -> [Device] { try await request("GET", "/v1/devices", as: DeviceList.self).devices }
    public func device(_ id: String) async throws -> Device { try await request("GET", "/v1/devices/\(id)") }
    public func renameDevice(_ id: String, name: String) async throws { try await send("PATCH", "/v1/devices/\(id)", body: ["name": name]) }
    public func revokeDevice(_ id: String) async throws { try await send("DELETE", "/v1/devices/\(id)") }

    // MARK: Sessions

    public func sessions(kind: SessionKind? = nil, active: Bool? = nil) async throws -> [Session] {
        var q: [String] = []
        if let kind { q.append("kind=\(kind.rawValue)") }
        if let active { q.append("active=\(active)") }
        return try await request("GET", "/v1/sessions" + (q.isEmpty ? "" : "?" + q.joined(separator: "&")), as: SessionList.self).sessions
    }

    public func session(_ id: String) async throws -> Session { try await request("GET", "/v1/sessions/\(id)") }

    /// One idempotency key per user action, so a retried request never starts a second session.
    public func createLocalSession(deviceId: String, _ body: CreateLocalSession) async throws -> Session {
        try await request("POST", "/v1/devices/\(deviceId)/sessions", body: body, headers: idem())
    }

    /// Starts a new project on the computer: a brand-new folder with this name inside the owner's projects folder.
    /// Only a name is sent, never a path, and the computer refuses names that already exist.
    public func createWorkspace(deviceId: String, name: String, gitInit: Bool) async throws -> CreateWorkspaceResult {
        struct Body: Encodable { let name: String; let gitInit: Bool }
        return try await request("POST", "/v1/devices/\(deviceId)/workspaces", body: Body(name: name, gitInit: gitInit), headers: idem())
    }

    public func signal(_ id: String, terminate: Bool) async throws {
        try await send("POST", "/v1/sessions/\(id)/signal", body: ["signal": terminate ? "terminate" : "interrupt"], idempotent: true)
    }

    public func prompt(_ id: String, text: String) async throws {
        try await send("POST", "/v1/sessions/\(id)/prompt", body: ["text": text], idempotent: true)
    }

    public func decideApproval(_ id: String, approvalId: String, approve: Bool) async throws {
        try await send("POST", "/v1/sessions/\(id)/approvals/\(approvalId)", body: ["decision": approve ? "approve" : "reject"], idempotent: true)
    }

    public func gitStatus(deviceId: String, workspaceId: String) async throws -> GitStatus {
        try await request("GET", "/v1/devices/\(deviceId)/workspaces/\(workspaceId)/git/status")
    }

    public func gitDiff(deviceId: String, workspaceId: String, path: String) async throws -> GitDiff {
        let q = path.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? path
        return try await request("GET", "/v1/devices/\(deviceId)/workspaces/\(workspaceId)/git/diff?path=\(q)")
    }

    public func usage() async throws -> UsageSummary { try await request("GET", "/v1/usage") }

    // MARK: Credentials & cloud

    public func cloudCredential() async throws -> CredentialStatus { try await request("GET", "/v1/credentials/anthropic") }

    /// Sent once over TLS; the server stores it encrypted and never returns it.
    public func saveCloudKey(_ key: String) async throws { try await send("PUT", "/v1/credentials/anthropic", body: ["apiKey": key]) }
    public func deleteCloudKey() async throws { try await send("DELETE", "/v1/credentials/anthropic") }
    public func cloudConfig() async throws -> CloudConfig { try await request("GET", "/v1/cloud/config") }

    private struct CloudConfigUpdate: Encodable {
        var model: String
        var networking: String
        var allowedHosts: [String]
        var budgetCents: Int
    }

    public func updateCloudConfig(model: String, unrestricted: Bool, allowedHosts: [String], budgetCents: Int) async throws {
        try await send("PUT", "/v1/cloud/config", body: CloudConfigUpdate(model: model, networking: unrestricted ? "unrestricted" : "limited", allowedHosts: allowedHosts, budgetCents: budgetCents))
    }

    public func createCloudSession(prompt: String) async throws -> Session {
        try await request("POST", "/v1/cloud/sessions", body: ["prompt": prompt], headers: idem())
    }

    public func endCloudSession(_ id: String) async throws { try await send("POST", "/v1/cloud/sessions/\(id)/end") }
}
