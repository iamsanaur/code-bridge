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
    /// What each subagent said and did, by the id of the Task/Agent tool call that started it.
    public private(set) var subagents: [String: [ChatItem]] = [:]
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
        case let .agentText(delta, parent):
            if let parent { Self.appendText(&subagents[parent, default: []], id: id, delta: delta) }
            else { Self.appendText(&chat, id: id, delta: delta) }
        case .turnEnd: closeStreaming()
        case let .toolCall(toolUseId, name, summary, parent):
            let item = ChatItem.tool(id: id, toolUseId: toolUseId, name: name, summary: summary, result: nil)
            if let parent {
                Self.closeStreaming(&subagents[parent, default: []])
                subagents[parent, default: []].append(item)
            } else {
                closeStreaming()
                chat.append(item)
            }
        case let .toolResult(toolUseId, ok, summary, parent):
            if let parent { Self.setResult(&subagents[parent, default: []], toolUseId: toolUseId, ok: ok, summary: summary) }
            else { Self.setResult(&chat, toolUseId: toolUseId, ok: ok, summary: summary) }
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

    private mutating func closeStreaming() { Self.closeStreaming(&chat) }

    private static func closeStreaming(_ items: inout [ChatItem]) {
        if case let .assistant(id, text, true)? = items.last {
            items[items.count - 1] = .assistant(id: id, text: text, streaming: false)
        }
    }

    private static func appendText(_ items: inout [ChatItem], id: String, delta: String) {
        if case let .assistant(aid, text, true)? = items.last {
            items[items.count - 1] = .assistant(id: aid, text: text + delta, streaming: true)
        } else {
            items.append(.assistant(id: id, text: delta, streaming: true))
        }
    }

    private static func setResult(_ items: inout [ChatItem], toolUseId: String, ok: Bool, summary: String) {
        if let idx = items.lastIndex(where: { if case let .tool(_, t, _, _, _) = $0 { t == toolUseId } else { false } }),
           case let .tool(tid, t, name, s, _) = items[idx] {
            items[idx] = .tool(id: tid, toolUseId: t, name: name, summary: s, result: ToolOutcome(ok: ok, summary: summary))
        }
    }
}
