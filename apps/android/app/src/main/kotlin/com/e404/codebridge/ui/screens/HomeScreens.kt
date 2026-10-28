package com.e404.codebridge.ui.screens

import android.content.Context
import androidx.compose.foundation.layout.Arrangement
import dev.codebridge.core.projectNameError
import dev.codebridge.core.isValidProjectName
import androidx.compose.foundation.layout.heightIn
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.material3.Switch
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import com.e404.codebridge.ui.theme.GlassIconButton
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.lifecycle.compose.collectAsStateWithLifecycle
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
import com.e404.codebridge.ui.LocalContainer
import com.e404.codebridge.ui.Routes
import com.e404.codebridge.ui.components.ConfirmDialog
import com.e404.codebridge.ui.components.EmptyState
import com.e404.codebridge.ui.components.KindBadge
import com.e404.codebridge.ui.components.LoadContent
import com.e404.codebridge.ui.components.Notice
import com.e404.codebridge.ui.components.NoticeTone
import com.e404.codebridge.ui.components.OnlineBadge
import com.e404.codebridge.ui.components.SectionHeader
import com.e404.codebridge.ui.components.StatusBadge
import com.e404.codebridge.ui.rememberAction
import com.e404.codebridge.ui.rememberLoad
import com.e404.codebridge.ui.theme.CodeBridgeTheme
import com.e404.codebridge.ui.theme.Mono
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
    ScreenScaffold("Your computers", nav = null, actions = {
        GlassIconButton("Add a computer", onClick = { nav.navigate(Routes.pair()) }) { Icon(Icons.Default.Add, contentDescription = null, tint = MaterialTheme.colorScheme.onSurface) }
    }) {
        LoadContent(devices) { list ->
            if (list.isEmpty()) {
                EmptyState("No computer yet", "Install the CodeBridge agent on your Mac or PC and connect it to your relay.") {
                    Button(onClick = { nav.navigate(Routes.pair()) }) { Text("Add a computer") }
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
            if (list.isEmpty()) EmptyState("No computers yet") { Button(onClick = { nav.navigate(Routes.pair()) }) { Text("Add a computer") } }
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
            SectionHeader("Projects")
            if (d.capabilities?.canCreateWorkspaces == true) {
                Button(onClick = { nav.navigate(Routes.newProject(d.id)) }, enabled = d.online, modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp)) { Text("New project") }
            }
            if (d.capabilities?.canBrowseFolders == true) {
                OutlinedButton(onClick = { nav.navigate(Routes.addFolder(d.id)) }, enabled = d.online, modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp)) { Text("Add existing folder") }
            }
            if (d.workspaces.isEmpty()) {
                Notice(
                    if (d.capabilities?.canCreateWorkspaces == true) "No projects yet. Create one above, or on the computer run: codebridge-agent workspace add ~/path/to/project"
                    else "No workspaces yet. On the computer run: codebridge-agent workspace add ~/path/to/project",
                )
            }
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
                        "New projects from this phone" to if (c.canCreateWorkspaces == true) "allowed" else "disabled",
                        "Pick existing folders" to if (c.canBrowseFolders == true) "allowed" else "disabled",
                        "Default project folder" to (c.projectsRoot ?: "~/CodeBridge"),
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
    ScreenScaffold(if (LocalContainer.current.relay != null) "Add a computer" else "Pair a Mac", nav) {
        val c = claimed
        val personalCommand = LocalContainer.current.agentConnectCommand
        when {
            // Personal relay: the computer joins with the same secret as this phone. No code to approve.
            personalCommand != null -> {
                Text("Add a computer to your relay. Install the agent there, then run the command below on it. It connects straight away, with nothing to approve.")
                CommandCard("1. Install the agent (needs Node.js 22+)", AGENT_INSTALL_COMMAND)
                CommandCard("2. Run this on the computer. It contains your relay password, so don’t share it.", personalCommand)
                Text("Optional: install Claude Code and sign in there to use your Claude plan. That login stays on the computer.", style = MaterialTheme.typography.bodySmall)
            }
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



/**
 * Start a new project on a computer by name. The phone sends only a name: the computer creates a brand-new folder
 * inside its own projects folder, never an existing one, and the owner can switch this off.
 */
@Composable
fun NewProjectScreen(nav: NavController, deviceId: String) {
    val api = LocalContainer.current.api
    val device = rememberLoad(deviceId) { api.device(deviceId) }
    // This screen's own back-stack entry, captured once: the folder picker hands the new default back through it.
    val ownEntry = remember { nav.currentBackStackEntry }
    val chosenRoot by (ownEntry?.savedStateHandle?.getStateFlow<String?>("projectsRoot", null)
        ?: kotlinx.coroutines.flow.MutableStateFlow<String?>(null)).collectAsStateWithLifecycle()
    var name by remember { mutableStateOf("") }
    var gitInit by remember { mutableStateOf(true) }
    val action = rememberAction()
    val problem = projectNameError(name)
    val canCreate = isValidProjectName(name) && !action.busy
    val create = {
        if (canCreate) action.run {
            val result = api.createWorkspace(deviceId, name.trim(), gitInit)
            // Straight on to starting a session in the new project.
            nav.navigate(Routes.newSession(deviceId, result.workspace.id)) { popUpTo(Routes.NEW_PROJECT) { inclusive = true } }
        }
    }
    ScreenScaffold("New project", nav) {
        Text(
            "A new folder is created on your computer, inside the default project folder below. Existing folders are never touched.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        val current = device.value
        SectionHeader("Default project folder")
        Text(chosenRoot ?: current?.capabilities?.projectsRoot ?: "~/CodeBridge", fontFamily = Mono, style = MaterialTheme.typography.bodyLarge)
        if (current?.capabilities?.canBrowseFolders == true) {
            OutlinedButton(onClick = { nav.navigate(Routes.defaultFolder(deviceId)) }, modifier = Modifier.fillMaxWidth()) { Text("Change default folder") }
        }
        OutlinedTextField(
            value = name,
            onValueChange = { name = it },
            label = { Text("Project name") },
            singleLine = true,
            isError = problem != null,
            supportingText = { problem?.let { Text(it) } },
            keyboardOptions = KeyboardOptions(autoCorrectEnabled = false, imeAction = ImeAction.Go),
            keyboardActions = KeyboardActions(onGo = { create() }),
            modifier = Modifier.fillMaxWidth(),
        )
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text("Start a git repository", modifier = Modifier.weight(1f), style = MaterialTheme.typography.bodyLarge)
            Switch(checked = gitInit, onCheckedChange = { gitInit = it })
        }
        action.error?.let { Notice(it, NoticeTone.DANGER) }
        Button(onClick = { create() }, enabled = canCreate, modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp)) {
            Text(if (action.busy) "Creating…" else "Create project")
        }
    }
}


/**
 * Pick a folder that already exists on the computer. Only folders inside its home directory are shown (no hidden or
 * system folders), and the computer checks the choice again before adding it.
 */
@Composable
fun AddFolderScreen(nav: NavController, deviceId: String, chooseDefault: Boolean = false) {
    val api = LocalContainer.current.api
    var path by remember { mutableStateOf<String?>(null) }
    val listing = rememberLoad(deviceId, path) { api.browseFolders(deviceId, path) }
    val action = rememberAction()
    ScreenScaffold(if (chooseDefault) "Default folder" else "Add folder", nav) {
        LoadContent(listing) { l ->
            Text(l.displayPath, fontFamily = Mono, style = MaterialTheme.typography.bodyMedium)
            Text(
                when {
                    chooseDefault && l.canAdd -> "New projects will be created inside this folder."
                    chooseDefault -> "Open the folder where new projects should go, such as Projects."
                    l.canAdd -> "Choose “Use this folder” to work in it, or open a folder inside it."
                    else -> "Open the folder that holds your project."
                },
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            action.error?.let { Notice(it, NoticeTone.DANGER) }
            Button(
                onClick = {
                    action.run {
                        if (chooseDefault) {
                            val result = api.setProjectsRoot(deviceId, l.path)
                            nav.previousBackStackEntry?.savedStateHandle?.set("projectsRoot", result.projectsRoot)
                            nav.popBackStack()
                        } else {
                            val result = api.addWorkspace(deviceId, l.path)
                            nav.navigate(Routes.newSession(deviceId, result.workspace.id)) { popUpTo(Routes.ADD_FOLDER) { inclusive = true } }
                        }
                    }
                },
                enabled = l.canAdd && !action.busy,
                modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp),
            ) { Text(if (action.busy) "Saving…" else if (chooseDefault) "Set as default" else "Use this folder") }
            l.parentPath?.let { parent ->
                OutlinedButton(onClick = { path = parent }, modifier = Modifier.fillMaxWidth()) { Text("Up one folder") }
            }
            if (l.folders.isEmpty()) EmptyState("No folders here")
            l.folders.forEach { f ->
                Card(onClick = { path = f.path }, modifier = Modifier.fillMaxWidth()) {
                    Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(f.name, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
                        if (f.isGitRepo) Text("git", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.outline)
                    }
                }
            }
            if (l.truncated) Text("Only the first folders are shown.", style = MaterialTheme.typography.bodySmall)
        }
    }
}
