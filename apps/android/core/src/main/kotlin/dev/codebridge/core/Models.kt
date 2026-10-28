package dev.codebridge.core

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonClassDiscriminator

/**
 * Kotlin mirror of packages/protocol (the TypeScript source of truth). Field names
 * match the JSON on the wire; unknown fields are ignored so older apps keep working
 * when the server adds data.
 */
val ProtocolJson = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    encodeDefaults = true
    classDiscriminator = "type"
}

@Serializable
data class TokenPair(
    val accessToken: String,
    val refreshToken: String,
    val accessExpiresAt: String,
    val refreshExpiresAt: String,
)

@Serializable data class User(val id: String, val email: String)

@Serializable data class AuthResponse(val user: User, val tokens: TokenPair)

@Serializable data class RefreshResponse(val tokens: TokenPair)

@Serializable
enum class SessionKind { @SerialName("local") LOCAL, @SerialName("cloud") CLOUD }

@Serializable
enum class SessionMode {
    @SerialName("command") COMMAND,
    @SerialName("shell") SHELL,
    @SerialName("agent") AGENT,
    @SerialName("claude_code") CLAUDE_CODE,
    @SerialName("managed_agent") MANAGED_AGENT;

    val label: String
        get() = when (this) {
            COMMAND -> "Command"
            SHELL -> "Shell"
            AGENT -> "Coding agent"
            CLAUDE_CODE -> "Claude Code"
            MANAGED_AGENT -> "Cloud agent"
        }

    val isChat: Boolean get() = this == AGENT || this == CLAUDE_CODE || this == MANAGED_AGENT
}

@Serializable
enum class SessionStatus {
    @SerialName("starting") STARTING,
    @SerialName("running") RUNNING,
    @SerialName("waiting") WAITING,
    @SerialName("idle") IDLE,
    @SerialName("completed") COMPLETED,
    @SerialName("failed") FAILED,
    @SerialName("killed") KILLED,
    @SerialName("lost") LOST;

    val isTerminal: Boolean get() = this == COMPLETED || this == FAILED || this == KILLED || this == LOST

    /** The four groups the dashboard distinguishes. */
    val group: StatusGroup
        get() = when (this) {
            STARTING, RUNNING -> StatusGroup.RUNNING
            WAITING, IDLE -> StatusGroup.WAITING
            COMPLETED -> StatusGroup.COMPLETED
            FAILED, KILLED, LOST -> StatusGroup.FAILED
        }

    val label: String
        get() = when (this) {
            STARTING -> "Starting"
            RUNNING -> "Running"
            WAITING -> "Waiting for you"
            IDLE -> "Waiting for prompt"
            COMPLETED -> "Completed"
            FAILED -> "Failed"
            KILLED -> "Stopped"
            LOST -> "Lost (Mac restarted)"
        }
}

enum class StatusGroup { RUNNING, WAITING, COMPLETED, FAILED }

@Serializable
data class Usage(
    val model: String,
    val inputTokens: Long,
    val outputTokens: Long,
    val cacheReadTokens: Long = 0,
    val cacheWriteTokens: Long = 0,
    val estimatedCostUsd: Double? = null,
    val source: String,
)

@Serializable
data class Capabilities(
    val pty: Boolean,
    val anthropicKeyConfigured: Boolean,
    val claudeCodeAvailable: Boolean,
    val allowCustomCommands: Boolean,
    val allowInteractiveShell: Boolean,
    /** The owner allows creating new project folders from the phone. Older agents don't send it. */
    val canCreateWorkspaces: Boolean? = null,
    /** The owner allows picking existing folders from the phone. Older agents don't send it. */
    val canBrowseFolders: Boolean? = null,
    /** Where new projects are created, with the home folder shown as `~`. Older agents don't send it. */
    val projectsRoot: String? = null,
)

@Serializable data class WorkspaceInfo(val id: String, val name: String, val displayPath: String, val isGitRepo: Boolean)

@Serializable data class CreateWorkspaceResult(val workspace: WorkspaceInfo, val gitInit: Boolean)

@Serializable data class FolderEntry(val name: String, val path: String, val isGitRepo: Boolean)

@Serializable
data class BrowseFoldersResult(
    val displayPath: String,
    val path: String,
    val parentPath: String? = null,
    /** False for the home folder itself: pick a project inside it. */
    val canAdd: Boolean,
    val isGitRepo: Boolean,
    val folders: List<FolderEntry>,
    val truncated: Boolean,
)

@Serializable data class SetProjectsRootResult(val projectsRoot: String)

@Serializable data class AddWorkspaceResult(val workspace: WorkspaceInfo)

@Serializable data class PresetInfo(val id: String, val label: String, val argv: List<String>)

@Serializable
data class Device(
    val id: String,
    val name: String,
    val hostname: String? = null,
    val platform: String? = null,
    val agentVersion: String? = null,
    val online: Boolean,
    val lastSeenAt: String? = null,
    val createdAt: String,
    val capabilities: Capabilities? = null,
    val workspaces: List<WorkspaceInfo> = emptyList(),
    val presets: List<PresetInfo> = emptyList(),
)

