import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import Observation

public enum ConnectionStatus: Sendable { case idle, connecting, connected, reconnecting, offline, unauthorized }

/// Messages from the relay to the app (`serverToClientSchema` in packages/protocol).
public enum ServerMessage: Equatable, Sendable {
    case authOk(userId: String)
    case event(SequencedEvent)
    case replayGap(sessionId: String, resumeFromSeq: Int)
    case commandAck(commandId: String, ok: Bool, error: CommandError?)
    case deviceStatus(deviceId: String, online: Bool, lastSeenAt: String?)
    case sessionStatus(sessionId: String, status: SessionStatus, exitCode: Int?)
    case error(code: String, message: String)
    case pong

    private struct Envelope: Decodable {
        var type: String
        var userId: String?
        var sessionId: String?
        var seq: Int?
        var ts: String?
        var resumeFromSeq: Int?
        var commandId: String?
        var ok: Bool?
        var error: CommandError?
        var deviceId: String?
        var online: Bool?
        var lastSeenAt: String?
        var status: SessionStatus?
        var exitCode: Int?
        var code: String?
        var message: String?
    }

    private struct EventEnvelope: Decodable { var event: SessionEvent }

    /// Parses one frame; returns nil for invalid or unknown frames (never throws).
    public static func parse(_ data: Data) -> ServerMessage? {
        let d = JSONDecoder()
        guard let e = try? d.decode(Envelope.self, from: data) else { return nil }
        switch e.type {
        case "auth.ok": return e.userId.map { .authOk(userId: $0) }
        case "event":
            guard let sid = e.sessionId, let seq = e.seq, let ev = try? d.decode(EventEnvelope.self, from: data) else { return nil }
            return .event(SequencedEvent(sessionId: sid, seq: seq, ts: e.ts ?? "", event: ev.event))
        case "replay.gap":
            guard let sid = e.sessionId, let r = e.resumeFromSeq else { return nil }
            return .replayGap(sessionId: sid, resumeFromSeq: r)
        case "command.ack":
            guard let id = e.commandId, let ok = e.ok else { return nil }
            return .commandAck(commandId: id, ok: ok, error: e.error)
        case "device.status":
            guard let id = e.deviceId, let online = e.online else { return nil }
            return .deviceStatus(deviceId: id, online: online, lastSeenAt: e.lastSeenAt)
        case "session.status":
            guard let id = e.sessionId, let status = e.status else { return nil }
            return .sessionStatus(sessionId: id, status: status, exitCode: e.exitCode)
        case "error":
            // `error` here is a string code, not the CommandError object, so read it from code/message.
            return .error(code: e.code ?? "error", message: e.message ?? "")
        case "pong": return .pong
        default: return nil
        }
    }
}

public enum TerminalCommand: Sendable {
    case input(sessionId: String, data: String)
    case resize(sessionId: String, cols: Int, rows: Int)
    case signal(sessionId: String, terminate: Bool)

    var json: [String: Any] {
        switch self {
        case let .input(id, data): ["op": "session.input", "sessionId": id, "data": data]
        case let .resize(id, cols, rows): ["op": "session.resize", "sessionId": id, "cols": cols, "rows": rows]
        case let .signal(id, terminate): ["op": "session.signal", "sessionId": id, "signal": terminate ? "terminate" : "interrupt"]
        }
    }
}

public struct CommandResult: Equatable, Sendable {
    public var ok: Bool
    public var error: CommandError?
}

/// Exponential backoff with full jitter.
public func backoffDelay(attempt: Int, base: Double = 0.5, max: Double = 15, random: () -> Double = { Double.random(in: 0..<1) }) -> Double {
    let cap = Swift.min(max, base * pow(2, Double(Swift.min(attempt, 16))))
    return random() * cap
}

/// One multiplexed WebSocket to the relay. Authenticates with the first frame (the
/// token never goes in the URL), reconnects with jittered backoff and re-subscribes
/// every session from the last event the app applied after each (re)connect.
@MainActor
@Observable
public final class RealtimeClient {
    public private(set) var status: ConnectionStatus = .idle

    @ObservationIgnored private let url: URL
    @ObservationIgnored private let tokenProvider: @Sendable () async -> String?
    @ObservationIgnored private let session: URLSession
    @ObservationIgnored private var task: URLSessionWebSocketTask?
    @ObservationIgnored private var authenticated = false
    @ObservationIgnored private var stopped = true
    @ObservationIgnored private var attempt = 0
    @ObservationIgnored private var reconnect: Task<Void, Never>?
    @ObservationIgnored private var pinger: Task<Void, Never>?
    @ObservationIgnored private var listeners: [UUID: (ServerMessage) -> Void] = [:]
    @ObservationIgnored private var subscriptions: [String: () -> Int] = [:]
    @ObservationIgnored private var acks: [String: CheckedContinuation<CommandResult, Never>] = [:]

    public init(url: URL, session: URLSession = .shared, tokenProvider: @escaping @Sendable () async -> String?) {
        self.url = url
        self.session = session
        self.tokenProvider = tokenProvider
    }

    /// Registers a listener; keep the returned token alive and call `cancel` to stop listening.
    public func listen(_ handler: @escaping (ServerMessage) -> Void) -> ListenerToken {
        let id = UUID()
        listeners[id] = handler
        return ListenerToken { [weak self] in
            Task { @MainActor in self?.listeners[id] = nil }
        }
    }

