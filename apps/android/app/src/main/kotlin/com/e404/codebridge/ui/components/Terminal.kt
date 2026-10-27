package com.e404.codebridge.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.ContentPaste
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SmallFloatingActionButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import com.e404.codebridge.ui.theme.CodeBridgeTheme
import com.e404.codebridge.ui.theme.Mono
import com.e404.codebridge.ui.theme.TerminalTextStyle
import dev.codebridge.core.TermSegment
import kotlinx.coroutines.launch

@Composable
private fun lineText(line: List<TermSegment>): AnnotatedString {
    val ansi = CodeBridgeTheme.colors.ansi
    return buildAnnotatedString {
        if (line.isEmpty()) append(" ")
        for (seg in line) {
            val color = if (seg.style.fg in ansi.indices) ansi[seg.style.fg] else androidx.compose.ui.graphics.Color.Unspecified
            withStyle(SpanStyle(color = color, fontWeight = if (seg.style.bold) FontWeight.Bold else null)) { append(seg.text) }
        }
    }
}

/**
 * Live terminal output. Follows new output while you're at the bottom; scroll up to
 * read history and a "Latest" button appears. Text is selectable for copying.
 */
@Composable
fun TerminalOutput(lines: List<List<TermSegment>>, revision: Long, dropped: Int, modifier: Modifier = Modifier) {
    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()
    val atBottom by remember {
        derivedStateOf {
            val info = listState.layoutInfo
            val last = info.visibleItemsInfo.lastOrNull()?.index ?: 0
            last >= info.totalItemsCount - 2
        }
    }
    var follow by remember { mutableStateOf(true) }
    LaunchedEffect(atBottom) { follow = atBottom }
    LaunchedEffect(revision) { if (follow && lines.isNotEmpty()) listState.scrollToItem(lines.lastIndex) }

    Box(modifier.background(CodeBridgeTheme.colors.terminalBackground, MaterialTheme.shapes.medium).semantics { contentDescription = "Terminal output" }) {
        SelectionContainer {
            LazyColumn(state = listState, modifier = Modifier.fillMaxSize().padding(8.dp)) {
                if (dropped > 0) item { Text("$dropped earlier lines trimmed", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.outline) }
                itemsIndexed(lines) { _, line ->
                    Text(lineText(line), style = TerminalTextStyle, color = CodeBridgeTheme.colors.terminalText)
                }
            }
        }
        if (!follow) {
            SmallFloatingActionButton(
                onClick = { follow = true; scope.launch { if (lines.isNotEmpty()) listState.animateScrollToItem(lines.lastIndex) } },
                modifier = Modifier.align(Alignment.BottomEnd).padding(12.dp),
            ) { Icon(Icons.Default.KeyboardArrowDown, contentDescription = "Jump to latest output") }
        }
    }
}

private data class Key(val label: String, val data: String, val description: String)

private val Keys = listOf(
    Key("Esc", "\u001b", "Escape"), Key("Tab", "\t", "Tab"), Key("^C", "\u0003", "Control C"), Key("^D", "\u0004", "Control D"),
    Key("↑", "\u001b[A", "Up arrow"), Key("↓", "\u001b[B", "Down arrow"), Key("←", "\u001b[D", "Left arrow"), Key("→", "\u001b[C", "Right arrow"),
    Key("|", "|", "Pipe"), Key("~", "~", "Tilde"), Key("/", "/", "Slash"),
)

/** Input line plus a special-key bar. Disabled with a stated reason when input isn't possible. */
@Composable
fun TerminalInput(onSend: (String) -> Unit, disabledReason: String?) {
    var text by remember { mutableStateOf("") }
    val clipboard = LocalClipboardManager.current
    val enabled = disabledReason == null
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Keys.forEach { k ->
                FilledTonalButton(
                    onClick = { onSend(k.data) },
                    enabled = enabled,
                    modifier = Modifier.heightIn(min = 40.dp).semantics { contentDescription = "Send ${k.description}" },
                ) { Text(k.label, fontFamily = Mono) }
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                value = text,
                onValueChange = { text = it },
                enabled = enabled,
                singleLine = true,
                placeholder = { Text(disabledReason ?: "Type a line and press send") },
                textStyle = TerminalTextStyle,
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, imeAction = ImeAction.Send),
                keyboardActions = KeyboardActions(onSend = { onSend(text + "\r"); text = "" }),
                modifier = Modifier.weight(1f),
            )
            IconButton(onClick = { text += clipboard.getText()?.text.orEmpty() }, enabled = enabled) {
                Icon(Icons.Default.ContentPaste, contentDescription = "Paste from clipboard")
            }
            IconButton(onClick = { onSend(text + "\r"); text = "" }, enabled = enabled) {
                Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "Send line")
            }
        }
    }
}

