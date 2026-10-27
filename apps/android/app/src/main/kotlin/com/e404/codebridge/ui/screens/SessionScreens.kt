package com.e404.codebridge.ui.screens

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavController
import com.e404.codebridge.ui.LocalContainer
import com.e404.codebridge.ui.Routes
import com.e404.codebridge.ui.components.ApprovalCard
import com.e404.codebridge.ui.components.ChatTranscript
import com.e404.codebridge.ui.components.Composer
import com.e404.codebridge.ui.components.ConfirmDialog
import com.e404.codebridge.ui.components.EmptyState
import com.e404.codebridge.ui.components.KindBadge
import com.e404.codebridge.ui.components.LoadContent
import com.e404.codebridge.ui.components.Notice
import com.e404.codebridge.ui.components.NoticeTone
import com.e404.codebridge.ui.components.SectionHeader
import com.e404.codebridge.ui.components.StatusBadge
import com.e404.codebridge.ui.components.TerminalInput
import com.e404.codebridge.ui.components.TerminalOutput
import com.e404.codebridge.ui.rememberAction
import com.e404.codebridge.ui.rememberLoad
import com.e404.codebridge.ui.theme.CodeBridgeTheme
import com.e404.codebridge.ui.theme.Mono
import dev.codebridge.core.ApiException
import dev.codebridge.core.ApplyResult
import dev.codebridge.core.ConnectionStatus
import dev.codebridge.core.CreateLocalSession
import dev.codebridge.core.ServerMessage
import dev.codebridge.core.SessionKind
import dev.codebridge.core.SessionMode
import dev.codebridge.core.SessionState
import dev.codebridge.core.TerminalCommand
import dev.codebridge.core.formatTokens
import dev.codebridge.core.formatUsd
import dev.codebridge.core.splitArgs
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@Composable
private fun ModeOption(title: String, body: String, selected: Boolean, disabledReason: String?, onSelect: () -> Unit) {
    val enabled = disabledReason == null
    Card(
        border = BorderStroke(1.dp, if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant),
        modifier = Modifier.fillMaxWidth().selectable(selected = selected, enabled = enabled, role = Role.RadioButton, onClick = onSelect),
    ) {
        Column(Modifier.padding(14.dp)) {
            Text(title, style = MaterialTheme.typography.titleSmall, color = if (enabled) Color.Unspecified else MaterialTheme.colorScheme.outline)
            Text(disabledReason ?: body, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
fun NewSessionScreen(nav: NavController, deviceId: String, workspaceId: String) {
    val api = LocalContainer.current.api
    val device = rememberLoad(deviceId) { api.device(deviceId) }
    var mode by remember { mutableStateOf(SessionMode.COMMAND) }
    var presetId by remember { mutableStateOf<String?>(null) }
    var custom by remember { mutableStateOf("") }
    var prompt by remember { mutableStateOf("") }
    var confirmReason by remember { mutableStateOf<String?>(null) }
    val action = rememberAction()

    fun start(confirmed: Boolean) = action.run {
        confirmReason = null
        try {
            val s = api.createLocalSession(
                deviceId,
                CreateLocalSession(
                    workspaceId = workspaceId,
                    mode = mode,
                    presetId = if (mode == SessionMode.COMMAND) presetId else null,
                    argv = if (mode == SessionMode.COMMAND && presetId == null) splitArgs(custom) else null,
                    confirmedRisk = if (confirmed) true else null,
                    prompt = prompt.trim().takeIf { (mode == SessionMode.AGENT || mode == SessionMode.CLAUDE_CODE) && it.isNotEmpty() },
                ),
            )
            nav.navigate(Routes.session(s.id)) { popUpTo(Routes.NEW_SESSION) { inclusive = true } }
        } catch (e: ApiException) {
            if (e.code == "requires_confirmation") confirmReason = e.message else throw e
        }
    }

    ScreenScaffold("New local session", nav) {
        LoadContent(device) { d ->
            val ws = d.workspaces.firstOrNull { it.id == workspaceId }
            val caps = d.capabilities
            Text("Runs on ${d.name} in ${ws?.displayPath ?: workspaceId}", style = MaterialTheme.typography.bodySmall, color = CodeBridgeTheme.colors.local)
            SectionHeader("What should run?")
            ModeOption("Command", "Run a preset (or allowed custom) command in a terminal", mode == SessionMode.COMMAND, null) { mode = SessionMode.COMMAND }
            ModeOption(
                "Coding agent (Anthropic API)",
                "Claude edits and tests this project via the Messages API with your key on the Mac. Edits and non-preset commands need your approval.",
                mode == SessionMode.AGENT,
                if (caps?.anthropicKeyConfigured == true) null else "No API key on this Mac. Run `codebridge-agent credentials set` on the Mac.",
            ) { mode = SessionMode.AGENT }
            ModeOption(
                "Claude Code (local CLI)",
                "Runs your installed `claude` CLI headlessly with its own login and permission settings.",
                mode == SessionMode.CLAUDE_CODE,
                if (caps?.claudeCodeAvailable == true) null else "Claude Code CLI not found on this Mac",
            ) { mode = SessionMode.CLAUDE_CODE }
            ModeOption(
                "Interactive shell",
                "A login shell in this folder. Equivalent to full shell access.",
                mode == SessionMode.SHELL,
                if (caps?.allowInteractiveShell == true) null else "Disabled on this Mac (codebridge-agent policy set allowInteractiveShell true)",
            ) { mode = SessionMode.SHELL }

            if (mode == SessionMode.COMMAND) {
                SectionHeader("Presets")
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    d.presets.forEach { p ->
                        FilterChip(selected = presetId == p.id, onClick = { presetId = if (presetId == p.id) null else p.id; custom = "" }, label = { Text(p.label, fontFamily = Mono) })
                    }
                }
                OutlinedTextField(
                    value = custom,
                    onValueChange = { custom = it; if (it.isNotEmpty()) presetId = null },
                    enabled = caps?.allowCustomCommands == true,
                    label = { Text("Or a custom command") },
                    placeholder = { Text(if (caps?.allowCustomCommands == true) "e.g. npm run dev" else "Disabled on this Mac (allowCustomCommands)") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Text("Commands run without a shell: no pipes, redirects or globbing.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.outline)
            }
            if (mode == SessionMode.AGENT || mode == SessionMode.CLAUDE_CODE) {
                OutlinedTextField(value = prompt, onValueChange = { prompt = it }, label = { Text("First prompt (optional)") }, minLines = 3, modifier = Modifier.fillMaxWidth())
            }
            confirmReason?.let {
                Notice("This command looks risky: $it. Run it anyway?", NoticeTone.WARNING)
                OutlinedButton(onClick = { start(confirmed = true) }, enabled = !action.busy) { Text("Run anyway", color = CodeBridgeTheme.colors.danger) }
            }
            action.error?.let { Notice(it, NoticeTone.DANGER) }
            val ready = mode != SessionMode.COMMAND || presetId != null || splitArgs(custom).isNotEmpty()
            Button(onClick = { start(confirmed = false) }, enabled = ready && d.online && !action.busy, modifier = Modifier.fillMaxWidth()) {
                Text(if (action.busy) "Starting…" else "Start session")
            }
        }
    }
}

@Composable
fun SessionsScreen(nav: NavController) {
    val api = LocalContainer.current.api
    val filters = listOf("Active", "Local Mac", "Cloud", "Finished")
    var filter by remember { mutableStateOf(filters[0]) }
    val sessions = rememberLoad(filter) {
        when (filter) {
            "Active" -> api.sessions(active = true)
            "Local Mac" -> api.sessions(kind = SessionKind.LOCAL)
            "Cloud" -> api.sessions(kind = SessionKind.CLOUD)
            else -> api.sessions(active = false)
        }
    }
    RefreshOnRealtime { sessions.refresh() }
    ScreenScaffold("Sessions", nav = null) {
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            filters.forEach { f -> FilterChip(selected = f == filter, onClick = { filter = f }, label = { Text(f) }) }
        }
        LoadContent(sessions) { list ->
            if (list.isEmpty()) EmptyState("No sessions")
            list.forEach { s -> SessionCard(s) { nav.navigate(Routes.session(s.id)) } }
        }
    }
}

@Composable
fun SessionScreen(nav: NavController, id: String) {
    val container = LocalContainer.current
    val api = container.api
    val realtime = container.realtime
    val session = rememberLoad(id) { api.session(id) }
    val state = remember(id) { SessionState() }
    var revision by remember(id) { mutableLongStateOf(0L) }
    val connection by realtime.status.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    val clipboard = LocalClipboardManager.current
    var inputError by remember { mutableStateOf<String?>(null) }
    var lastPrompt by remember { mutableStateOf<String?>(null) }
    var confirmStop by remember { mutableStateOf(false) }
    val action = rememberAction()

    // Live events: applied strictly in order on the main thread; gaps trigger a re-sync.
    LaunchedEffect(id) {
        var resync: Job? = null
        val unsubscribe = realtime.subscribe(id) { state.lastSeq }
        try {
            realtime.messages.collect { m ->
                when {
                    m is ServerMessage.Event && m.event.sessionId == id -> {
                        if (state.apply(m.event) == ApplyResult.GAP && resync == null) {
                            resync = launch {
                                delay(300)
                                realtime.resync(id, state.lastSeq)
                                resync = null
                            }
                        }
                        revision = state.revision
                    }
                    m is ServerMessage.ReplayGap && m.sessionId == id -> {
                        state.resumeFrom(m.resumeFromSeq)
                        revision = state.revision
                    }
                }
            }
        } finally {
            unsubscribe()
        }
    }

    ScreenScaffold(session.value?.mode?.label ?: "Session", nav, scroll = false) {
        LoadContent(session) { s ->
            @Suppress("UNUSED_EXPRESSION") revision
            val status = state.status ?: s.status
            val ended = status.isTerminal
            val offline = connection != ConnectionStatus.CONNECTED
            val usage = state.usage ?: s.usage
            Row { Row(Modifier.weight(1f)) { KindBadge(s.kind) }; StatusBadge(status) }
            Text(
                (if (s.kind == SessionKind.LOCAL) "${s.deviceName ?: "Mac"} · ${s.workspaceName.orEmpty()}" else "Anthropic Managed Agents sandbox (no access to your Mac)") +
                    (state.exitCode?.let { " · exit $it" } ?: ""),
                style = MaterialTheme.typography.bodySmall,
            )
            state.statusMessage?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.outline) }
            usage?.let {
                Text(
                    "${formatTokens(it.inputTokens)} in · ${formatTokens(it.outputTokens)} out · ${formatUsd(it.estimatedCostUsd)} " +
                        if (it.source == "claude_code_result") "(reported by Claude Code)" else "(estimate at list price)",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.outline,
                )
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (!ended) {
                    OutlinedButton(
                        onClick = {
                            if (s.mode.isChat || s.kind == SessionKind.CLOUD) action.run { api.signal(id, terminate = false) }
                            else scope.launch { realtime.command(TerminalCommand.Input(id, "\u0003")) }
                        },
                        enabled = !offline,
                    ) { Text(if (s.mode.isChat) "Cancel turn" else "Interrupt (^C)") }
                    OutlinedButton(onClick = { confirmStop = true }, enabled = !action.busy) {
                        Text(if (s.kind == SessionKind.CLOUD) "End session" else "Stop", color = CodeBridgeTheme.colors.danger)
                    }
                }
                if (!s.mode.isChat) IconButton(onClick = { clipboard.setText(AnnotatedString(state.terminal.plainText())) }) { Icon(Icons.Default.ContentCopy, contentDescription = "Copy output") }
                if (s.kind == SessionKind.LOCAL && s.workspaceId != null) {
                    OutlinedButton(onClick = { nav.navigate(Routes.changes(s.deviceId!!, s.workspaceId!!)) }) { Text("Changes") }
                }
            }
            action.error?.let { Notice(it, NoticeTone.DANGER) }
            if (status == dev.codebridge.core.SessionStatus.LOST) Notice("The CodeBridge agent restarted or the Mac rebooted, so this process is gone. Start a new session.", NoticeTone.WARNING)

            state.approvals.forEach { a ->
                ApprovalCard(a, busy = action.busy) { approve -> action.run { api.decideApproval(id, a.approvalId, approve) } }
            }
            val disabledReason = when {
                ended -> "Session has ended"
                offline -> "Reconnecting…"
                else -> null
            }
            if (s.mode.isChat) {
                ChatTranscript(state.chat, revision, onRetry = lastPrompt?.let { p -> { action.run { api.prompt(id, p) } } }, modifier = Modifier.weight(1f))
                Composer(
                    onSend = { text -> lastPrompt = text; action.run { api.prompt(id, text) } },
                    disabledReason = disabledReason ?: if (status == dev.codebridge.core.SessionStatus.RUNNING && s.mode == SessionMode.CLAUDE_CODE) "Claude Code is working…" else null,
                    busy = action.busy,
                )
            } else {
                TerminalOutput(state.terminal.lines(), revision, state.terminal.dropped, modifier = Modifier.weight(1f).fillMaxWidth())
                inputError?.let { Text(it, color = CodeBridgeTheme.colors.danger, style = MaterialTheme.typography.bodySmall) }
                if (s.kind == SessionKind.LOCAL) {
                    TerminalInput(
                        onSend = { data ->
                            inputError = null
                            scope.launch {
                                val r = realtime.command(TerminalCommand.Input(id, data))
                                if (!r.ok) inputError = r.error?.message ?: "Input was not delivered"
                            }
                        },
                        disabledReason = disabledReason,
                    )
                }
            }
            if (confirmStop) {
                ConfirmDialog(
                    if (s.kind == SessionKind.CLOUD) "End cloud session?" else "Stop session?",
                    if (s.kind == SessionKind.CLOUD) "The managed session is interrupted and archived at Anthropic. Its history stays readable."
                    else "Sends SIGTERM to the process on your Mac (SIGKILL after 5 seconds).",
                    if (s.kind == SessionKind.CLOUD) "End session" else "Stop",
                    onConfirm = { action.run { if (s.kind == SessionKind.CLOUD) api.endCloudSession(id) else api.signal(id, terminate = true); session.refresh() } },
                    onDismiss = { confirmStop = false },
                )
            }
        }
    }
}

private val GitCodes = mapOf("M" to "modified", "A" to "added", "D" to "deleted", "R" to "renamed", "C" to "copied", "U" to "conflict", "?" to "untracked")

@Composable
fun ChangesScreen(nav: NavController, deviceId: String, workspaceId: String) {
    val api = LocalContainer.current.api
    val status = rememberLoad(deviceId, workspaceId) { api.gitStatus(deviceId, workspaceId) }
    var selected by remember { mutableStateOf<String?>(null) }
    val diff = rememberLoad(deviceId, workspaceId, selected) { selected?.let { api.gitDiff(deviceId, workspaceId, it) } }
    val c = CodeBridgeTheme.colors
    ScreenScaffold("Changes", nav) {
        LoadContent(status) { s ->
            Text("Branch ${s.branch ?: "(detached)"}" + (s.ahead?.takeIf { it > 0 }?.let { " · $it ahead" } ?: "") + (s.behind?.takeIf { it > 0 }?.let { " · $it behind" } ?: ""), style = MaterialTheme.typography.bodySmall)
            SectionHeader("${s.files.size} changed file${if (s.files.size == 1) "" else "s"}${if (s.truncated) " (truncated)" else ""}")
            if (s.files.isEmpty()) EmptyState("Working tree clean")
            s.files.forEach { f ->
                val code = if (f.index != " " && f.index != "?") f.index else f.worktree
                Card(onClick = { selected = if (selected == f.path) null else f.path }, modifier = Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(12.dp)) {
                        Text(f.path, fontFamily = Mono, style = MaterialTheme.typography.bodyMedium)
                        Text((GitCodes[code] ?: code) + if (f.index != " " && f.index != "?") " · staged" else "", style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
            if (selected != null) {
                SectionHeader(selected!!)
                LoadContent(diff) { d ->
                    SelectionContainer {
                        Column(Modifier.horizontalScroll(rememberScrollState())) {
                            (d?.diff?.ifEmpty { "(no textual diff — new or binary file)" } ?: "").lines().take(3000).forEach { l ->
                                val color = when {
                                    l.startsWith("+") && !l.startsWith("+++") -> c.success
                                    l.startsWith("-") && !l.startsWith("---") -> c.danger
                                    l.startsWith("@@") -> MaterialTheme.colorScheme.primary
                                    else -> MaterialTheme.colorScheme.onSurfaceVariant
                                }
                                Text(l.ifEmpty { " " }, fontFamily = Mono, color = color, style = MaterialTheme.typography.bodySmall, softWrap = false)
                            }
                        }
                    }
                }
            }
        }
    }
}

