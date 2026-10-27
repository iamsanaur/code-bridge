package dev.codebridge.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.navigation.NavController
import dev.codebridge.app.ui.AuthState
import dev.codebridge.app.ui.LocalContainer
import dev.codebridge.app.ui.Routes
import dev.codebridge.app.ui.components.ConfirmDialog
import dev.codebridge.app.ui.components.LoadContent
import dev.codebridge.app.ui.components.Notice
import dev.codebridge.app.ui.components.NoticeTone
import dev.codebridge.app.ui.components.SectionHeader
import dev.codebridge.app.ui.rememberAction
import dev.codebridge.app.ui.rememberLoad
import dev.codebridge.app.ui.theme.CodeBridgeTheme
import dev.codebridge.app.ui.theme.Mono
import dev.codebridge.core.SessionKind
import dev.codebridge.core.formatTokens
import dev.codebridge.core.formatUsd
import java.util.Locale

@Composable
fun CredentialsScreen(nav: NavController) {
    val api = LocalContainer.current.api
    val devices = rememberLoad { api.devices() }
    val cred = rememberLoad { api.cloudCredential() }
    var key by remember { mutableStateOf("") }
    val action = rememberAction()
    ScreenScaffold("API credentials", nav) {
        SectionHeader("Local Mac sessions")
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("The coding agent on your Mac uses an API key stored in that Mac’s Keychain. It is never sent to the CodeBridge server or through the relay.")
                Text("codebridge-agent credentials set", fontFamily = Mono, style = MaterialTheme.typography.bodySmall)
                devices.value?.forEach { d -> Text("${d.name}: ${if (d.capabilities?.anthropicKeyConfigured == true) "key configured" else "no key"}", style = MaterialTheme.typography.bodySmall) }
                Text("Claude Code sessions use the `claude` CLI’s own login on the Mac; an API key here does not sign in Claude Code.", style = MaterialTheme.typography.bodySmall)
            }
        }
        SectionHeader("Managed cloud sessions")
        LoadContent(cred) { c ->
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Cloud sessions run on Anthropic’s Managed Agents platform and need a key stored on the CodeBridge server, encrypted at rest (AES-256-GCM). Anthropic bills that key.")
                    if (!c.storageAvailable) Notice("This server has no credential encryption key configured, so cloud keys can’t be stored.", NoticeTone.WARNING)
                    Text(if (c.configured) "Key on file: ${c.hint}" else "No key on file.", style = MaterialTheme.typography.bodySmall)
                    OutlinedTextField(
                        value = key,
                        onValueChange = { key = it },
                        label = { Text(if (c.configured) "Replace key" else "Anthropic API key") },
                        placeholder = { Text("sk-ant-…") },
                        singleLine = true,
                        visualTransformation = PasswordVisualTransformation(),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    action.error?.let { Notice(it, NoticeTone.DANGER) }
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(
                            onClick = { action.run { api.saveCloudKey(key.trim()); key = ""; cred.refresh() } },
                            enabled = key.trim().startsWith("sk-ant-") && c.storageAvailable && !action.busy,
                        ) { Text("Save key") }
                        if (c.configured) OutlinedButton(onClick = { action.run { api.deleteCloudKey(); cred.refresh() } }, enabled = !action.busy) {
                            Text("Remove key", color = CodeBridgeTheme.colors.danger)
                        }
                    }
                }
            }
        }
    }
}

