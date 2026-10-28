package com.e404.codebridge.ui.screens

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.navigation.NavController
import com.e404.codebridge.ui.LocalContainer
import com.e404.codebridge.ui.Routes
import com.e404.codebridge.ui.components.ConfirmDialog
import com.e404.codebridge.ui.components.EmptyState
import com.e404.codebridge.ui.components.LoadContent
import com.e404.codebridge.ui.components.SectionHeader
import com.e404.codebridge.ui.rememberAction
import com.e404.codebridge.ui.rememberLoad
import com.e404.codebridge.ui.theme.CodeBridgeTheme
import dev.codebridge.core.Device
import dev.codebridge.core.Session
import dev.codebridge.core.SessionMode
import dev.codebridge.core.SessionStatus
import dev.codebridge.core.StatusGroup
import dev.codebridge.core.formatUsd
import dev.codebridge.core.timeAgo

private class AgentsSnapshot(val sessions: List<Session>, val devices: List<Device>)

/**
 * Every Claude Code session across your computers, grouped by what needs you: waiting on an approval, working, or
 * idle. Open one, cancel a running turn without opening it, or start another agent in any project.
 */
@Composable
fun AgentsScreen(nav: NavController) {
    val api = LocalContainer.current.api
    val data = rememberLoad {
        AgentsSnapshot(
            api.sessions(active = true).filter { it.mode == SessionMode.CLAUDE_CODE || it.mode == SessionMode.AGENT },
            api.devices(),
        )
    }
    RefreshOnRealtime { data.refresh() }
    val action = rememberAction()
    var confirmStop by remember { mutableStateOf<Session?>(null) }

    ScreenScaffold("Agents", nav = null) {
        LoadContent(data) { snap ->
            val needs = snap.sessions.filter { it.status == SessionStatus.WAITING }
            val working = snap.sessions.filter { it.status.group == StatusGroup.RUNNING }
            val idle = snap.sessions.filter { it.status == SessionStatus.IDLE }
            Summary(needs.size, working.size, idle.size, snap.devices.count { it.online })
            NewAgentMenu(nav, snap.devices)
            action.error?.let { com.e404.codebridge.ui.components.Notice(it, com.e404.codebridge.ui.components.NoticeTone.DANGER) }
            if (snap.sessions.isEmpty()) {
                EmptyState("No agents running", "Start one in any project on your computers. Each agent works on its own, and you can run several at once.")
            }
            Group("Needs you", needs, nav, action.busy, onCancel = { s -> action.run { api.signal(s.id, terminate = false); data.refresh() } }) { confirmStop = it }
            Group("Working", working, nav, action.busy, onCancel = { s -> action.run { api.signal(s.id, terminate = false); data.refresh() } }) { confirmStop = it }
            Group("Waiting for a prompt", idle, nav, action.busy, onCancel = {}) { confirmStop = it }
            OutlinedButton(onClick = { nav.navigate(Routes.SESSIONS) }, modifier = Modifier.fillMaxWidth()) { Text("History and cloud sessions") }
        }
    }
    confirmStop?.let { s ->
        ConfirmDialog(
            "Stop this agent?",
            "Ends the session on your computer. Its history stays readable.",
            "Stop",
            onConfirm = { confirmStop = null; action.run { api.signal(s.id, terminate = true); data.refresh() } },
            onDismiss = { confirmStop = null },
        )
    }
}

@Composable
private fun Summary(needs: Int, working: Int, idle: Int, online: Int) {
    val c = CodeBridgeTheme.colors
    Card(Modifier.fillMaxWidth()) {
        Row(Modifier.fillMaxWidth().padding(vertical = 14.dp)) {
            Stat(needs, "Need you", c.warning)
            Stat(working, "Working", MaterialTheme.colorScheme.primary)
            Stat(idle, "Idle", MaterialTheme.colorScheme.outline)
            Stat(online, "Online", c.success)
        }
    }
}

@Composable
private fun androidx.compose.foundation.layout.RowScope.Stat(n: Int, label: String, color: Color) {
    Column(Modifier.weight(1f), horizontalAlignment = Alignment.CenterHorizontally) {
        Text("$n", style = MaterialTheme.typography.headlineSmall, color = if (n > 0) color else MaterialTheme.colorScheme.outline)
        Text(label, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun Group(title: String, sessions: List<Session>, nav: NavController, busy: Boolean, onCancel: (Session) -> Unit, onStop: (Session) -> Unit) {
    if (sessions.isEmpty()) return
    SectionHeader(title)
    sessions.forEach { s -> AgentCard(s, nav, busy, onCancel, onStop) }
}

@Composable
private fun StatusDot(status: SessionStatus) {
    val c = CodeBridgeTheme.colors
    val color = when (status.group) {
        StatusGroup.RUNNING -> MaterialTheme.colorScheme.primary
        StatusGroup.WAITING -> c.warning
        StatusGroup.COMPLETED -> c.success
        StatusGroup.FAILED -> c.danger
    }
    val pulse = rememberInfiniteTransition(label = "pulse").animateFloat(
        initialValue = 1f, targetValue = if (status.group == StatusGroup.RUNNING) 1.4f else 1f,
        animationSpec = infiniteRepeatable(tween(900), RepeatMode.Reverse), label = "scale",
    ).value
    Box(Modifier.size(10.dp).scale(pulse).alpha(if (pulse > 1f) 0.7f else 1f).background(color, CircleShape))
}

@Composable
private fun AgentCard(s: Session, nav: NavController, busy: Boolean, onCancel: (Session) -> Unit, onStop: (Session) -> Unit) {
    val c = CodeBridgeTheme.colors
    Card(onClick = { nav.navigate(Routes.session(s.id)) }, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.Top) {
                Box(Modifier.padding(top = 7.dp)) { StatusDot(s.status) }
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(s.title, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold, maxLines = 2)
                    Text("${s.deviceName ?: "Computer"} · ${s.workspaceName.orEmpty()}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(
                        (if (s.status == SessionStatus.WAITING) "Waiting for your approval" else s.status.label) +
                            " · ${timeAgo(s.createdAt)}" + (s.usage?.let { " · ${formatUsd(it.estimatedCostUsd)}" } ?: ""),
                        style = MaterialTheme.typography.labelMedium,
                        color = if (s.status == SessionStatus.WAITING) c.warning else MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (s.status.group == StatusGroup.RUNNING) OutlinedButton(onClick = { onCancel(s) }, enabled = !busy) { Text("Cancel turn") }
                OutlinedButton(onClick = { onStop(s) }, enabled = !busy) { Text("Stop", color = c.danger) }
            }
        }
    }
}

/** Start another agent: pick an online computer's project. */
@Composable
private fun NewAgentMenu(nav: NavController, devices: List<Device>) {
    var open by remember { mutableStateOf(false) }
    val online = devices.filter { it.online }
    Box {
        Button(onClick = { open = true }, modifier = Modifier.fillMaxWidth()) { Text("New agent") }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            if (online.isEmpty()) DropdownMenuItem(text = { Text("No computer is online") }, onClick = { open = false }, enabled = false)
            online.forEach { d ->
                if (d.workspaces.isEmpty()) DropdownMenuItem(text = { Text("${d.name}: no projects yet") }, onClick = { open = false }, enabled = false)
                d.workspaces.forEach { w ->
                    DropdownMenuItem(text = { Text("${d.name} / ${w.name}") }, onClick = { open = false; nav.navigate(Routes.newSession(d.id, w.id)) })
                }
            }
        }
    }
}
