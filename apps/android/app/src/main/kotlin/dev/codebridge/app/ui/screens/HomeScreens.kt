package dev.codebridge.app.ui.screens

import android.content.Context
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.navigation.NavController
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import dev.codebridge.app.ui.LocalContainer
import dev.codebridge.app.ui.Routes
import dev.codebridge.app.ui.components.ConfirmDialog
import dev.codebridge.app.ui.components.EmptyState
import dev.codebridge.app.ui.components.KindBadge
import dev.codebridge.app.ui.components.LoadContent
import dev.codebridge.app.ui.components.Notice
import dev.codebridge.app.ui.components.NoticeTone
import dev.codebridge.app.ui.components.OnlineBadge
import dev.codebridge.app.ui.components.SectionHeader
import dev.codebridge.app.ui.components.StatusBadge
import dev.codebridge.app.ui.rememberAction
import dev.codebridge.app.ui.rememberLoad
import dev.codebridge.app.ui.theme.CodeBridgeTheme
import dev.codebridge.app.ui.theme.Mono
import dev.codebridge.core.Device
import dev.codebridge.core.PairingClaim
import dev.codebridge.core.ServerMessage
import dev.codebridge.core.Session
import dev.codebridge.core.SessionKind
import dev.codebridge.core.StatusGroup
import dev.codebridge.core.codeFromQr
import dev.codebridge.core.normalizePairingCode
import dev.codebridge.core.timeAgo

/** Re-runs [refresh] whenever the relay reports presence or session status changes. */
@Composable
fun RefreshOnRealtime(refresh: () -> Unit) {
    val realtime = LocalContainer.current.realtime
    LaunchedEffect(realtime) {
        realtime.messages.collect { if (it is ServerMessage.DeviceStatus || it is ServerMessage.SessionStatusChanged) refresh() }
    }
}