    /// Relay messages as an async sequence; the listener is removed when iteration ends.
    public func messages() -> AsyncStream<ServerMessage> {
        AsyncStream { continuation in
            let token = listen { continuation.yield($0) }
            continuation.onTermination = { _ in token.cancel() }
        }
    }

    public func start() {
        guard stopped else { return }
        stopped = false
        connect()
    }

    public func stop() {
        stopped = true
        reconnect?.cancel()
        pinger?.cancel()
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
        status = .idle
    }

    /// Reconnect immediately (e.g. the app returned to the foreground).
    public func nudge() {
        guard !stopped, status != .connected, status != .connecting else { return }
        reconnect?.cancel()
        attempt = 0
        connect()
    }

    private func connect() {
        guard !stopped else { return }
        status = attempt == 0 ? .connecting : .reconnecting
        Task {
            guard let token = await tokenProvider() else {
                status = .unauthorized
                return
            }
            let t = session.webSocketTask(with: url)
            task = t
            authenticated = false
            t.resume()
            send(["type": "auth", "token": token], on: t, requireAuth: false)
            receive(on: t)
        }
    }

    private func receive(on t: URLSessionWebSocketTask) {
        t.receive { [weak self] result in
            Task { @MainActor in
                guard let self, self.task === t else { return }
                switch result {
                case .success(let message):
                    let data: Data? = switch message {
                    case .string(let s): Data(s.utf8)
                    case .data(let d): d
                    @unknown default: nil
                    }
                    if let data, let msg = ServerMessage.parse(data) { self.handle(msg) }
                    self.receive(on: t)
                case .failure:
                    self.dropped(t, code: t.closeCode.rawValue)
                }
            }
        }
    }

    private func handle(_ msg: ServerMessage) {
        switch msg {
        case .authOk:
            authenticated = true
            attempt = 0
            status = .connected
            for (id, last) in subscriptions { sendSubscribe(id, afterSeq: last()) }
            pinger?.cancel()
            pinger = Task { [weak self] in
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(25))
                    self?.sendIfReady(["type": "ping", "ts": Int(Date().timeIntervalSince1970 * 1000)])
                }
            }
        case let .commandAck(id, ok, error):
            acks.removeValue(forKey: id)?.resume(returning: CommandResult(ok: ok, error: error))
        default: break
        }
        for l in listeners.values { l(msg) }
    }

    private func dropped(_ t: URLSessionWebSocketTask, code: Int) {
        guard task === t else { return }
        task = nil
        authenticated = false
        pinger?.cancel()
        for (_, c) in acks { c.resume(returning: CommandResult(ok: false, error: CommandError(code: "offline", message: "Connection lost"))) }
        acks.removeAll()
        guard !stopped else { return }
        if code == 4401 && attempt > 1 {
            status = .unauthorized
            return
        }
        status = .offline
        let delay = backoffDelay(attempt: attempt)
        attempt += 1
        reconnect = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled else { return }
            self?.connect()
        }
    }

    @discardableResult
    private func send(_ obj: [String: Any], on t: URLSessionWebSocketTask? = nil, requireAuth: Bool = true) -> Bool {
        guard let target = t ?? task, !requireAuth || authenticated,
              let data = try? JSONSerialization.data(withJSONObject: obj), let text = String(data: data, encoding: .utf8) else { return false }
        target.send(.string(text)) { _ in }
        return true
    }

    private func sendIfReady(_ obj: [String: Any]) { send(obj) }

    private func sendSubscribe(_ sessionId: String, afterSeq: Int) {
        send(["type": "subscribe", "sessionId": sessionId, "afterSeq": afterSeq])
    }

    /// Subscribes to live events for a session; `lastSeq` reports the last applied event.
    public func subscribe(_ sessionId: String, lastSeq: @escaping () -> Int) {
        subscriptions[sessionId] = lastSeq
        sendSubscribe(sessionId, afterSeq: lastSeq())
    }

    public func unsubscribe(_ sessionId: String) {
        subscriptions[sessionId] = nil
        send(["type": "unsubscribe", "sessionId": sessionId])
    }

    /// Re-requests events after `afterSeq` (gap recovery).
    public func resync(_ sessionId: String, afterSeq: Int) { sendSubscribe(sessionId, afterSeq: afterSeq) }

    public func command(_ cmd: TerminalCommand) async -> CommandResult {
        let id = UUID().uuidString.lowercased()
        guard authenticated, task != nil else { return CommandResult(ok: false, error: CommandError(code: "offline", message: "Not connected")) }
        return await withCheckedContinuation { (c: CheckedContinuation<CommandResult, Never>) in
            acks[id] = c
            guard send(["type": "command", "commandId": id, "command": cmd.json]) else {
                acks.removeValue(forKey: id)?.resume(returning: CommandResult(ok: false, error: CommandError(code: "offline", message: "Not connected")))
                return
            }
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(10))
                self?.acks.removeValue(forKey: id)?.resume(returning: CommandResult(ok: false, error: CommandError(code: "timeout", message: "No response from the Mac")))
            }
        }
    }
}

public final class ListenerToken {
    private let cancelAction: () -> Void
    init(_ cancel: @escaping () -> Void) { cancelAction = cancel }
    public func cancel() { cancelAction() }
    deinit { cancelAction() }
}
