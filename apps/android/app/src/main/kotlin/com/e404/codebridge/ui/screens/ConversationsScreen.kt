package com.e404.codebridge.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.navigation.NavController
import com.e404.codebridge.ui.LocalContainer
import com.e404.codebridge.ui.Routes
import com.e404.codebridge.ui.components.EmptyState
import com.e404.codebridge.ui.components.LoadContent
import com.e404.codebridge.ui.components.Notice
import com.e404.codebridge.ui.components.NoticeTone
import com.e404.codebridge.ui.rememberAction
import com.e404.codebridge.ui.rememberLoad
import com.e404.codebridge.ui.theme.CodeBridgeTheme
import dev.codebridge.core.CreateLocalSession
import dev.codebridge.core.SavedConversation
import dev.codebridge.core.SessionMode
import dev.codebridge.core.timeAgo
import java.time.Instant

/**
 * Earlier Claude Code conversations saved on the computer for one project (from a terminal, the desktop app or this
 * app). Pick one to carry on from the phone, either in place or as a copy that leaves the original untouched.
 */
@Composable
fun ConversationsScreen(nav: NavController, deviceId: String, workspaceId: String) {
    val api = LocalContainer.current.api
    val items = rememberLoad(deviceId, workspaceId) { api.savedConversations(deviceId, workspaceId) }
    val action = rememberAction()
    var picked by remember { mutableStateOf<SavedConversation?>(null) }

    // A conversation touched in the last few minutes may still be open in a terminal.
    fun maybeOpen(c: SavedConversation) = runCatching { System.currentTimeMillis() - Instant.parse(c.lastActiveAt).toEpochMilli() < 600_000 }.getOrDefault(false)

    fun start(c: SavedConversation, asCopy: Boolean) = action.run {
        val s = api.createLocalSession(
            deviceId,
            CreateLocalSession(workspaceId = workspaceId, mode = SessionMode.CLAUDE_CODE, resumeId = c.id, resumeAsCopy = asCopy, resumeTitle = c.title),
        )
        nav.navigate(Routes.session(s.id)) { popUpTo(Routes.CONVERSATIONS) { inclusive = true } }
    }

    ScreenScaffold("Continue", nav) {
        Text(
            "Conversations saved on this computer for this project. Continuing one keeps everything Claude already knows about it.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        action.error?.let { Notice(it, NoticeTone.DANGER) }
        LoadContent(items) { list ->
            if (list.isEmpty()) EmptyState("No saved conversations", "Start a Claude Code session in this project first.")
            list.forEach { c ->
                Card(onClick = { picked = c }, modifier = Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(c.title, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold, maxLines = 3)
                        Text(
                            timeAgo(c.lastActiveAt) + if (maybeOpen(c)) " · may be open on the computer" else "",
                            style = MaterialTheme.typography.bodySmall,
                            color = if (maybeOpen(c)) CodeBridgeTheme.colors.warning else MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        }
    }
    picked?.let { c ->
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { picked = null },
            title = { Text(c.title, maxLines = 3) },
            text = {
                Text(
                    if (maybeOpen(c)) "This conversation was used a moment ago and may still be open in a terminal. A copy is safer: the original stays as it is."
                    else "A copy leaves the original conversation unchanged.",
                )
            },
            confirmButton = {
                Column(horizontalAlignment = androidx.compose.ui.Alignment.End) {
                    TextButton(onClick = { picked = null; start(c, asCopy = true) }) { Text("Continue as a copy") }
                    TextButton(onClick = { picked = null; start(c, asCopy = false) }) { Text("Continue this conversation") }
                    TextButton(onClick = { picked = null }) { Text("Cancel") }
                }
            },
        )
    }
}
