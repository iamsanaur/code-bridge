package dev.codebridge.core

import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import kotlin.math.min
import kotlin.math.pow
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

enum class ConnectionStatus { IDLE, CONNECTING, CONNECTED, RECONNECTING, OFFLINE, UNAUTHORIZED }

/** Messages from the relay to the app (`serverToClientSchema` in packages/protocol). */
sealed interface ServerMessage {
    data class AuthOk(val userId: String) : ServerMessage
    data class Event(val event: SequencedEvent) : ServerMessage
    data class ReplayGap(val sessionId: String, val resumeFromSeq: Int) : ServerMessage
    data class CommandAck(val commandId: String, val ok: Boolean, val error: CommandError?) : ServerMessage
    data class DeviceStatus(val deviceId: String, val online: Boolean, val lastSeenAt: String?) : ServerMessage
    data class SessionStatusChanged(val sessionId: String, val status: SessionStatus, val exitCode: Int?) : ServerMessage
    data class Error(val code: String, val message: String) : ServerMessage
    data object Pong : ServerMessage

    companion object {
        /** Parses one frame; returns null for invalid or unknown frames (never throws). */
        fun parse(text: String): ServerMessage? = runCatching {
            val o = ProtocolJson.parseToJsonElement(text).jsonObject
            fun s(k: String) = o[k]?.jsonPrimitive?.content
            when (s("type")) {
                "auth.ok" -> AuthOk(s("userId")!!)
                "event" -> Event(
                    SequencedEvent(
                        sessionId = s("sessionId")!!,
                        seq = o["seq"]!!.jsonPrimitive.intOrNull!!,
                        ts = s("ts") ?: "",
                        event = ProtocolJson.decodeFromJsonElement(SessionEvent.serializer(), o["event"]!!),
                    ),
                )
                "replay.gap" -> ReplayGap(s("sessionId")!!, o["resumeFromSeq"]!!.jsonPrimitive.intOrNull!!)
                "command.ack" -> CommandAck(
                    s("commandId")!!,
                    o["ok"]!!.jsonPrimitive.booleanOrNull!!,
                    o["error"]?.let { ProtocolJson.decodeFromJsonElement<CommandError>(it) },
                )
                "device.status" -> DeviceStatus(s("deviceId")!!, o["online"]!!.jsonPrimitive.booleanOrNull!!, o["lastSeenAt"]?.jsonPrimitive?.content?.takeIf { it != "null" })
                "session.status" -> SessionStatusChanged(
                    s("sessionId")!!,
                    ProtocolJson.decodeFromJsonElement(SessionStatus.serializer(), o["status"]!!),
                    o["exitCode"]?.jsonPrimitive?.intOrNull,
                )
                "error" -> Error(s("code") ?: "error", s("message") ?: "")
                "pong" -> Pong
                else -> null
            }
        }.getOrNull()
    }
}

/** Low-risk, high-frequency operations the app sends over the socket. */
sealed interface TerminalCommand {
    val sessionId: String
    data class Input(override val sessionId: String, val data: String) : TerminalCommand
    data class Resize(override val sessionId: String, val cols: Int, val rows: Int) : TerminalCommand
    data class Signal(override val sessionId: String, val terminate: Boolean) : TerminalCommand
}

data class CommandResult(val ok: Boolean, val error: CommandError? = null)

/** Exponential backoff with full jitter. */
fun backoffDelayMs(attempt: Int, baseMs: Long = 500, maxMs: Long = 15_000, random: () -> Double = Math::random): Long {
    val cap = min(maxMs.toDouble(), baseMs * 2.0.pow(min(attempt, 16)))
    return (random() * cap).toLong()
}

/**
 * One multiplexed WebSocket to the relay. Authenticates with the first frame (the
 * token never goes in the URL), reconnects with jittered backoff and, after every
 * (re)connect, re-subscribes each session from the last event the app applied.
 */
