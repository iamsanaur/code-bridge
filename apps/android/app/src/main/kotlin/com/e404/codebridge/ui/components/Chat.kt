package com.e404.codebridge.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.heightIn
import androidx.compose.material.icons.filled.Close
import androidx.compose.runtime.produceState
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.sp
import dev.codebridge.core.ImageRefs
import dev.codebridge.core.MessageBlocks
import dev.codebridge.core.ToolDisplay
import kotlinx.coroutines.delay
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
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
import com.e404.codebridge.ui.theme.CodeBridgeTheme
import com.e404.codebridge.ui.theme.Mono
import dev.codebridge.core.ChatItem
import dev.codebridge.core.PendingApproval

/** Where chat images come from: the session's computer and project. Null for sessions with no project (cloud). */
class ImageSource(val scope: String, val load: suspend (String) -> ByteArray)

val LocalImageSource = androidx.compose.runtime.compositionLocalOf<ImageSource?> { null }

private val imageCache = object : android.util.LruCache<String, androidx.compose.ui.graphics.ImageBitmap>(24) {}

/** A screenshot or picture that Claude saved or read in the project, fetched from the computer on demand. */
@Composable
private fun ChatImage(path: String) {
    val source = LocalImageSource.current ?: return
    val key = source.scope + "|" + path
    val name = path.substringAfterLast('/')
    var enlarged by remember { mutableStateOf(false) }
    val state by produceState<Result<androidx.compose.ui.graphics.ImageBitmap>?>(initialValue = imageCache.get(key)?.let { Result.success(it) }, key) {
        if (value == null) {
            value = runCatching {
                val bytes = source.load(path)
                val bmp = android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: error("not a picture")
                bmp.asImageBitmap().also { imageCache.put(key, it) }
            }
        }
    }
    val result = state
    when {
        result == null -> Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp)
            Text(name, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        result.isFailure -> Text(
            "$name: ${(result.exceptionOrNull() as? dev.codebridge.core.ApiException)?.message ?: "could not be loaded"}",
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        else -> {
            val image = result.getOrThrow()
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                androidx.compose.foundation.Image(
                    bitmap = image,
                    contentDescription = "Image $name",
                    contentScale = androidx.compose.ui.layout.ContentScale.Fit,
                    modifier = Modifier.heightIn(max = 260.dp).clip(RoundedCornerShape(12.dp)).clickable(onClickLabel = "Open full screen") { enlarged = true },
                )
                Text(name, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (enlarged) ImageViewer(image, name) { enlarged = false }
        }
    }
}

/** Full-screen picture with pinch to zoom, pan and double-tap to zoom. */
@Composable
private fun ImageViewer(image: androidx.compose.ui.graphics.ImageBitmap, name: String, onClose: () -> Unit) {
    androidx.compose.ui.window.Dialog(
        onDismissRequest = onClose,
        properties = androidx.compose.ui.window.DialogProperties(usePlatformDefaultWidth = false),
    ) {
        var scale by remember { mutableStateOf(1f) }
        var offset by remember { mutableStateOf(androidx.compose.ui.geometry.Offset.Zero) }
        Box(Modifier.fillMaxSize().background(Color.Black)) {
            androidx.compose.foundation.Image(
                bitmap = image,
                contentDescription = "Image $name",
                contentScale = androidx.compose.ui.layout.ContentScale.Fit,
                modifier = Modifier
                    .fillMaxSize()
                    .pointerInput(Unit) {
                        detectTransformGestures { _, pan, zoom, _ ->
                            scale = (scale * zoom).coerceIn(1f, 6f)
                            offset = if (scale == 1f) androidx.compose.ui.geometry.Offset.Zero else offset + pan
                        }
                    }
                    .pointerInput(Unit) {
                        detectTapGestures(onDoubleTap = {
                            scale = if (scale > 1f) 1f else 2.5f
                            offset = androidx.compose.ui.geometry.Offset.Zero
                        })
                    }
                    .graphicsLayer { scaleX = scale; scaleY = scale; translationX = offset.x; translationY = offset.y },
            )
            androidx.compose.material3.IconButton(onClick = onClose, modifier = Modifier.align(Alignment.TopEnd).padding(12.dp)) {
                Icon(Icons.Default.Close, contentDescription = "Close", tint = Color.White)
            }
        }
    }
}

private val ClaudeCoral = Color(0xFFD97757)
private val UserBlue = Color(0xFF2563EB)

/**
 * The conversation, laid out like Claude Code's own apps: your messages as blue bubbles, Claude's replies as plain
 * text under a "Claude" header, and every tool call as a collapsible card (file edits show their changed lines).
 */
@Composable
fun ChatTranscript(items: List<ChatItem>, revision: Long, onRetry: (() -> Unit)?, modifier: Modifier = Modifier, working: Boolean = false) {
    val state = rememberLazyListState()
    val rows = items.size + if (working) 1 else 0
    // Stay on the newest line while text streams in, history loads and pictures arrive, until the reader scrolls up.
    // Jump to the last row and then to the very end of it, because a long reply is taller than the screen.
    var pinned by remember { mutableStateOf(true) }
    LaunchedEffect(state) {
        snapshotFlow { state.isScrollInProgress }.collect { moving -> if (!moving) pinned = !state.canScrollForward }
    }
    LaunchedEffect(state) {
        snapshotFlow { state.layoutInfo.totalItemsCount to state.layoutInfo.visibleItemsInfo.sumOf { it.size } }.collect {
            if (pinned && state.layoutInfo.totalItemsCount > 0) {
                state.scrollToItem(state.layoutInfo.totalItemsCount - 1)
                state.scrollBy(1_000_000f)
            }
        }
    }
    LaunchedEffect(revision, working) {
        if (rows > 0 && pinned) {
            state.scrollToItem(rows - 1)
            state.scrollBy(1_000_000f)
        }
    }
    LazyColumn(state = state, contentPadding = PaddingValues(vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(14.dp), modifier = modifier) {
        if (items.isEmpty()) {
            item {
                Column(Modifier.fillMaxWidth().padding(top = 40.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    ClaudeMark(44)
                    Text("Claude Code", style = MaterialTheme.typography.titleMedium)
                    Text(
                        "Runs on your computer, in this folder. Ask it to read, change or test something.",
                        style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center,
                    )
                }
            }
        }
        itemsIndexed(items, key = { _, it -> it.id }) { index, item ->
            ChatRow(item, startsRun = index == 0 || items[index - 1] is ChatItem.UserMessage, onRetry = onRetry)
        }
        if (working) item(key = "working") { WorkingLine() }
    }
}

@Composable
private fun ClaudeMark(size: Int) {
    Box(Modifier.size(size.dp).clip(RoundedCornerShape((size * 0.28f).dp)).background(ClaudeCoral), contentAlignment = Alignment.Center) {
        Text("✻", color = Color.White, fontSize = (size * 0.55f).sp, fontWeight = FontWeight.Bold)
    }
}

@Composable
private fun ClaudeHeader() {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        ClaudeMark(28)
        Text("Claude", style = MaterialTheme.typography.titleMedium)
    }
}

@Composable
private fun WorkingLine() {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.semantics { contentDescription = "Claude Code is working" }) {
        CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
        Text("Working…", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** Bold, `code` and *italic* spans; everything else stays as typed. */
private fun inlineMarkdown(text: String, codeColor: Color): AnnotatedString = buildAnnotatedString {
    var i = 0
    while (i < text.length) {
        fun span(marker: String, style: SpanStyle): Boolean {
            if (!text.startsWith(marker, i)) return false
            val end = text.indexOf(marker, i + marker.length)
            if (end <= i + marker.length) return false
            withStyle(style) { append(text.substring(i + marker.length, end)) }
            i = end + marker.length
            return true
        }
        if (span("**", SpanStyle(fontWeight = FontWeight.Bold))) continue
        if (span("`", SpanStyle(fontFamily = Mono, background = codeColor.copy(alpha = 0.14f)))) continue
        append(text[i])
        i++
    }
}

@Composable
private fun ChatRow(item: ChatItem, startsRun: Boolean, onRetry: (() -> Unit)?) {
    val c = CodeBridgeTheme.colors
    when (item) {
        is ChatItem.UserMessage -> Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            Surface(color = UserBlue, shape = RoundedCornerShape(20.dp), modifier = Modifier.widthIn(max = 320.dp)) {
                SelectionContainer { Text(item.text, color = Color.White, modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp)) }
            }
        }
        is ChatItem.Assistant -> Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (startsRun) ClaudeHeader()
            val blocks = remember(item.text) { MessageBlocks.split(item.text) }
            SelectionContainer {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    blocks.forEachIndexed { index, block ->
                        if (block.code) {
                            Text(
                                block.text,
                                fontFamily = Mono, fontSize = 13.sp,
                                modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.07f)).padding(10.dp),
                            )
                        } else {
                            val cursor = if (item.streaming && index == blocks.lastIndex) " ▍" else ""
                            Text(inlineMarkdown(block.text, MaterialTheme.colorScheme.onSurface) + AnnotatedString(cursor), style = MaterialTheme.typography.bodyLarge)
                        }
                    }
                }
            }
            remember(item.text) { ImageRefs.paths(item.text) }.forEach { ChatImage(it) }
        }
        is ChatItem.Tool -> Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (startsRun) ClaudeHeader()
            ToolCard(item)
        }
        is ChatItem.Failure -> Card(colors = CardDefaults.cardColors(containerColor = c.danger.copy(alpha = 0.12f)), modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite }) {
            Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(item.code, color = c.danger, style = MaterialTheme.typography.titleSmall)
                SelectionContainer { Text(item.message, style = MaterialTheme.typography.bodySmall) }
                if (item.retryable && onRetry != null) OutlinedButton(onClick = onRetry) { Text("Retry last prompt") }
            }
        }
        is ChatItem.Notice -> Text(item.text, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.outline, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
    }
}

