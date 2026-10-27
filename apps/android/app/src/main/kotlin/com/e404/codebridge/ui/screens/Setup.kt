package com.e404.codebridge.ui.screens

import android.content.Context
import android.content.Intent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.navigation.NavController
import com.e404.codebridge.ui.theme.GlassButton
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning

/** One command per relay option. Each starts the relay, opens its address and joins this computer. */
const val CLOUDFLARE_COMMAND = "npx -y codebridge-relay start --tunnel cloudflare --with-agent"
const val FLY_COMMAND = "npx -y codebridge-relay fly --with-agent"
const val AGENT_INSTALL_COMMAND = "npm install -g codebridge-agent"

/** Google code scanner: Play services shows the camera UI; the app needs no camera permission. */
fun scanQrPayload(context: Context, onPayload: (String) -> Unit, onError: (String) -> Unit) {
    val options = GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build()
    GmsBarcodeScanning.getClient(context, options).startScan()
        .addOnSuccessListener { barcode -> barcode.rawValue?.let(onPayload) ?: onError("That QR code is empty.") }
        .addOnFailureListener { onError("Scanner unavailable: ${it.message}. Paste the link instead.") }
}

fun shareText(context: Context, text: String) {
    val send = Intent(Intent.ACTION_SEND).apply {
        type = "text/plain"
        putExtra(Intent.EXTRA_TEXT, text)
    }
    context.startActivity(Intent.createChooser(send, "Send to your computer"))
}

/** A titled command the user can select, copy, or send to their computer (AirDrop-style share sheet). */
@Composable
fun CommandCard(title: String, command: String, shareLabel: String = "Send to my computer") {
    val clipboard = LocalClipboardManager.current
    val context = LocalContext.current
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(title, style = MaterialTheme.typography.titleSmall)
            Surface(color = MaterialTheme.colorScheme.surfaceVariant, shape = MaterialTheme.shapes.small) {
                SelectionContainer {
                    Text(command, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(10.dp).fillMaxWidth())
                }
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Button(onClick = { clipboard.setText(AnnotatedString(command)) }, modifier = Modifier.weight(1f).heightIn(min = 48.dp)) { Text("Copy") }
                OutlinedButton(onClick = { shareText(context, command) }, modifier = Modifier.weight(1.6f).heightIn(min = 48.dp)) { Text(shareLabel) }
            }
        }
    }
}

/**
 * Set up a relay in one step. A phone can't start a tunnel on a computer it isn't connected to yet, so this
 * gives one command per option to run on the computer (or send there), then the user scans the QR it shows.
 */
@Composable
fun SetupRelayScreen(nav: NavController, onScanned: (String) -> Unit) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val action = com.e404.codebridge.ui.rememberAction()
    ScreenScaffold("Set up a relay", nav) {
        Text(
            "Your relay links this phone to your computers. You run it yourself, so there is no account and nothing is hosted for you. One command starts it, opens a secure address, joins that computer and shows a QR code.",
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        CommandCard("Free: public address through Cloudflare (needs Node.js 22+ and cloudflared)", CLOUDFLARE_COMMAND)
        CommandCard("Permanent: your own Fly.io account, about $2 a month (needs flyctl)", FLY_COMMAND)
        Text(
            "Run it in a terminal on your Mac or PC. Use Send to my computer to message the command to yourself. The relay prints a QR code. Scan it here.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        GlassButton("Scan the QR code", onClick = { scanQrPayload(context, onScanned, onError = { action.error = it }) }, prominent = true, modifier = Modifier.fillMaxWidth())
        action.error?.let { com.e404.codebridge.ui.components.Notice(it, com.e404.codebridge.ui.components.NoticeTone.DANGER) }
    }
}
