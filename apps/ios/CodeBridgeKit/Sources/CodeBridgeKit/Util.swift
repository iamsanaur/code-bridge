import Foundation

public let pairingAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

/// Normalises a typed pairing code ("abcd-efgh" -> "ABCDEFGH"); nil if invalid.
public func normalizePairingCode(_ input: String) -> String? {
    let c = input.uppercased().filter { $0.isLetter || $0.isNumber }
    guard c.count == 8, c.allSatisfy({ pairingAlphabet.contains($0) }) else { return nil }
    return c
}

/// Extracts the code from a scanned `codebridge://pair?code=…` link; rejects anything else.
public func codeFromQR(_ text: String) -> String? {
    guard let comps = URLComponents(string: text), comps.scheme == "codebridge", comps.host == "pair",
          let code = comps.queryItems?.first(where: { $0.name == "code" })?.value else { return nil }
    return normalizePairingCode(code)
}

/// Splits a command line into argv without a shell: quotes group words; no globbing, pipes or expansion.
public func splitArgs(_ line: String) -> [String] {
    var out: [String] = []
    var cur = ""
    var quote: Character?
    var has = false
    for ch in line {
        if let q = quote {
            if ch == q { quote = nil } else { cur.append(ch) }
        } else if ch == "\"" || ch == "'" {
            quote = ch
            has = true
        } else if ch.isWhitespace {
            if !cur.isEmpty || has { out.append(cur) }
            cur = ""
            has = false
        } else {
            cur.append(ch)
        }
    }
    if !cur.isEmpty || has { out.append(cur) }
    return out
}

public func timeAgo(_ iso: String?, now: Date = Date()) -> String {
    guard let iso else { return "never" }
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    guard let d = f.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) else { return "—" }
    let s = Swift.max(0, Int(now.timeIntervalSince(d)))
    switch s {
    case ..<10: return "just now"
    case ..<60: return "\(s)s ago"
    case ..<3600: return "\(Int((Double(s) / 60).rounded()))m ago"
    case ..<(48 * 3600): return "\(Int((Double(s) / 3600).rounded()))h ago"
    default: return "\(Int((Double(s) / 86400).rounded()))d ago"
    }
}

public func formatUSD(_ v: Double?) -> String {
    guard let v else { return "—" }
    return v < 0.01 ? String(format: "$%.4f", v) : String(format: "$%.2f", v)
}

public func formatTokens(_ n: Int) -> String {
    switch n {
    case ..<1000: return "\(n)"
    case ..<1_000_000: return String(format: "%.1fk", Double(n) / 1000)
    default: return String(format: "%.2fM", Double(n) / 1_000_000)
    }
}

// MARK: Personal relay links

/// What `codebridge-relay` puts in its QR code: `codebridge://connect?server=<url>&secret=<owner secret>`.
/// It carries the owner secret, so it is treated like a password and never logged.
public struct ConnectLink: Equatable, Sendable {
    public let server: URL
    public let secret: String
    public init(server: URL, secret: String) { self.server = server; self.secret = secret }

    /// The host shown to the user before connecting.
    public var host: String { server.host() ?? server.absoluteString }
}

/// Parses a scanned or pasted connect link. Rejects other schemes, missing parts and
/// servers that are neither `https` nor local (plain `http` is only allowed on this network).
public func parseConnectLink(_ text: String) -> ConnectLink? {
    guard let comps = URLComponents(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
          comps.scheme == "codebridge", comps.host == "connect",
          let server = comps.queryItems?.first(where: { $0.name == "server" })?.value,
          let secret = comps.queryItems?.first(where: { $0.name == "secret" })?.value,
          !secret.isEmpty, let url = URL(string: server.hasSuffix("/") ? String(server.dropLast()) : server),
          let host = url.host(), url.scheme == "https" || (url.scheme == "http" && isLocalHost(host))
    else { return nil }
    return ConnectLink(server: url, secret: secret)
}

public func makeConnectLink(server: URL, secret: String) -> String {
    var allowed = CharacterSet.alphanumerics
    allowed.insert(charactersIn: "-._~")
    let s = server.absoluteString.addingPercentEncoding(withAllowedCharacters: allowed) ?? ""
    let k = secret.addingPercentEncoding(withAllowedCharacters: allowed) ?? ""
    return "codebridge://connect?server=\(s)&secret=\(k)"
}

private func isLocalHost(_ host: String) -> Bool {
    host == "localhost" || host == "127.0.0.1" || host == "::1" || host.hasSuffix(".local")
}