/**
 * One tool call: a card with a coloured edge, collapsed to `Tool / argument`. Edits and writes open to show the lines
 * they changed; other tools show what was asked and what came back.
 */
@Composable
private fun ToolCard(item: ChatItem.Tool) {
    val c = CodeBridgeTheme.colors
    val diff = remember(item.summary) { ToolDisplay.diff(item.summary) }
    var expanded by remember(item.id) { mutableStateOf<Boolean?>(null) }
    val images = remember(item.summary, item.result?.summary) { ImageRefs.forTool(item.summary, item.result?.summary) }
    val open = expanded ?: (diff != null || images.isNotEmpty())
    val result = item.result
    val edge = when {
        result == null -> c.warning
        result.ok -> c.success
        else -> c.danger
    }
    Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min)) {
        Box(Modifier.width(3.dp).fillMaxHeight().background(edge))
        Column(Modifier.padding(start = 10.dp, top = 2.dp, bottom = 2.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(
                Modifier.fillMaxWidth().clickable(onClickLabel = if (open) "Hide details" else "Show details") { expanded = !open },
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Icon(if (open) Icons.Default.KeyboardArrowDown else Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null, modifier = Modifier.size(18.dp), tint = MaterialTheme.colorScheme.outline)
                Text(
                    buildAnnotatedString {
                        withStyle(SpanStyle(fontWeight = FontWeight.Medium)) { append(item.name) }
                        withStyle(SpanStyle(color = MaterialTheme.colorScheme.outline)) { append("  /  ") }
                        withStyle(SpanStyle(fontFamily = Mono, color = if (diff != null) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)) {
                            append(diff?.path?.substringAfterLast('/') ?: ToolDisplay.headline(item.summary) ?: "Details")
                        }
                    },
                    style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
                )
                if (result == null) CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp)
            }
            if (open) {
                val panel = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.06f)
                if (diff != null) {
                    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(panel)) {
                        Text(diff.path, fontFamily = Mono, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.StartEllipsis, modifier = Modifier.padding(8.dp))
                        diff.lines.forEach { l ->
                            val tone = if (l.added) c.success else c.danger
                            Row(Modifier.fillMaxWidth().background(tone.copy(alpha = 0.14f)).padding(horizontal = 8.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                Text(if (l.added) "+" else "−", fontFamily = Mono, fontSize = 12.sp, color = tone)
                                Text(l.text.ifEmpty { " " }, fontFamily = Mono, fontSize = 12.sp)
                            }
                        }
                        if (diff.more > 0) Text("… +${diff.more} more lines", style = MaterialTheme.typography.labelSmall, modifier = Modifier.padding(8.dp))
                    }
                } else {
                    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(panel).padding(10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        SelectionContainer {
                            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                images.forEach { ChatImage(it) }
                                if (images.isEmpty()) Text(item.summary, fontFamily = Mono, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 8, overflow = TextOverflow.Ellipsis)
                                if (result != null) {
                                    val (lines, more) = ToolDisplay.preview(result.summary, maxLines = 12)
                                    val tone = if (result.ok) MaterialTheme.colorScheme.onSurface else c.danger
                                    if (lines.isEmpty()) Text(if (result.ok) "Done" else "Failed", fontFamily = Mono, fontSize = 12.sp, color = tone)
                                    lines.forEach { Text(it, fontFamily = Mono, fontSize = 12.sp, color = tone, maxLines = 3, overflow = TextOverflow.Ellipsis) }
                                    if (more > 0) Text("… +$more lines", fontFamily = Mono, fontSize = 12.sp, color = MaterialTheme.colorScheme.outline)
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

/** The prompt box: a rounded input with a send button. */
@Composable
fun Composer(onSend: (String) -> Unit, disabledReason: String?, busy: Boolean) {
    var text by remember { mutableStateOf("") }
    Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedTextField(
            value = text,
            onValueChange = { text = it },
            enabled = disabledReason == null,
            placeholder = { Text(disabledReason ?: "Ask Claude anything…") },
            shape = RoundedCornerShape(22.dp),
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
