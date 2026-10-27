package dev.codebridge.app

import android.app.Application
import dev.codebridge.app.data.KeystoreTokenStore
import dev.codebridge.core.ApiClient
import dev.codebridge.core.RealtimeClient
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import okhttp3.OkHttpClient

/** Process-wide singletons: one HTTP client, one API client, one relay socket. */
class AppContainer(app: Application) {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .pingInterval(20, TimeUnit.SECONDS)
        .build()
    val apiUrl: String = BuildConfig.API_URL
    val api = ApiClient(apiUrl, KeystoreTokenStore(app), http)
    val realtime = RealtimeClient(apiUrl.replaceFirst("http", "ws") + "/v1/client/ws", { api.freshAccessToken() }, http, scope)
    val isInsecure: Boolean = !apiUrl.startsWith("https://")
}

class CodeBridgeApplication : Application() {
    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
    }
}
