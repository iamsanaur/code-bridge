package dev.codebridge.core

sealed interface ChatItem {
    val id: String
    data class UserMessage(override val id: String, val text: String) : ChatItem
    data class Assistant(override val id: String, val text: String, val streaming: Boolean) : ChatItem
    data class Tool(override val id: String, val toolUseId: String, val name: String, val summary: String, val result: ToolOutcome? = null) : ChatItem
    data class Failure(override val id: String, val code: String, val message: String, val retryable: Boolean) : ChatItem
    data class Notice(override val id: String, val text: String) : ChatItem
}

data class ToolOutcome(val ok: Boolean, val summary: String)

data class PendingApproval(
    val approvalId: String,
    val toolName: String,
    val title: String,
    val detail: String,
    val risk: String,
    val expiresAt: String,
)

enum class ApplyResult { APPLIED, DUPLICATE, GAP }

/**
 * Client-side model of one session's stream. Events apply strictly in `seq` order:
 * duplicates are ignored, early arrivals are buffered, and gaps are reported so the
 * caller can re-subscribe from the last contiguous event. Not thread-safe: confine
 * to one thread (the UI thread on Android).
 */
class SessionState {
    var lastSeq = 0; private set
    var status: SessionStatus? = null; private set
    var statusMessage: String? = null; private set
    var exitCode: Int? = null; private set
    var usage: Usage? = null; private set
    val terminal = TerminalBuffer(5000)
    private val _chat = mutableListOf<ChatItem>()
    val chat: List<ChatItem> get() = _chat
    private val _approvals = linkedMapOf<String, PendingApproval>()
    val approvals: Collection<PendingApproval> get() = _approvals.values
    private val pending = HashMap<Int, SequencedEvent>()
    var revision = 0L; private set

    fun apply(ev: SequencedEvent): ApplyResult {
        if (ev.seq <= lastSeq) return ApplyResult.DUPLICATE
        if (ev.seq > lastSeq + 1) {
            pending[ev.seq] = ev
            if (pending.size > 2000) pending.clear()
            return ApplyResult.GAP
        }
        applyOne(ev)
        drain()
        return ApplyResult.APPLIED
    }

    /** The server says events before [seq] are gone everywhere: skip ahead. */
    fun resumeFrom(seq: Int) {
        if (seq - 1 <= lastSeq) return
        lastSeq = seq - 1
        terminal.write("\r\n\u001b[33m[earlier output is no longer available]\u001b[0m\r\n")
        revision++
        drain()
    }

    private fun drain() {
        while (true) {
            val next = pending.remove(lastSeq + 1) ?: return
            applyOne(next)
        }
    }

    private fun applyOne(ev: SequencedEvent) {
        lastSeq = ev.seq
        revision++
        val id = ev.seq.toString()
        when (val e = ev.event) {
            is SessionEvent.Status -> {
                status = e.status
                statusMessage = e.message
                if (e.exitCode != null) exitCode = e.exitCode
                if (e.status != SessionStatus.RUNNING && e.status != SessionStatus.STARTING) closeStreaming()
            }
            is SessionEvent.Output -> terminal.write(e.data)
            is SessionEvent.UserPrompt -> {
                closeStreaming()
                _chat += ChatItem.UserMessage(id, e.text)
            }
            is SessionEvent.AgentText -> {
                val last = _chat.lastOrNull()
                if (last is ChatItem.Assistant && last.streaming) _chat[_chat.lastIndex] = last.copy(text = last.text + e.delta)
                else _chat += ChatItem.Assistant(id, e.delta, streaming = true)
            }
            is SessionEvent.TurnEnd -> closeStreaming()
            is SessionEvent.ToolCall -> {
                closeStreaming()
                _chat += ChatItem.Tool(id, e.toolUseId, e.name, e.summary)
            }
            is SessionEvent.ToolResult -> {
                val idx = _chat.indexOfLast { it is ChatItem.Tool && it.toolUseId == e.toolUseId }
                if (idx >= 0) _chat[idx] = (_chat[idx] as ChatItem.Tool).copy(result = ToolOutcome(e.ok, e.summary))
            }
            is SessionEvent.ApprovalRequest -> _approvals[e.approvalId] = PendingApproval(e.approvalId, e.toolName, e.title, e.detail, e.risk, e.expiresAt)
            is SessionEvent.ApprovalResolved -> {
                _approvals.remove(e.approvalId)
                if (e.decision != "approved") _chat += ChatItem.Notice(id, "Approval ${e.decision}")
            }
            is SessionEvent.UsageUpdate -> usage = e.usage
            is SessionEvent.Error -> {
                closeStreaming()
                _chat += ChatItem.Failure(id, e.code, e.message, e.retryable)
                terminal.write("\r\n\u001b[31m[${e.code}] ${e.message}\u001b[0m\r\n")
            }
        }
    }

    private fun closeStreaming() {
        val last = _chat.lastOrNull()
        if (last is ChatItem.Assistant && last.streaming) _chat[_chat.lastIndex] = last.copy(streaming = false)
    }
}
