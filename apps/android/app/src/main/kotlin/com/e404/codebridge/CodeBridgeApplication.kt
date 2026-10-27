package com.e404.codebridge

import android.app.Application
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.e404.codebridge.data.KeystoreRelayStore
import com.e404.codebridge.data.KeystoreTokenStore
import dev.codebridge.core.ApiClient
import dev.codebridge.core.RealtimeClient
import dev.codebridge.core.RelayConnection
import dev.codebridge.core.makeConnectLink
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import okhttp3.OkHttpClient

/**
 * Process-wide singletons: one HTTP client, and the API client and relay socket for the relay this phone is
 * connected to. Joining another relay replaces the API client and socket.
 */
class AppContainer(private val app: Application) {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .pingInterval(20, TimeUnit.SECONDS)
        .build()
    val relayStore = KeystoreRelayStore(app)
    private val defaultUrl: String = BuildConfig.API_URL

    var apiUrl: String by mutableStateOf(defaultUrl)
        private set
    var api: ApiClient = ApiClient(defaultUrl, KeystoreTokenStore(app), http)
        private set
    var realtime: RealtimeClient = realtimeFor(defaultUrl, api)
        private set

    /** Set once this phone is connected to a personal relay. */
    var relay: RelayConnection? by mutableStateOf(null)

    /** Called when the server rejects the refresh token. Re-applied whenever the API client is replaced. */
    var onSignedOut: (() -> Unit)? = null
        set(value) {
            field = value
            api.onSignedOut = value
        }

    val isInsecure: Boolean get() = !apiUrl.startsWith("https://")

    /** The command that joins a computer to this relay. It contains the owner secret: show it only to the owner. */
    val agentConnectCommand: String?
        get() = relay?.let { "codebridge-agent connect '${makeConnectLink(it.server, it.secret)}'" }

    private fun realtimeFor(url: String, client: ApiClient) =
        RealtimeClient(url.replaceFirst("http", "ws") + "/v1/client/ws", { client.freshAccessToken() }, http, scope)

    fun use(server: String) {
        realtime.stop()
        apiUrl = server
        api = ApiClient(server, KeystoreTokenStore(app), http).also { it.onSignedOut = onSignedOut }
        realtime = realtimeFor(server, api)
    }

    fun useDefault() = use(defaultUrl)
}

class CodeBridgeApplication : Application() {
    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
    }
}
