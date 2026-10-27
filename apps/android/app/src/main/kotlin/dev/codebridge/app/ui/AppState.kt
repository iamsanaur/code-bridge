package dev.codebridge.app.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import dev.codebridge.app.AppContainer
import dev.codebridge.core.User
import kotlinx.coroutines.launch

val LocalContainer = staticCompositionLocalOf<AppContainer> { error("AppContainer not provided") }

/** Signed-in state for the whole app. */
class AuthState(private val container: AppContainer) {
    var ready by mutableStateOf(false)
        private set
    var user by mutableStateOf<User?>(null)
        private set

    suspend fun restore() {
        try {
            if (container.api.restore()) user = container.api.me()
        } catch (_: Exception) {
            // expired or offline: stay signed out
        } finally {
            ready = true
        }
        if (user != null) container.realtime.start()
    }

    suspend fun signIn(email: String, password: String) = finish(container.api.signIn(email, password))
    suspend fun register(email: String, password: String) = finish(container.api.register(email, password))

    private fun finish(u: User) {
        user = u
        container.realtime.start()
    }

    suspend fun signOut() {
        container.api.signOut()
        signedOutLocally()
    }

    suspend fun deleteAccount(password: String) {
        container.api.deleteAccount(password)
        signedOutLocally()
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
