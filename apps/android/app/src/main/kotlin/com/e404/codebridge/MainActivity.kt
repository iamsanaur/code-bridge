package com.e404.codebridge

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.mutableStateOf
import com.e404.codebridge.ui.CodeBridgeApp
import com.e404.codebridge.ui.theme.CodeBridgeTheme
import dev.codebridge.core.ConnectLink
import dev.codebridge.core.codeFromQr
import dev.codebridge.core.parseConnectLink

class MainActivity : ComponentActivity() {
    /** A pairing code delivered by a `codebridge://pair?code=…` link. */
    private val pendingPairCode = mutableStateOf<String?>(null)

    /** A relay link delivered by a `codebridge://connect?…` intent, to be confirmed by the user. */
    private val pendingConnect = mutableStateOf<ConnectLink?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        handle(intent)
        val container = (application as CodeBridgeApplication).container
        setContent {
            CodeBridgeTheme {
                CodeBridgeApp(
                    container,
                    pendingPairCode.value,
                    { pendingPairCode.value = null },
                    pendingConnect.value,
                    { pendingConnect.value = null },
                )
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
        parseConnectLink(data)?.let { pendingConnect.value = it } ?: codeFromQr(data)?.let { pendingPairCode.value = it }
    }
}
