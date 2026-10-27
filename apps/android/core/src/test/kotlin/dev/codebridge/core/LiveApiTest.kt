package dev.codebridge.core

import java.util.UUID
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.junit.jupiter.api.Assumptions.assumeTrue

/**
 * CONTRACT test against a real, running CodeBridge API (apps/api), proving the
 * Kotlin client and models match the server's actual JSON. A scripted Mac agent
 * (raw WebSocket) stands in for apps/mac-agent.
 *
 *   CODEBRIDGE_IT_API_URL=http://localhost:8080 ./gradlew :core:test
 */
class LiveApiTest {
    private val base = System.getenv("CODEBRIDGE_IT_API_URL").orEmpty()
    private val http = OkHttpClient()

    private fun post(path: String, body: JsonObject, token: String? = null): JsonObject {
        val req = Request.Builder().url(base + path).post(body.toString().toRequestBody("application/json".toMediaType()))
        if (token != null) req.header("Authorization", "Bearer $token")
        http.newCall(req.build()).execute().use { return ProtocolJson.parseToJsonElement(it.body.string()).jsonObject }
    }

    @Test fun fullLocalSessionFlowAgainstTheRealServer() = runBlocking {
        assumeTrue(base.isNotEmpty(), "set CODEBRIDGE_IT_API_URL to run")
        val api = ApiClient(base, InMemoryTokenStore())
        val email = "kotlin-${UUID.randomUUID()}@example.com"
        val user = api.register(email, "correct horse battery staple")
        assertEquals(email, user.email)
        assertEquals(user, api.me())
        assertFailsWith<ApiException> { ApiClient(base, InMemoryTokenStore()).signIn(email, "wrong password!") }

        // Pairing: the "Mac" starts, the app claims + approves, the "Mac" collects its credential.
        val start = post("/v1/pairing/start", buildJsonObject { put("deviceName", "Kotlin Mac"); put("platform", "darwin") })
        val code = normalizePairingCode(start["userCode"]!!.jsonPrimitive.content)!!
        assertEquals(code, codeFromQr(start["qrPayload"]!!.jsonPrimitive.content))
        val claim = api.claimPairing(code)
        assertEquals("Kotlin Mac", claim.deviceName)
        api.decidePairing(claim.pairingId, approve = true)
        val poll = post("/v1/pairing/poll", buildJsonObject { put("pairingId", start["pairingId"]!!.jsonPrimitive.content); put("pollSecret", start["pollSecret"]!!.jsonPrimitive.content) })
        val deviceId = poll["deviceId"]!!.jsonPrimitive.content
        val deviceSecret = poll["deviceSecret"]!!.jsonPrimitive.content

        // Scripted agent: hello, then ack every command and record it.
        val commands = LinkedBlockingQueue<JsonObject>()
        val agent = http.newWebSocket(
            Request.Builder().url(base.replace("http", "ws") + "/v1/agent/ws").header("Authorization", "Bearer $deviceSecret").build(),
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    webSocket.send(
                        buildJsonObject {
                            put("type", "agent.hello"); put("protocol", 1); put("agentVersion", "it"); put("hostname", "kt.local"); put("platform", "darwin"); put("arch", "arm64")
                            putJsonObject("capabilities") { put("pty", true); put("anthropicKeyConfigured", true); put("claudeCodeAvailable", false); put("allowCustomCommands", false); put("allowInteractiveShell", false) }
                            putJsonArray("workspaces") { add(buildJsonObject { put("id", "ws_aaaaaaaa"); put("name", "proj"); put("displayPath", "~/proj"); put("isGitRepo", true) }) }
                            putJsonArray("presets") { add(buildJsonObject { put("id", "npm-test"); put("label", "npm test"); put("argv", buildJsonArray { add(kotlinx.serialization.json.JsonPrimitive("npm")); add(kotlinx.serialization.json.JsonPrimitive("test")) }) }) }
                            putJsonArray("sessions") {}
                        }.toString(),
                    )
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    val m = ProtocolJson.parseToJsonElement(text).jsonObject
                    if (m["type"]!!.jsonPrimitive.content == "server.command") {
                        commands.add(m)
                        webSocket.send(buildJsonObject { put("type", "agent.ack"); put("commandId", m["commandId"]!!.jsonPrimitive.content); put("ok", true) }.toString())
                    }
                }
            },
        )
        /** Next command the Mac received, skipping relay-initiated replay requests. */
        fun nextCommand(): JsonObject {
            while (true) {
                val c = commands.poll(5, TimeUnit.SECONDS)!!["command"]!!.jsonObject
                if (c["op"]!!.jsonPrimitive.content != "session.replay") return c
            }
        }
        fun agentEvent(sessionId: String, seq: Int, event: JsonObject) =
            agent.send(buildJsonObject { put("type", "agent.event"); put("sessionId", sessionId); put("seq", seq); put("ts", "2026-01-01T00:00:00Z"); put("event", event) }.toString())

        // App side: realtime connection.
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val rt = RealtimeClient(base.replace("http", "ws") + "/v1/client/ws", { api.freshAccessToken() }, http, scope)
        val events = LinkedBlockingQueue<ServerMessage>()
        scope.launch { rt.messages.collect { events.add(it) } }
        rt.start()
        withTimeout(10_000) { rt.status.first { it == ConnectionStatus.CONNECTED } }

        // Device list decodes, including capabilities/workspaces/presets from the hello.
        var device: Device
        val deadline = System.currentTimeMillis() + 5_000
        do { device = api.devices().single() } while (!device.online && System.currentTimeMillis() < deadline)
        assertTrue(device.online)
        assertEquals(deviceId, device.id)
        assertEquals("proj", device.workspaces.single().name)
        assertEquals(listOf("npm", "test"), device.presets.single().argv)
        assertEquals(true, device.capabilities!!.anthropicKeyConfigured)

        // Start a session; the agent receives exactly the policy-relevant fields.
        val session = api.createLocalSession(deviceId, CreateLocalSession("ws_aaaaaaaa", SessionMode.COMMAND, presetId = "npm-test"))
        assertEquals(SessionKind.LOCAL, session.kind)
        assertEquals(SessionStatus.STARTING, session.status)
        val startCmd = nextCommand()
        assertEquals("session.start", startCmd["op"]!!.jsonPrimitive.content)
        assertEquals(session.id, startCmd["sessionId"]!!.jsonPrimitive.content)

        // Live events reach the app in order and drive SessionState.
        val state = SessionState()
        rt.subscribe(session.id) { state.lastSeq }
        Thread.sleep(200)
        agentEvent(session.id, 1, buildJsonObject { put("kind", "status"); put("status", "running") })
        agentEvent(session.id, 2, buildJsonObject { put("kind", "output"); put("stream", "pty"); put("data", "\u001b[32m✓\u001b[0m 12 tests passed\r\n") })
        agentEvent(session.id, 3, buildJsonObject { put("kind", "approval.request"); put("approvalId", "apr_1"); put("toolName", "run_command"); put("title", "Run: rm -rf build"); put("detail", "[]"); put("risk", "high"); put("expiresAt", "2026-01-01T00:10:00Z") })
        agentEvent(session.id, 4, buildJsonObject { put("kind", "usage"); putJsonObject("usage") { put("model", "claude-opus-5-5"); put("inputTokens", 100); put("outputTokens", 20); put("cacheReadTokens", 0); put("cacheWriteTokens", 0); put("estimatedCostUsd", 0.0008); put("source", "anthropic_usage") } })
        agentEvent(session.id, 5, buildJsonObject { put("kind", "status"); put("status", "completed"); put("exitCode", 0) })
        val until = System.currentTimeMillis() + 5_000
        while (state.lastSeq < 5 && System.currentTimeMillis() < until) {
            when (val m = events.poll(200, TimeUnit.MILLISECONDS)) {
                is ServerMessage.Event -> if (m.event.sessionId == session.id) state.apply(m.event)
                else -> Unit
            }
        }
        assertEquals(5, state.lastSeq)
        assertTrue(state.terminal.plainText().contains("12 tests passed"))
        assertEquals(SessionStatus.COMPLETED, state.status)
        assertEquals("run_command", state.approvals.single().toolName)
        assertEquals(120L, state.usage!!.inputTokens + state.usage!!.outputTokens)

        val stored = api.session(session.id)
        assertEquals(SessionStatus.COMPLETED, stored.status)
        assertEquals(0, stored.exitCode)

        // Terminal input over the socket is acked by the Mac.
        val result = rt.command(TerminalCommand.Input(session.id, "y\r"))
        assertTrue(result.ok, result.toString())
        assertEquals("session.input", nextCommand()["op"]!!.jsonPrimitive.content)

        // Approvals go through REST and reach the Mac.
        api.decideApproval(session.id, "apr_1", approve = false)
        assertEquals("reject", nextCommand()["decision"]!!.jsonPrimitive.content)

        // Other endpoints decode.
        assertTrue(api.sessions(active = false).any { it.id == session.id })
        assertEquals(30, api.usage().periodDays)
        val cred = api.cloudCredential()
        assertEquals(false, cred.configured)
        val cloud = api.cloudConfig()
        assertTrue(cloud.availableModels.contains("claude-opus-5-5"))
        val noKey = assertFailsWith<ApiException> { api.createCloudSession("hello") }
        assertEquals("credential_missing", noKey.code)

        // Revocation tears everything down.
        api.revokeDevice(deviceId)
        assertTrue(api.devices().isEmpty())
        val offlineBy = System.currentTimeMillis() + 5_000
        var sawOffline = false
        while (!sawOffline && System.currentTimeMillis() < offlineBy) {
            val m = events.poll(200, TimeUnit.MILLISECONDS)
            sawOffline = m is ServerMessage.DeviceStatus && m.deviceId == deviceId && !m.online
        }
        assertTrue(sawOffline, "expected a device.status offline message after revocation")

        api.deleteAccount("correct horse battery staple")
        assertTrue(!api.isSignedIn)
        rt.stop()
        agent.cancel()
        scope.cancel()
    }
}
