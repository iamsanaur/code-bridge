import Foundation

// Swift mirror of packages/protocol (the TypeScript source of truth).
// Decoding ignores unknown fields so older apps keep working as the server grows.

public struct TokenPair: Codable, Equatable, Sendable {
    public var accessToken: String
    public var refreshToken: String
    public var accessExpiresAt: String
    public var refreshExpiresAt: String

    public init(accessToken: String, refreshToken: String, accessExpiresAt: String, refreshExpiresAt: String) {
        self.accessToken = accessToken
        self.refreshToken = refreshToken
        self.accessExpiresAt = accessExpiresAt
        self.refreshExpiresAt = refreshExpiresAt
    }
}

public struct User: Codable, Equatable, Sendable {
    public var id: String
    public var email: String
}

struct AuthResponse: Decodable { var user: User; var tokens: TokenPair }
struct RefreshResponse: Decodable { var tokens: TokenPair }

public enum SessionKind: String, Codable, Sendable { case local, cloud }

public enum SessionMode: String, Codable, Sendable, CaseIterable {
    case command, shell, agent
    case claudeCode = "claude_code"
    case managedAgent = "managed_agent"

    public var label: String {
        switch self {
        case .command: "Command"
        case .shell: "Shell"
        case .agent: "Coding agent"
        case .claudeCode: "Claude Code"
        case .managedAgent: "Cloud agent"
        }
    }

    public var isChat: Bool { self == .agent || self == .claudeCode || self == .managedAgent }
}

public enum StatusGroup: Sendable { case running, waiting, completed, failed }

public enum SessionStatus: String, Codable, Sendable {
    case starting, running, waiting, idle, completed, failed, killed, lost

    public var isTerminal: Bool { [.completed, .failed, .killed, .lost].contains(self) }

    public var group: StatusGroup {
        switch self {
        case .starting, .running: .running
        case .waiting, .idle: .waiting
        case .completed: .completed
        case .failed, .killed, .lost: .failed
        }
    }

    public var label: String {
        switch self {
        case .starting: "Starting"
        case .running: "Running"
        case .waiting: "Waiting for you"
        case .idle: "Waiting for prompt"
        case .completed: "Completed"
        case .failed: "Failed"
        case .killed: "Stopped"
        case .lost: "Lost (Mac restarted)"
        }
    }
}

public struct Usage: Codable, Equatable, Sendable {
    public var model: String
    public var inputTokens: Int
    public var outputTokens: Int
    public var cacheReadTokens: Int?
    public var cacheWriteTokens: Int?
    public var estimatedCostUsd: Double?
    public var source: String
}

public struct Capabilities: Codable, Equatable, Sendable {
    public var pty: Bool
    public var anthropicKeyConfigured: Bool
    public var claudeCodeAvailable: Bool
    public var allowCustomCommands: Bool
    public var allowInteractiveShell: Bool
    /// The owner allows creating new project folders from the phone. Older agents don't send it.
    public var canCreateWorkspaces: Bool?
}

public struct WorkspaceInfo: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var displayPath: String
    public var isGitRepo: Bool
}

public struct CreateWorkspaceResult: Codable, Equatable, Sendable {
    public var workspace: WorkspaceInfo
    /// False if git was requested but could not be initialised on the computer.
    public var gitInit: Bool
}

public struct PresetInfo: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var label: String
    public var argv: [String]
}

public struct Device: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var hostname: String?
    public var platform: String?
    public var agentVersion: String?
    public var online: Bool
    public var lastSeenAt: String?
    public var createdAt: String
    public var capabilities: Capabilities?
    public var workspaces: [WorkspaceInfo]
    public var presets: [PresetInfo]
}

struct DeviceList: Decodable { var devices: [Device] }

public struct CloudRef: Codable, Equatable, Sendable {
    public var providerSessionId: String?
    public var environmentId: String?
}

public struct Session: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var kind: SessionKind
    public var deviceId: String?
    public var deviceName: String?
    public var workspaceId: String?
    public var workspaceName: String?
    public var mode: SessionMode
    public var title: String
    public var status: SessionStatus
    public var exitCode: Int?
    public var usage: Usage?
    public var createdAt: String
    public var endedAt: String?
    public var cloud: CloudRef?
}

struct SessionList: Decodable { var sessions: [Session] }

public struct CreateLocalSession: Encodable, Sendable {
    public var workspaceId: String
    public var mode: SessionMode
    public var presetId: String?
    public var argv: [String]?
    public var confirmedRisk: Bool?
    public var prompt: String?

    public init(workspaceId: String, mode: SessionMode, presetId: String? = nil, argv: [String]? = nil, confirmedRisk: Bool? = nil, prompt: String? = nil) {
        self.workspaceId = workspaceId
        self.mode = mode
        self.presetId = presetId
        self.argv = argv
        self.confirmedRisk = confirmedRisk
        self.prompt = prompt
    }
}

