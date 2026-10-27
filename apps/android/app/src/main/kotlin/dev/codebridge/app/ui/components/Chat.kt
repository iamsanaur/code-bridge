package dev.codebridge.app.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
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
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import dev.codebridge.app.ui.theme.CodeBridgeTheme
import dev.codebridge.app.ui.theme.Mono
import dev.codebridge.core.ChatItem
import dev.codebridge.core.PendingApproval

@Composable
fun ChatTranscript(items: List<ChatItem>, revision: Long, onRetry: (() -> Unit)?, modifier: Modifier = Modifier) {
    val state = rememberLazyListState()
    LaunchedEffect(revision) { if (items.isNotEmpty()) state.animateScrollToItem(items.lastIndex) }
    if (items.isEmpty()) {
        Text("Send a prompt to start.", style = MaterialTheme.typography.bodySmall, textAlign = TextAlign.Center, modifier = modifier.fillMaxWidth().padding(24.dp))
        return
    }
    LazyColumn(state = state, modifier = modifier, verticalArrangement = Arrangement.spacedBy(12.dp)) {
        items(items, key = { it.id }) { item -> ChatRow(item, onRetry) }
    }
}

@Composable
private fun ChatRow(item: ChatItem, onRetry: (() -> Unit)?) {
    val c = CodeBridgeTheme.colors
    when (item) {
        is ChatItem.UserMessage -> Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            Surface(color = MaterialTheme.colorScheme.primaryContainer, shape = MaterialTheme.shapes.large, modifier = Modifier.widthIn(max = 320.dp)) {
                SelectionContainer { Text(item.text, modifier = Modifier.padding(12.dp)) }
            }
        }
        is ChatItem.Assistant -> SelectionContainer {
            Text(item.text + if (item.streaming) " ▍" else "", style = MaterialTheme.typography.bodyLarge)
        }
        is ChatItem.Tool -> {
            val result = item.result
            val color = when {
                result == null -> c.warning
                result.ok -> c.success
                else -> c.danger
            }
            Row {
                Surface(color = color, modifier = Modifier.padding(end = 8.dp).widthIn(min = 2.dp, max = 2.dp)) { Text(" ") }
                Column {
                    Text("${if (result == null) "…" else if (result.ok) "✓" else "✕"} ${item.name}", fontFamily = Mono, color = color, style = MaterialTheme.typography.labelMedium)
                    Text(result?.summary ?: item.summary, fontFamily = Mono, style = MaterialTheme.typography.bodySmall, maxLines = 3, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
        is ChatItem.Failure -> Card(colors = CardDefaults.cardColors(containerColor = c.danger.copy(alpha = 0.12f)), modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite }) {
            Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(item.code, color = c.danger, style = MaterialTheme.typography.titleSmall)
                Text(item.message, style = MaterialTheme.typography.bodySmall)
                if (item.retryable && onRetry != null) OutlinedButton(onClick = onRetry) { Text("Retry last prompt") }
            }
        }
        is ChatItem.Notice -> Text(item.text, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.outline, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
    }
}

@Composable
fun Composer(onSend: (String) -> Unit, disabledReason: String?, busy: Boolean) {
    var text by remember { mutableStateOf("") }
    Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedTextField(
            value = text,
            onValueChange = { text = it },
            enabled = disabledReason == null,
            placeholder = { Text(disabledReason ?: "Ask the agent to change, test or explain something…") },
            maxLines = 6,
            modifier = Modifier.weight(1f),
        )
        Button(onClick = { onSend(text.trim()); text = "" }, enabled = disabledReason == null && text.isNotBlank() && !busy) { Text("Send") }
    }
}

/** A tool waiting for the user's decision. Nothing runs until Approve is pressed. */
@Composable
fun ApprovalCard(approval: PendingApproval, busy: Boolean, onDecide: (Boolean) -> Unit) {
    val c = CodeBridgeTheme.colors
    val color = when (approval.risk) {
        "high" -> c.danger
        "medium" -> c.warning
        else -> c.success
    }
    var expanded by remember { mutableStateOf(false) }
    Card(border = BorderStroke(1.dp, color), modifier = Modifier.fillMaxWidth().semantics { liveRegion = LiveRegionMode.Assertive }) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("APPROVAL NEEDED · ${approval.risk.uppercase()} RISK", color = color, style = MaterialTheme.typography.labelMedium)
            Text(approval.title, style = MaterialTheme.typography.titleMedium)
            SelectionContainer {
                Text(approval.detail, fontFamily = Mono, style = MaterialTheme.typography.bodySmall, maxLines = if (expanded) Int.MAX_VALUE else 8)
            }
            TextButton(onClick = { expanded = !expanded }) { Text(if (expanded) "Show less" else "Show full details") }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = { onDecide(false) }, enabled = !busy, modifier = Modifier.weight(1f)) { Text("Reject") }
                Button(onClick = { onDecide(true) }, enabled = !busy, modifier = Modifier.weight(1f)) { Text("Approve") }
            }
        }
    }
}