@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
fun CloudScreen(nav: NavController) {
    val api = LocalContainer.current.api
    val cfg = rememberLoad { api.cloudConfig() }
    val sessions = rememberLoad { api.sessions(kind = SessionKind.CLOUD) }
    RefreshOnRealtime { sessions.refresh() }
    var model by remember { mutableStateOf("") }
    var unrestricted by remember { mutableStateOf(false) }
    var hosts by remember { mutableStateOf("") }
    var budget by remember { mutableStateOf("") }
    val action = rememberAction()
    LaunchedEffect(cfg.value) {
        cfg.value?.let {
            model = it.model
            unrestricted = it.networking == "unrestricted"
            hosts = it.allowedHosts.joinToString(", ")
            budget = String.format(Locale.US, "%.2f", it.budgetCents / 100.0)
        }
    }
    ScreenScaffold("Cloud sessions", nav = null) {
        LoadContent(cfg) { c ->
            if (!c.enabled) {
                Notice("Cloud sessions are disabled on this server.")
                return@LoadContent
            }
            Notice("CodeBridge-managed cloud sessions run in a fresh, isolated container on Anthropic Managed Agents. They can’t access your Mac, and they are not your Claude.ai or Claude Code sessions.")
            if (!c.keyConfigured) Notice("Add an Anthropic API key for cloud sessions first.", NoticeTone.WARNING)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = { nav.navigate(Routes.NEW_CLOUD) }, enabled = c.keyConfigured) { Text("New cloud session") }
                OutlinedButton(onClick = { nav.navigate(Routes.CREDENTIALS) }) { Text(if (c.keyConfigured) "API key" else "Add key") }
            }
            SectionHeader("Environment")
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Model", style = MaterialTheme.typography.labelLarge)
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        c.availableModels.forEach { m -> FilterChip(selected = m == model, onClick = { model = m }, label = { Text(m) }) }
                    }
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("Unrestricted network", modifier = Modifier.weight(1f))
                        Switch(checked = unrestricted, onCheckedChange = { unrestricted = it }, modifier = Modifier.semantics { contentDescription = "Unrestricted network access" })
                    }
                    Text(
                        if (unrestricted) "The sandbox can reach any host. Keep secrets out of prompts and files." else "Limited: package registries plus the hosts you list below.",
                        style = MaterialTheme.typography.bodySmall,
                    )
                    if (!unrestricted) OutlinedTextField(value = hosts, onValueChange = { hosts = it }, label = { Text("Allowed hosts") }, placeholder = { Text("api.github.com, pypi.org") }, modifier = Modifier.fillMaxWidth())
                    OutlinedTextField(
                        value = budget,
                        onValueChange = { budget = it },
                        label = { Text("Budget per session (USD, hard cap)") },
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Text("At most ${c.maxConcurrent} cloud session(s) can run at once. Sessions are ended automatically after the server’s maximum duration.", style = MaterialTheme.typography.bodySmall)
                    action.error?.let { Notice(it, NoticeTone.DANGER) }
                    OutlinedButton(
                        onClick = {
                            action.run {
                                val cents = ((budget.toDoubleOrNull() ?: 0.0) * 100).toInt()
                                api.updateCloudConfig(model, unrestricted, hosts.split(',', ' ', '\n').map { it.trim() }.filter { it.isNotEmpty() }, cents)
                                cfg.refresh()
                            }
                        },
                        enabled = !action.busy,
                    ) { Text("Save environment") }
                    Text(
                        c.resources?.let { "Agent ${it.agentId} · Environment ${it.environmentId}" } ?: "Resources are created at Anthropic on first use.",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.outline,
                    )
                }
            }
            Text(c.billing, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.outline)
        }
        SectionHeader("Cloud sessions")
        LoadContent(sessions) { list ->
            if (list.isEmpty()) Text("None yet.", style = MaterialTheme.typography.bodySmall)
            list.forEach { s -> SessionCard(s) { nav.navigate(Routes.session(s.id)) } }
        }
    }
}

@Composable
fun NewCloudSessionScreen(nav: NavController) {
    val api = LocalContainer.current.api
    var prompt by remember { mutableStateOf("") }
    val action = rememberAction()
    ScreenScaffold("New cloud session", nav) {
        Notice("This starts a new session in an Anthropic-hosted sandbox. It has no access to your Mac’s files.")
        OutlinedTextField(value = prompt, onValueChange = { prompt = it }, label = { Text("What should the cloud agent do?") }, minLines = 4, modifier = Modifier.fillMaxWidth())
        action.error?.let { Notice(it, NoticeTone.DANGER) }
        Button(
            onClick = { action.run { val s = api.createCloudSession(prompt.trim()); nav.navigate(Routes.session(s.id)) { popUpTo(Routes.NEW_CLOUD) { inclusive = true } } } },
            enabled = prompt.isNotBlank() && !action.busy,
            modifier = Modifier.fillMaxWidth(),
        ) { Text(if (action.busy) "Starting…" else "Start cloud session") }
    }
}