class RealtimeClient(
    private val url: String,
    private val tokenProvider: suspend () -> String?,
    private val http: OkHttpClient,
    private val scope: CoroutineScope,
    private val random: () -> Double = Math::random,
) {
    private val _status = MutableStateFlow(ConnectionStatus.IDLE)
    val status: StateFlow<ConnectionStatus> = _status
    private val _messages = MutableSharedFlow<ServerMessage>(extraBufferCapacity = 4096)
    val messages: SharedFlow<ServerMessage> = _messages

    private val subscriptions = ConcurrentHashMap<String, () -> Int>()
    private val acks = ConcurrentHashMap<String, CompletableDeferred<CommandResult>>()
    @Volatile private var socket: WebSocket? = null
    @Volatile private var authenticated = false
    @Volatile private var stopped = true
    private var attempt = 0
    private var reconnectJob: Job? = null
    private var pingJob: Job? = null

    fun start() {
        if (!stopped) return
        stopped = false
        connect()
    }

    fun stop() {
        stopped = true
        reconnectJob?.cancel()
        pingJob?.cancel()
        socket?.close(1000, "client stopping")
        socket = null
        _status.value = ConnectionStatus.IDLE
    }

    /** Reconnect now (e.g. the app returned to the foreground). */
    fun nudge() {
        if (stopped || _status.value == ConnectionStatus.CONNECTED || _status.value == ConnectionStatus.CONNECTING) return
        reconnectJob?.cancel()
        attempt = 0
        connect()
    }

    private fun connect() {
        if (stopped) return
        _status.value = if (attempt == 0) ConnectionStatus.CONNECTING else ConnectionStatus.RECONNECTING
        scope.launch {
            val token = tokenProvider()
            if (token == null) {
                _status.value = ConnectionStatus.UNAUTHORIZED
                return@launch
            }
            authenticated = false
            socket = http.newWebSocket(Request.Builder().url(url).build(), Listener(token))
        }
    }

    private inner class Listener(private val token: String) : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            webSocket.send(buildJsonObject { put("type", "auth"); put("token", token) }.toString())
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            if (webSocket !== socket) return
            val msg = ServerMessage.parse(text) ?: return
            when (msg) {
                is ServerMessage.AuthOk -> {
                    authenticated = true
                    attempt = 0
                    _status.value = ConnectionStatus.CONNECTED
                    subscriptions.forEach { (sessionId, lastSeq) -> sendSubscribe(sessionId, lastSeq()) }
                    pingJob?.cancel()
                    pingJob = scope.launch {
                        while (true) {
                            delay(25_000)
                            send(buildJsonObject { put("type", "ping"); put("ts", System.currentTimeMillis()) })
                        }
                    }
                }
                is ServerMessage.CommandAck -> acks.remove(msg.commandId)?.complete(CommandResult(msg.ok, msg.error))
                else -> Unit
            }
            _messages.tryEmit(msg)
        }

        // The server initiated a close: acknowledge it and treat the connection as dropped.
        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(1000, null)
            dropped(webSocket, code)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = dropped(webSocket, code)

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = dropped(webSocket, 1006)
    }

    private fun dropped(webSocket: WebSocket, code: Int) {
        if (webSocket !== socket) return
        socket = null
        authenticated = false
        pingJob?.cancel()
        if (stopped) return
        if (code == 4401 && attempt > 1) {
            // The token keeps being rejected even after a refresh attempt.
            _status.value = ConnectionStatus.UNAUTHORIZED
            return
        }
        _status.value = ConnectionStatus.OFFLINE
        val wait = backoffDelayMs(attempt++, random = random)
        reconnectJob = scope.launch {
            delay(wait)
            connect()
        }
    }

    private fun send(obj: JsonObject): Boolean {
        val ws = socket ?: return false
        if (!authenticated) return false
        return ws.send(obj.toString())
    }

    private fun sendSubscribe(sessionId: String, afterSeq: Int) =
        send(buildJsonObject { put("type", "subscribe"); put("sessionId", sessionId); put("afterSeq", afterSeq) })

    /** Subscribes to live events; returns an unsubscribe function. */
    fun subscribe(sessionId: String, lastSeq: () -> Int): () -> Unit {
        subscriptions[sessionId] = lastSeq
        sendSubscribe(sessionId, lastSeq())
        return {
            subscriptions.remove(sessionId)
            send(buildJsonObject { put("type", "unsubscribe"); put("sessionId", sessionId) })
        }
    }

    /** Re-requests events after [afterSeq] (gap recovery). */
    fun resync(sessionId: String, afterSeq: Int) {
        sendSubscribe(sessionId, afterSeq)
    }

    suspend fun command(cmd: TerminalCommand): CommandResult {
        val commandId = UUID.randomUUID().toString()
        val command = buildJsonObject {
            put("sessionId", cmd.sessionId)
            when (cmd) {
                is TerminalCommand.Input -> { put("op", "session.input"); put("data", cmd.data) }
                is TerminalCommand.Resize -> { put("op", "session.resize"); put("cols", cmd.cols); put("rows", cmd.rows) }
                is TerminalCommand.Signal -> { put("op", "session.signal"); put("signal", if (cmd.terminate) "terminate" else "interrupt") }
            }
        }
        val deferred = CompletableDeferred<CommandResult>()
        acks[commandId] = deferred
        val sent = send(buildJsonObject { put("type", "command"); put("commandId", commandId); put("command", command) })
        if (!sent) {
            acks.remove(commandId)
            return CommandResult(false, CommandError("offline", "Not connected"))
        }
        return withTimeoutOrNull(10_000) { deferred.await() }
            ?: CommandResult(false, CommandError("timeout", "No response from the Mac")).also { acks.remove(commandId) }
    }

    @Suppress("unused")
    private fun JsonPrimitive.asIntOrNull() = intOrNull
}
