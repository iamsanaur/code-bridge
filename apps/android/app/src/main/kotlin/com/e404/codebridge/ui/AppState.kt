package com.e404.codebridge.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import com.e404.codebridge.AppContainer
import dev.codebridge.core.ConnectLink
import dev.codebridge.core.RelayConnection
import dev.codebridge.core.User
import dev.codebridge.core.verifyPersonalRelay
import okhttp3.HttpUrl.Companion.toHttpUrl
import kotlinx.coroutines.launch

val LocalContainer = staticCompositionLocalOf<AppContainer> { error("AppContainer not provided") }

/**
 * Connection state for the whole app. Personal relay (the normal case): the phone holds the owner secret from
 * the QR code, there is no account, and a lost or expired session reconnects silently with that secret.
 */
class AuthState(private val container: AppContainer) {
    var ready by mutableStateOf(false)
        private set
    var user by mutableStateOf<User?>(null)
        private set

    /** A scanned or opened `codebridge://connect?…` link, waiting for the user to confirm the relay. */
    var pendingConnect by mutableStateOf<ConnectLink?>(null)

    val isPersonal: Boolean get() = container.relay != null

    suspend fun restore() {
        val saved = container.relayStore.load()
        container.relay = saved
        if (saved != null) container.use(saved.server)
        try {
            if (container.api.restore()) user = container.api.me()
        } catch (_: Exception) {
            // expired or offline: fall through to the silent reconnect
        }
        if (user == null && saved != null) user = runCatching { container.api.connect(saved.secret) }.getOrNull()
        ready = true
        if (user != null) container.realtime.start()
    }

    /** Connects to the relay named in a link the user has confirmed. */
    suspend fun connect(link: ConnectLink) {
        verifyPersonalRelay(link.server, container.http)
        container.use(link.server)
        container.api.clearTokens()
        val u = container.api.connect(link.secret)
        val relay = RelayConnection(link.server, link.secret)
        container.relayStore.save(relay)
        container.relay = relay
        finish(u)
    }

    /** Forgets the relay and returns to the welcome screen. */
    suspend fun disconnect() {
        runCatching { container.api.signOut() }
        container.relayStore.clear()
        container.relay = null
        signedOutLocally()
        container.useDefault()
    }

    // Shared relay with email accounts.
    suspend fun useSharedRelay(address: String) {
        val url = address.trim().trimEnd('/')
        if (runCatching { url.toHttpUrl() }.isFailure) throw IllegalArgumentException("Enter the relay address, like https://relay.example.com")
        container.use(url)
    }

    suspend fun signIn(email: String, password: String) = finish(container.api.signIn(email, password))
    suspend fun register(email: String, password: String) = finish(container.api.register(email, password))

    private fun finish(u: User) {
        user = u
        container.realtime.start()
    }

    suspend fun signOut() {
        if (isPersonal) return disconnect()
        container.api.signOut()
        signedOutLocally()
    }

    suspend fun deleteAccount(password: String) {
        container.api.deleteAccount(password)
        signedOutLocally()
    }

    /** The session ended (refresh rejected, relay data wiped). A personal relay signs back in by itself. */
    fun sessionLost() {
        val relay = container.relay
        if (relay == null) return signedOutLocally()
        container.scope.launch {
            if (runCatching { container.api.connect(relay.secret) }.isFailure) signedOutLocally()
        }
    }

    fun signedOutLocally() {
        container.realtime.stop()
        user = null
    }
}

/** Result of an async load, rendered by [LoadContent]. */
sealed interface Load<out T> {
    data object Loading : Load<Nothing>
    data class Failed(val error: Throwable) : Load<Nothing>
    data class Ready<T>(val value: T) : Load<T>
}

class LoadHandle<T>(initial: Load<T>, private val reload: () -> Unit) {
    var state by mutableStateOf(initial)
        internal set
    var refreshing by mutableStateOf(false)
        internal set
    fun refresh() = reload()
    val value: T? get() = (state as? Load.Ready<T>)?.value
}

/** Loads data with loading/error states; [refresh] re-runs the loader keeping old data visible. */
@Composable
fun <T> rememberLoad(vararg keys: Any?, loader: suspend () -> T): LoadHandle<T> {
    var generation by remember(*keys) { mutableIntStateOf(0) }
    val handle = remember(*keys) { LoadHandle<T>(Load.Loading) { generation++ } }
    LaunchedEffect(handle, generation) {
        handle.refreshing = handle.state is Load.Ready
        handle.state = try {
            Load.Ready(loader())
        } catch (e: Exception) {
            // A failed refresh keeps the data already on screen; a failed first load shows the error.
            if (handle.state is Load.Ready) handle.state else Load.Failed(e)
        }
        handle.refreshing = false
    }
    return handle
}

/** Runs a suspending action with busy/error state, for buttons. */
class Action(private val scope: kotlinx.coroutines.CoroutineScope) {
    var busy by mutableStateOf(false)
        private set
    var error by mutableStateOf<String?>(null)

    fun run(block: suspend () -> Unit) {
        if (busy) return
        busy = true
        error = null
        scope.launch {
            try {
                block()
            } catch (e: Exception) {
                error = e.message ?: "Something went wrong"
            } finally {
                busy = false
            }
        }
    }
}

@Composable
fun rememberAction(): Action {
    val scope = rememberCoroutineScope()
    return remember { Action(scope) }
}