@Composable
fun DeviceCard(d: Device, onClick: () -> Unit) {
    Card(onClick = onClick, modifier = Modifier.fillMaxWidth().semantics { contentDescription = "${d.name}, ${if (d.online) "online" else "offline"}" }) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(d.name, style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                OnlineBadge(d.online)
            }
            Text(
                "${d.hostname ?: "unknown host"} · ${d.workspaces.size} workspace${if (d.workspaces.size == 1) "" else "s"}" +
                    if (d.online) "" else " · last seen ${timeAgo(d.lastSeenAt)}",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
fun SessionCard(s: Session, onClick: () -> Unit) {
    Card(onClick = onClick, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Row(Modifier.weight(1f)) { KindBadge(s.kind) }
                StatusBadge(s.status)
            }
            Text(s.title, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold, maxLines = 2)
            Text(
                "${s.mode.label} · ${if (s.kind == SessionKind.LOCAL) "${s.deviceName ?: "Mac"} / ${s.workspaceName.orEmpty()}" else "Anthropic sandbox"} · ${timeAgo(s.createdAt)}",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
fun HomeScreen(nav: NavController) {
    val api = LocalContainer.current.api
    val devices = rememberLoad { api.devices() }
    val active = rememberLoad { api.sessions(active = true) }
    RefreshOnRealtime { devices.refresh(); active.refresh() }
    ScreenScaffold("CodeBridge", nav = null, actions = { TextButton(onClick = { nav.navigate(Routes.pair()) }) { Text("Pair a Mac") } }) {
        SectionHeader("Your Macs")
        LoadContent(devices) { list ->
            if (list.isEmpty()) {
                EmptyState("No Mac paired yet", "Install the CodeBridge agent on your Mac, run `codebridge-agent pair`, then scan the code.") {
                    Button(onClick = { nav.navigate(Routes.pair()) }) { Text("Pair a Mac") }
                }
            } else list.forEach { d -> DeviceCard(d) { nav.navigate(Routes.device(d.id)) } }
        }
        val sessions = active.value.orEmpty()
        SectionHeader("Active sessions") {
            Text(
                "${sessions.count { it.status.group == StatusGroup.RUNNING }} running · ${sessions.count { it.status.group == StatusGroup.WAITING }} waiting",
                style = MaterialTheme.typography.bodySmall,
            )
        }
        LoadContent(active) { list ->
            if (list.isEmpty()) Text("No active sessions. Open a Mac to start one, or start a cloud session.", style = MaterialTheme.typography.bodySmall)
            for (kind in SessionKind.entries) {
                val group = list.filter { it.kind == kind }
                if (group.isEmpty()) continue
                Text(
                    if (kind == SessionKind.LOCAL) "On your Macs" else "Managed cloud",
                    color = if (kind == SessionKind.LOCAL) CodeBridgeTheme.colors.local else CodeBridgeTheme.colors.cloud,
                    style = MaterialTheme.typography.labelLarge,
                )
                group.forEach { s -> SessionCard(s) { nav.navigate(Routes.session(s.id)) } }
            }
        }
        TextButton(onClick = { nav.navigate(Routes.DEVICES) }) { Text("Manage devices") }
    }
}

@Composable
fun DevicesScreen(nav: NavController) {
    val api = LocalContainer.current.api
    val devices = rememberLoad { api.devices() }
    RefreshOnRealtime { devices.refresh() }
    ScreenScaffold("Devices", nav) {
        LoadContent(devices) { list ->
            if (list.isEmpty()) EmptyState("No devices") { Button(onClick = { nav.navigate(Routes.pair()) }) { Text("Pair a Mac") } }
            list.forEach { d -> ManagedDevice(d, onChanged = { devices.refresh() }, onOpen = { nav.navigate(Routes.device(d.id)) }) }
        }
    }
}

@Composable
private fun ManagedDevice(d: Device, onChanged: () -> Unit, onOpen: () -> Unit) {
    val api = LocalContainer.current.api
    val action = rememberAction()
    var editing by remember { mutableStateOf(false) }
    var name by remember(d.name) { mutableStateOf(d.name) }
    var confirmRevoke by remember { mutableStateOf(false) }
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(d.name, style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                OnlineBadge(d.online)
            }
            Text(
                "${d.hostname ?: "—"} · agent ${d.agentVersion ?: "?"} · paired ${timeAgo(d.createdAt)} · last seen ${if (d.online) "now" else timeAgo(d.lastSeenAt)}",
                style = MaterialTheme.typography.bodySmall,
            )
            if (editing) {
                OutlinedTextField(value = name, onValueChange = { name = it.take(100) }, label = { Text("Name") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = { action.run { api.renameDevice(d.id, name.trim()); editing = false; onChanged() } }, enabled = name.isNotBlank() && !action.busy) { Text("Save") }
                    TextButton(onClick = { editing = false }) { Text("Cancel") }
                }
            } else {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = onOpen) { Text("Open") }
                    OutlinedButton(onClick = { editing = true }) { Text("Rename") }
                    OutlinedButton(onClick = { confirmRevoke = true }, enabled = !action.busy) { Text("Revoke", color = CodeBridgeTheme.colors.danger) }
                }
            }
            action.error?.let { Notice(it, NoticeTone.DANGER) }
        }
    }
    if (confirmRevoke) {
        ConfirmDialog(
            "Revoke this Mac?",
            "Its credential stops working immediately, running sessions are stopped, and it must be paired again.",
            "Revoke",
            onConfirm = { action.run { api.revokeDevice(d.id); onChanged() } },
            onDismiss = { confirmRevoke = false },
        )
    }
}

@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
fun DeviceScreen(nav: NavController, id: String) {
    val api = LocalContainer.current.api
    val device = rememberLoad(id) { api.device(id) }
    RefreshOnRealtime { device.refresh() }
    ScreenScaffold(device.value?.name ?: "Mac", nav) {
        LoadContent(device) { d ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("${d.hostname} · ${d.platform} · agent ${d.agentVersion ?: "?"}", style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
                OnlineBadge(d.online)
            }
            if (!d.online) Notice("This Mac is offline (last seen ${timeAgo(d.lastSeenAt)}). Make sure the CodeBridge agent is running and the Mac is awake.", NoticeTone.WARNING)
            SectionHeader("Approved workspaces")
            if (d.workspaces.isEmpty()) Notice("No workspaces yet. On the Mac run: codebridge-agent workspace add ~/path/to/project")
            d.workspaces.forEach { w ->
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(w.name, style = MaterialTheme.typography.titleMedium)
                        Text(w.displayPath, fontFamily = Mono, style = MaterialTheme.typography.bodySmall)
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Button(onClick = { nav.navigate(Routes.newSession(d.id, w.id)) }, enabled = d.online) { Text("New session") }
                            if (w.isGitRepo) OutlinedButton(onClick = { nav.navigate(Routes.changes(d.id, w.id)) }, enabled = d.online) { Text("Changes") }
                        }
                    }
                }
            }
            SectionHeader("Capabilities (set on the Mac)")
            val c = d.capabilities
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    if (c == null) Text("The Mac hasn’t connected yet.", style = MaterialTheme.typography.bodySmall)
                    else listOf(
                        "Terminal" to if (c.pty) "PTY" else "pipes only",
                        "Coding agent API key" to if (c.anthropicKeyConfigured) "stored in the Mac’s Keychain" else "not set",
                        "Claude Code CLI" to if (c.claudeCodeAvailable) "available" else "not available",
                        "Custom commands" to if (c.allowCustomCommands) "allowed" else "disabled",
                        "Interactive shell" to if (c.allowInteractiveShell) "allowed" else "disabled",
                    ).forEach { (k, v) -> Text("$k: $v", style = MaterialTheme.typography.bodySmall) }
                }
            }
        }
    }
}