@Composable
fun UsageScreen(nav: NavController) {
    val api = LocalContainer.current.api
    val usage = rememberLoad { api.usage() }
    ScreenScaffold("Usage & cost", nav) {
        Notice("Figures are estimates at Anthropic list prices from the usage each session reported (Claude Code sessions show the CLI’s own figure). Your Anthropic invoice is authoritative.")
        LoadContent(usage) { u ->
            listOf("local" to "Local Mac (your API key on the Mac)", "cloud" to "Managed cloud (your server-stored key)").forEach { (k, label) ->
                val t = u.totals[k]
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(label, style = MaterialTheme.typography.labelLarge)
                        Text(formatUsd(t?.estimatedCostUsd ?: 0.0), style = MaterialTheme.typography.headlineMedium, color = if (k == "local") CodeBridgeTheme.colors.local else CodeBridgeTheme.colors.cloud)
                        Text(
                            "${t?.sessions ?: 0} session(s) · ${formatTokens(t?.inputTokens ?: 0)} input · ${formatTokens(t?.outputTokens ?: 0)} output tokens · last ${u.periodDays} days",
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                }
            }
            if (u.sessionsWithUnknownCost > 0) Text("${u.sessionsWithUnknownCost} session(s) used a model without a known price and are excluded from cost totals.", style = MaterialTheme.typography.bodySmall)
        }
    }
}

@Composable
fun SettingsScreen(nav: NavController, auth: AuthState) {
    val container = LocalContainer.current
    var password by remember { mutableStateOf("") }
    var confirmDelete by remember { mutableStateOf(false) }
    val action = rememberAction()
    ScreenScaffold("Settings & security", nav = null) {
        SectionHeader("Account")
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp)) {
                Text(auth.user?.email.orEmpty(), style = MaterialTheme.typography.titleMedium)
                Text("Server: ${container.apiUrl}", style = MaterialTheme.typography.bodySmall)
                if (container.isInsecure) Text("Not using HTTPS (development build).", color = CodeBridgeTheme.colors.warning, style = MaterialTheme.typography.bodySmall)
            }
        }
        OutlinedButton(onClick = { nav.navigate(Routes.DEVICES) }, modifier = Modifier.fillMaxWidth()) { Text("Devices") }
        OutlinedButton(onClick = { nav.navigate(Routes.CREDENTIALS) }, modifier = Modifier.fillMaxWidth()) { Text("API credentials") }
        OutlinedButton(onClick = { nav.navigate(Routes.USAGE) }, modifier = Modifier.fillMaxWidth()) { Text("Usage & cost") }
        SectionHeader("Security")
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                listOf(
                    "Sign-in tokens are encrypted with a key held in the Android Keystore and rotate on every refresh.",
                    "Your Macs connect outbound to the relay; no ports are opened on your Mac.",
                    "Traffic is encrypted in transit (TLS) to the CodeBridge server, which relays it to your Mac. It is not end-to-end encrypted: the server can see terminal traffic while relaying it, but does not store terminal output.",
                    "Which folders and commands are allowed is decided on each Mac and can’t be changed from this phone.",
                ).forEach { Text("• $it", style = MaterialTheme.typography.bodySmall) }
            }
        }
        OutlinedButton(onClick = { action.run { auth.signOut() } }, enabled = !action.busy, modifier = Modifier.fillMaxWidth()) { Text("Sign out") }
        SectionHeader("Delete account")
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Permanently deletes your account, revokes all Macs, ends cloud sessions and erases stored credentials. This cannot be undone.", style = MaterialTheme.typography.bodySmall)
                OutlinedTextField(
                    value = password,
                    onValueChange = { password = it },
                    label = { Text("Confirm with your password") },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    modifier = Modifier.fillMaxWidth(),
                )
                action.error?.let { Notice(it, NoticeTone.DANGER) }
                OutlinedButton(onClick = { confirmDelete = true }, enabled = password.isNotEmpty() && !action.busy) { Text("Delete my account", color = CodeBridgeTheme.colors.danger) }
            }
        }
    }
    if (confirmDelete) {
        ConfirmDialog("Delete account?", "This permanently deletes everything.", "Delete", onConfirm = { action.run { auth.deleteAccount(password) } }, onDismiss = { confirmDelete = false })
    }
}
