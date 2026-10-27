import Foundation

public enum ChatItem: Identifiable, Equatable, Sendable {
    case user(id: String, text: String)
    case assistant(id: String, text: String, streaming: Bool)
    case tool(id: String, toolUseId: String, name: String, summary: String, result: ToolOutcome?)
    case failure(id: String, code: String, message: String, retryable: Bool)
    case notice(id: String, text: String)

    public var id: String {
        switch self {
        case let .user(id, _), let .assistant(id, _, _), let .tool(id, _, _, _, _), let .failure(id, _, _, _), let .notice(id, _): id
        }
    }
}

public struct ToolOutcome: Equatable, Sendable {
    public var ok: Bool
    public var summary: String
}

public enum ApplyResult: Sendable { case applied, duplicate, gap }

/// Client-side model of one session's stream. Events apply strictly in `seq`
/// order: duplicates are ignored, early arrivals buffered, gaps reported so the
/// caller can re-subscribe from the last contiguous event.
public struct SessionState: Sendable {
    public private(set) var lastSeq = 0
    public private(set) var status: SessionStatus?
    public private(set) var statusMessage: String?
    public private(set) var exitCode: Int?
    public private(set) var usage: Usage?
    public private(set) var terminal = TerminalBuffer(maxLines: 5000)
    public private(set) var chat: [ChatItem] = []
    public private(set) var approvals: [PendingApproval] = []
    public private(set) var revision = 0
    private var pending: [Int: SequencedEvent] = [:]

    public init() {}

    @discardableResult
    public mutating func apply(_ ev: SequencedEvent) -> ApplyResult {
        if ev.seq <= lastSeq { return .duplicate }
        if ev.seq > lastSeq + 1 {
            pending[ev.seq] = ev
            if pending.count > 2000 { pending.removeAll() }
            return .gap
        }
        applyOne(ev)
        drain()
        return .applied
    }

    /// The server says events before `seq` are gone everywhere: skip ahead.
    public mutating func resume(from seq: Int) {
        guard seq - 1 > lastSeq else { return }
        lastSeq = seq - 1
        terminal.write("\r\n\u{1B}[33m[earlier output is no longer available]\u{1B}[0m\r\n")
        revision += 1
        drain()
    }

    private mutating func drain() {
        while let next = pending.removeValue(forKey: lastSeq + 1) { applyOne(next) }
    }

    private mutating func applyOne(_ ev: SequencedEvent) {
        lastSeq = ev.seq
        revision += 1
        let id = String(ev.seq)
        switch ev.event {
        case let .status(s, exit, message):
            status = s
            statusMessage = message
            if let exit { exitCode = exit }
            if s != .running && s != .starting { closeStreaming() }
        case let .output(_, data): terminal.write(data)
        case let .userPrompt(text):
            closeStreaming()
            chat.append(.user(id: id, text: text))
        case let .agentText(delta):
            if case let .assistant(aid, text, true)? = chat.last {
                chat[chat.count - 1] = .assistant(id: aid, text: text + delta, streaming: true)
            } else {
                chat.append(.assistant(id: id, text: delta, streaming: true))
            }
        case .turnEnd: closeStreaming()
        case let .toolCall(toolUseId, name, summary):
            closeStreaming()
            chat.append(.tool(id: id, toolUseId: toolUseId, name: name, summary: summary, result: nil))
        case let .toolResult(toolUseId, ok, summary):
            if let idx = chat.lastIndex(where: { if case let .tool(_, t, _, _, _) = $0 { t == toolUseId } else { false } }),
               case let .tool(tid, t, name, s, _) = chat[idx] {
                chat[idx] = .tool(id: tid, toolUseId: t, name: name, summary: s, result: ToolOutcome(ok: ok, summary: summary))
            }
        case let .approvalRequest(a):
            approvals.removeAll { $0.approvalId == a.approvalId }
            approvals.append(a)
        case let .approvalResolved(approvalId, decision):
            approvals.removeAll { $0.approvalId == approvalId }
            if decision != "approved" { chat.append(.notice(id: id, text: "Approval \(decision)")) }
        case let .usage(u): usage = u
        case let .error(code, message, retryable):
            closeStreaming()
            chat.append(.failure(id: id, code: code, message: message, retryable: retryable))
            terminal.write("\r\n\u{1B}[31m[\(code)] \(message)\u{1B}[0m\r\n")
        }
    }

    private mutating func closeStreaming() {
        if case let .assistant(id, text, true)? = chat.last {
            chat[chat.count - 1] = .assistant(id: id, text: text, streaming: false)
        }
    }
}
