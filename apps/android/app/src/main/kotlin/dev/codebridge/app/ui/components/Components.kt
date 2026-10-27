package dev.codebridge.app.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import dev.codebridge.app.ui.Load
import dev.codebridge.app.ui.LoadHandle
import dev.codebridge.app.ui.theme.CodeBridgeTheme
import dev.codebridge.core.ConnectionStatus
import dev.codebridge.core.SessionKind
import dev.codebridge.core.SessionStatus
import dev.codebridge.core.StatusGroup

@Composable
fun Pill(label: String, color: Color, modifier: Modifier = Modifier) {
    Surface(
        shape = MaterialTheme.shapes.small,
        color = color.copy(alpha = 0.12f),
        border = BorderStroke(1.dp, color.copy(alpha = 0.6f)),
        modifier = modifier.semantics { contentDescription = label },
    ) {
        Row(Modifier.padding(horizontal = 8.dp, vertical = 3.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(7.dp).background(color, CircleShape))
            Text(label, color = color, style = MaterialTheme.typography.labelMedium, modifier = Modifier.padding(start = 6.dp))
        }
    }
}

/** Always shown on sessions so the execution environment is never ambiguous. */
@Composable
fun KindBadge(kind: SessionKind) {
    val c = CodeBridgeTheme.colors
    if (kind == SessionKind.LOCAL) Pill("Local Mac", c.local) else Pill("Managed cloud", c.cloud)
}

@Composable
fun StatusBadge(status: SessionStatus) {
    val c = CodeBridgeTheme.colors
    val color = when (status.group) {
        StatusGroup.RUNNING -> MaterialTheme.colorScheme.primary
        StatusGroup.WAITING -> c.warning
        StatusGroup.COMPLETED -> c.success
        StatusGroup.FAILED -> c.danger
    }
    Pill(status.label, color)
}

@Composable
fun OnlineBadge(online: Boolean) =
    Pill(if (online) "Online" else "Offline", if (online) CodeBridgeTheme.colors.success else MaterialTheme.colorScheme.outline)

@Composable
fun SectionHeader(text: String, modifier: Modifier = Modifier, trailing: (@Composable () -> Unit)? = null) {
    Row(modifier.fillMaxWidth().padding(top = 12.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(
            text.uppercase(),
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.weight(1f).semantics { heading() },
        )
        trailing?.invoke()
    }
}

@Composable
fun Loading(label: String = "Loading…") {
    Column(Modifier.fillMaxWidth().padding(24.dp).semantics { liveRegion = LiveRegionMode.Polite }, horizontalAlignment = Alignment.CenterHorizontally) {
        CircularProgressIndicator()
        Text(label, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 8.dp))
    }
}

@Composable
fun ErrorState(error: Throwable, onRetry: (() -> Unit)?) {
    Column(Modifier.fillMaxWidth().padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Couldn’t load", style = MaterialTheme.typography.titleMedium, color = CodeBridgeTheme.colors.danger)
        Text(error.message ?: "Something went wrong", style = MaterialTheme.typography.bodySmall, textAlign = TextAlign.Center)
        if (onRetry != null) OutlinedButton(onClick = onRetry) { Text("Retry") }
    }
}

@Composable
fun EmptyState(title: String, body: String? = null, action: (@Composable () -> Unit)? = null) {
    Column(Modifier.fillMaxWidth().padding(vertical = 24.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(title, style = MaterialTheme.typography.titleMedium)
        if (body != null) Text(body, style = MaterialTheme.typography.bodySmall, textAlign = TextAlign.Center, color = MaterialTheme.colorScheme.onSurfaceVariant)
        action?.invoke()
    }
}

/** Renders loading / error / content for a [LoadHandle]. */
@Composable
fun <T> LoadContent(handle: LoadHandle<T>, content: @Composable (T) -> Unit) {
    when (val s = handle.state) {
        Load.Loading -> Loading()
        is Load.Failed -> ErrorState(s.error) { handle.refresh() }
        is Load.Ready -> content(s.value)
    }
}

enum class NoticeTone { INFO, WARNING, DANGER }

@Composable
fun Notice(text: String, tone: NoticeTone = NoticeTone.INFO) {
    val color = when (tone) {
        NoticeTone.INFO -> MaterialTheme.colorScheme.primary
        NoticeTone.WARNING -> CodeBridgeTheme.colors.warning
        NoticeTone.DANGER -> CodeBridgeTheme.colors.danger
    }
    Surface(color = color.copy(alpha = 0.10f), shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth()) {
        Row {
            Box(Modifier.size(width = 3.dp, height = 48.dp).background(color))
            Text(text, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(12.dp))
        }
    }
}

@Composable
fun ConnectionBanner(status: ConnectionStatus) {
    val text = when (status) {
        ConnectionStatus.CONNECTING -> "Connecting to CodeBridge…"
        ConnectionStatus.RECONNECTING -> "Reconnecting… live output will resume where it left off."
        ConnectionStatus.OFFLINE -> "Connection lost. Reconnecting…"
        ConnectionStatus.UNAUTHORIZED -> "Your session expired. Sign in again."
        else -> return
    }
    val bad = status == ConnectionStatus.OFFLINE || status == ConnectionStatus.UNAUTHORIZED
    Surface(color = if (bad) CodeBridgeTheme.colors.danger.copy(alpha = 0.18f) else MaterialTheme.colorScheme.secondaryContainer) {
        Text(
            text,
            style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp).semantics { liveRegion = LiveRegionMode.Polite },
        )
    }
}

@Composable
fun ConfirmDialog(title: String, body: String, confirm: String, onConfirm: () -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = { Text(body) },
        confirmButton = {
            Button(onClick = { onDismiss(); onConfirm() }) { Text(confirm, fontWeight = FontWeight.SemiBold) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}