private fun scanQr(context: Context, onCode: (String) -> Unit, onError: (String) -> Unit) {
    // Google code scanner: Play services shows the camera UI; the app needs no camera permission.
    val options = GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build()
    GmsBarcodeScanning.getClient(context, options).startScan()
        .addOnSuccessListener { barcode ->
            val code = barcode.rawValue?.let(::codeFromQr)
            if (code != null) onCode(code) else onError("That QR code isn’t a CodeBridge pairing code.")
        }
        .addOnFailureListener { onError("Scanner unavailable: ${it.message}. Type the code instead.") }
}

@Composable
fun PairScreen(nav: NavController, initialCode: String?) {
    val api = LocalContainer.current.api
    val context = LocalContext.current
    var code by remember { mutableStateOf(initialCode.orEmpty()) }
    var claimed by remember { mutableStateOf<PairingClaim?>(null) }
    var done by remember { mutableStateOf(false) }
    val action = rememberAction()
    val claim = { raw: String ->
        val normalized = normalizePairingCode(raw)
        if (normalized == null) action.error = "Enter the 8-character code shown on your Mac (e.g. ABCD-EFGH)."
        else action.run { claimed = api.claimPairing(normalized) }
    }
    ScreenScaffold("Pair a Mac", nav) {
        val c = claimed
        when {
            done -> {
                Text("Almost there", style = MaterialTheme.typography.headlineSmall)
                Text("Confirm on your Mac that it should join your account (the agent asks “Is that your account?”). It will then appear on your dashboard.")
                Button(onClick = { nav.popBackStack(Routes.HOME, inclusive = false) }) { Text("Back to dashboard") }
            }
            c != null -> {
                Text("Allow this Mac to connect?", style = MaterialTheme.typography.titleLarge)
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp)) {
                        Text(c.deviceName, style = MaterialTheme.typography.titleMedium)
                        Text("${c.hostname ?: "unknown host"} · ${c.platform ?: "unknown platform"}", style = MaterialTheme.typography.bodySmall)
                    }
                }
                Notice("Only approve if you just ran `codebridge-agent pair` on this Mac yourself. Once paired, you can run approved commands on it from this phone.", NoticeTone.WARNING)
                action.error?.let { Notice(it, NoticeTone.DANGER) }
                Button(onClick = { action.run { api.decidePairing(c.pairingId, true); done = true } }, enabled = !action.busy, modifier = Modifier.fillMaxWidth()) { Text("Approve") }
                OutlinedButton(onClick = { action.run { api.decidePairing(c.pairingId, false); nav.popBackStack() } }, enabled = !action.busy, modifier = Modifier.fillMaxWidth()) {
                    Text("Deny", color = CodeBridgeTheme.colors.danger)
                }
            }
            else -> {
                Text("On your Mac, run `codebridge-agent pair --server …`. Then scan the QR code or type the code it shows.")
                OutlinedButton(onClick = { scanQr(context, onCode = { code = it; claim(it) }, onError = { action.error = it }) }, modifier = Modifier.fillMaxWidth()) {
                    Text("Scan QR code")
                }
                OutlinedTextField(
                    value = code,
                    onValueChange = { code = it.uppercase().take(9) },
                    label = { Text("Pairing code") },
                    placeholder = { Text("ABCD-EFGH") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                action.error?.let { Notice(it, NoticeTone.DANGER) }
                Button(onClick = { claim(code) }, enabled = !action.busy && code.count { it.isLetterOrDigit() } == 8, modifier = Modifier.fillMaxWidth()) { Text("Continue") }
            }
        }
    }
}