public struct PairingClaim: Codable, Equatable, Sendable {
    public var pairingId: String
    public var deviceName: String
    public var hostname: String?
    public var platform: String?
    public var expiresAt: String
}

public struct GitFile: Codable, Equatable, Identifiable, Sendable {
    public var path: String
    public var index: String
    public var worktree: String
    public var id: String { path }
}

public struct GitStatus: Codable, Equatable, Sendable {
    public var branch: String?
    public var ahead: Int?
    public var behind: Int?
    public var files: [GitFile]
    public var truncated: Bool
}

public struct GitDiff: Codable, Equatable, Sendable {
    public var diff: String
    public var truncated: Bool
}

public struct CredentialStatus: Codable, Equatable, Sendable {
    public var configured: Bool
    public var hint: String?
    public var createdAt: String?
    public var storageAvailable: Bool
}

public struct CloudResources: Codable, Equatable, Sendable {
    public var agentId: String
    public var environmentId: String
}

public struct CloudConfig: Codable, Equatable, Sendable {
    public var enabled: Bool
    public var keyConfigured: Bool
    public var model: String
    public var networking: String
    public var allowedHosts: [String]
    public var budgetCents: Int
    public var maxConcurrent: Int
    public var resources: CloudResources?
    public var availableModels: [String]
    public var billing: String
    public var sandbox: String
}

public struct UsageTotals: Codable, Equatable, Sendable {
    public var inputTokens: Int
    public var outputTokens: Int
    public var estimatedCostUsd: Double
    public var sessions: Int
}

public struct UsageSummary: Codable, Equatable, Sendable {
    public var periodDays: Int
    public var totals: [String: UsageTotals]
    public var sessionsWithUnknownCost: Int
}

public struct CommandError: Codable, Equatable, Sendable {
    public var code: String
    public var message: String
}

// MARK: - Session events

public enum SessionEvent: Equatable, Sendable {
    case status(SessionStatus, exitCode: Int?, message: String?)
    case output(stream: String, data: String)
    case userPrompt(String)
    case agentText(String)
    case turnEnd(stopReason: String)
    case toolCall(toolUseId: String, name: String, summary: String)
    case toolResult(toolUseId: String, ok: Bool, summary: String)
    case approvalRequest(PendingApproval)
    case approvalResolved(approvalId: String, decision: String)
    case usage(Usage)
    case error(code: String, message: String, retryable: Bool)
}

public struct PendingApproval: Codable, Equatable, Identifiable, Sendable {
    public var approvalId: String
    public var toolName: String
    public var title: String
    public var detail: String
    public var risk: String
    public var expiresAt: String
    public var id: String { approvalId }
}

extension SessionEvent: Decodable {
    private enum K: String, CodingKey {
        case kind, status, exitCode, message, stream, data, text, delta, stopReason, toolUseId, name, summary, ok
        case approvalId, decision, usage, code, retryable
    }

    struct UnknownKind: Error {}

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        switch try c.decode(String.self, forKey: .kind) {
        case "status":
            self = .status(try c.decode(SessionStatus.self, forKey: .status), exitCode: try c.decodeIfPresent(Int.self, forKey: .exitCode), message: try c.decodeIfPresent(String.self, forKey: .message))
        case "output": self = .output(stream: try c.decode(String.self, forKey: .stream), data: try c.decode(String.self, forKey: .data))
        case "user.prompt": self = .userPrompt(try c.decode(String.self, forKey: .text))
        case "agent.text": self = .agentText(try c.decode(String.self, forKey: .delta))
        case "agent.turn_end": self = .turnEnd(stopReason: try c.decode(String.self, forKey: .stopReason))
        case "agent.tool_call":
            self = .toolCall(toolUseId: try c.decode(String.self, forKey: .toolUseId), name: try c.decode(String.self, forKey: .name), summary: try c.decode(String.self, forKey: .summary))
        case "agent.tool_result":
            self = .toolResult(toolUseId: try c.decode(String.self, forKey: .toolUseId), ok: try c.decode(Bool.self, forKey: .ok), summary: try c.decode(String.self, forKey: .summary))
        case "approval.request": self = .approvalRequest(try PendingApproval(from: decoder))
        case "approval.resolved": self = .approvalResolved(approvalId: try c.decode(String.self, forKey: .approvalId), decision: try c.decode(String.self, forKey: .decision))
        case "usage": self = .usage(try c.decode(Usage.self, forKey: .usage))
        case "error":
            self = .error(code: try c.decode(String.self, forKey: .code), message: try c.decode(String.self, forKey: .message), retryable: try c.decodeIfPresent(Bool.self, forKey: .retryable) ?? false)
        default: throw UnknownKind()
        }
    }
}

public struct SequencedEvent: Decodable, Equatable, Sendable {
    public var sessionId: String
    public var seq: Int
    public var ts: String
    public var event: SessionEvent

    public init(sessionId: String, seq: Int, ts: String = "", event: SessionEvent) {
        self.sessionId = sessionId
        self.seq = seq
        self.ts = ts
        self.event = event
    }
}