@Serializable data class DeviceList(val devices: List<Device>)

@Serializable data class CloudRef(val providerSessionId: String? = null, val environmentId: String? = null)

@Serializable
data class Session(
    val id: String,
    val kind: SessionKind,
    val deviceId: String? = null,
    val deviceName: String? = null,
    val workspaceId: String? = null,
    val workspaceName: String? = null,
    val mode: SessionMode,
    val title: String,
    val status: SessionStatus,
    val exitCode: Int? = null,
    val usage: Usage? = null,
    val createdAt: String,
    val endedAt: String? = null,
    val cloud: CloudRef? = null,
)

@Serializable data class SessionList(val sessions: List<Session>)

@Serializable
data class CreateLocalSession(
    val workspaceId: String,
    val mode: SessionMode,
    val presetId: String? = null,
    val argv: List<String>? = null,
    val confirmedRisk: Boolean? = null,
    val prompt: String? = null,
    /** Continue a Claude Code conversation saved on the computer. */
    val resumeId: String? = null,
    val resumeAsCopy: Boolean? = null,
    val resumeTitle: String? = null,
    val cols: Int? = null,
    val rows: Int? = null,
)

/** A Claude Code conversation saved on the computer; [lastActiveAt] is ISO 8601. */
@Serializable data class SavedConversation(val id: String, val title: String, val lastActiveAt: String)

@Serializable data class SavedConversationList(val sessions: List<SavedConversation>)

@Serializable
data class PairingClaim(
    val pairingId: String,
    val deviceName: String,
    val hostname: String? = null,
    val platform: String? = null,
    val expiresAt: String,
)

@Serializable data class GitFile(val path: String, val index: String, val worktree: String)

@Serializable
data class GitStatus(val branch: String? = null, val ahead: Int? = null, val behind: Int? = null, val files: List<GitFile>, val truncated: Boolean)

@Serializable data class GitDiff(val diff: String, val truncated: Boolean)

@Serializable
data class CredentialStatus(val configured: Boolean, val hint: String? = null, val createdAt: String? = null, val storageAvailable: Boolean)

@Serializable data class CloudResources(val agentId: String, val environmentId: String)

@Serializable
data class CloudConfig(
    val enabled: Boolean,
    val keyConfigured: Boolean,
    val model: String,
    val networking: String,
    val allowedHosts: List<String>,
    val budgetCents: Int,
    val maxConcurrent: Int,
    val resources: CloudResources? = null,
    val availableModels: List<String> = emptyList(),
    val billing: String = "",
    val sandbox: String = "",
)

@Serializable data class UsageTotals(val inputTokens: Long, val outputTokens: Long, val estimatedCostUsd: Double, val sessions: Int)

@Serializable data class UsageSummary(val periodDays: Int, val totals: Map<String, UsageTotals>, val sessionsWithUnknownCost: Int)

@Serializable data class ApiErrorBody(val code: String = "http_error", val message: String = "Request failed")

// ---------------------------------------------------------------------------
// Session events
// ---------------------------------------------------------------------------

@OptIn(ExperimentalSerializationApi::class)
@Serializable
@JsonClassDiscriminator("kind")
sealed class SessionEvent {
    @Serializable @SerialName("status")
    data class Status(val status: SessionStatus, val exitCode: Int? = null, val signal: String? = null, val message: String? = null) : SessionEvent()

    @Serializable @SerialName("output")
    data class Output(val stream: String, val data: String) : SessionEvent()

    @Serializable @SerialName("user.prompt")
    data class UserPrompt(val text: String) : SessionEvent()

    @Serializable @SerialName("agent.text")
    /** [parentToolUseId] is set when a subagent said or did this: the id of the Task/Agent tool call that started it. */
    data class AgentText(val delta: String, val parentToolUseId: String? = null) : SessionEvent()

    @Serializable @SerialName("agent.turn_end")
    data class TurnEnd(val stopReason: String) : SessionEvent()

    @Serializable @SerialName("agent.tool_call")
    data class ToolCall(val toolUseId: String, val name: String, val summary: String, val parentToolUseId: String? = null) : SessionEvent()

    @Serializable @SerialName("agent.tool_result")
    data class ToolResult(val toolUseId: String, val ok: Boolean, val summary: String, val parentToolUseId: String? = null) : SessionEvent()

    @Serializable @SerialName("approval.request")
    data class ApprovalRequest(
        val approvalId: String,
        val toolName: String,
        val title: String,
        val detail: String,
        val risk: String,
        val expiresAt: String,
    ) : SessionEvent()

    @Serializable @SerialName("approval.resolved")
    data class ApprovalResolved(val approvalId: String, val decision: String) : SessionEvent()

    @Serializable @SerialName("usage")
    data class UsageUpdate(val usage: Usage) : SessionEvent()

    @Serializable @SerialName("error")
    data class Error(val code: String, val message: String, val retryable: Boolean = false) : SessionEvent()
}

@Serializable
data class SequencedEvent(val sessionId: String, val seq: Int, val ts: String, val event: SessionEvent)

@Serializable data class CommandError(val code: String, val message: String)
