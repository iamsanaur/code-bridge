package dev.codebridge.app

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.mutableStateOf
import dev.codebridge.app.ui.CodeBridgeApp
import dev.codebridge.app.ui.theme.CodeBridgeTheme
import dev.codebridge.core.codeFromQr

class MainActivity : ComponentActivity() {
    /** A pairing code delivered by a `codebridge://pair?code=…` link. */
    private val pendingPairCode = mutableStateOf<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        handle(intent)
        val container = (application as CodeBridgeApplication).container
        setContent {
            CodeBridgeTheme {
                CodeBridgeApp(container, pendingPairCode.value) { pendingPairCode.value = null }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    override fun onStart() {
        super.onStart()
        (application as CodeBridgeApplication).container.realtime.nudge()
    }

    private fun handle(intent: Intent?) {
        val data = intent?.dataString ?: return
        codeFromQr(data)?.let { pendingPairCode.value = it }
    }
}
