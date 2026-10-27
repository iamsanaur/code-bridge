package dev.codebridge.core

import java.time.Instant
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

private fun pair(n: Int) = TokenPair("cba_access$n", "cbr_refresh$n", Instant.now().plusSeconds(600).toString(), Instant.now().plusSeconds(86_400).toString())

class ApiClientTest {
    private lateinit var server: MockWebServer

    @BeforeTest fun setUp() { server = MockWebServer().apply { start() } }
    @AfterTest fun tearDown() { server.close() }

    @Test fun refreshesOnceForConcurrent401s() = runBlocking {
        val refreshes = AtomicInteger()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when {
                request.url.encodedPath == "/v1/auth/refresh" -> {
                    refreshes.incrementAndGet()
                    Thread.sleep(50)
                    MockResponse.Builder().body(ProtocolJson.encodeToString(RefreshResponse.serializer(), RefreshResponse(pair(2)))).build()
                }
                request.headers["Authorization"] == "Bearer cba_access2" ->
                    MockResponse.Builder().body("""{"id":"u1","email":"a@b.c"}""").build()
                else -> MockResponse.Builder().code(401).body("""{"code":"unauthorized","message":"expired"}""").build()
            }
        }
        val store = InMemoryTokenStore(pair(1))
        val api = ApiClient(server.url("/").toString(), store)
        api.restore()
        val users = (1..5).map { async(Dispatchers.IO) { api.me() } }.awaitAll()
        assertEquals(5, users.count { it.email == "a@b.c" })
        assertEquals(1, refreshes.get())
        assertEquals("cba_access2", store.load()!!.accessToken)
    }

    @Test fun signsOutWhenRefreshIsRejected() = runBlocking {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest) = MockResponse.Builder().code(401).body("""{"code":"unauthorized","message":"no"}""").build()
        }
        val store = InMemoryTokenStore(pair(1))
        val api = ApiClient(server.url("/").toString(), store)
        var signedOut = false
        api.onSignedOut = { signedOut = true }
        api.restore()
        assertFailsWith<ApiException> { api.devices() }
        assertTrue(signedOut)
        assertNull(store.load())
    }

    @Test fun mapsErrorsAndNetworkFailures() = runBlocking {
        server.enqueue(MockResponse.Builder().code(409).body("""{"code":"device_offline","message":"This Mac is offline"}""").build())
        val api = ApiClient(server.url("/").toString(), InMemoryTokenStore(pair(1)))
        api.restore()
        val e = assertFailsWith<ApiException> { api.createLocalSession("d", CreateLocalSession("ws_1", SessionMode.COMMAND, presetId = "npm-test")) }
        assertEquals(409, e.status)
        assertEquals("device_offline", e.code)
        val sent = server.takeRequest()
        assertTrue(sent.headers["Idempotency-Key"]!!.isNotBlank())
        assertTrue(sent.body!!.utf8().contains("\"mode\":\"command\""))

        server.close()
        val offline = assertFailsWith<ApiException> { api.devices() }
        assertTrue(offline.isNetwork)
    }
}

class RealtimeClientTest {
    @Test fun authenticatesFirstAndResubscribesFromLastSeqAfterADrop() = runBlocking {
        val server = MockWebServer()
        val sockets = mutableListOf<WebSocket>()
        val received = java.util.concurrent.LinkedBlockingQueue<String>()
        val listener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) { synchronized(sockets) { sockets.add(webSocket) } }
            override fun onMessage(webSocket: WebSocket, text: String) {
                received.add(text)
                if (text.contains("\"auth\"")) webSocket.send("""{"type":"auth.ok","userId":"6f1c1f9e-4a36-4c55-9d32-5b0b1d2c3a4f"}""")
            }
        }
        repeat(2) { server.enqueue(MockResponse.Builder().webSocketUpgrade(listener).build()) }
        server.start()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val rt = RealtimeClient(server.url("/v1/client/ws").toString().replace("http", "ws"), { "cba_token" }, OkHttpClient(), scope, random = { 0.0 })
        rt.start()
        withTimeout(5_000) { rt.status.first { it == ConnectionStatus.CONNECTED } }
        assertTrue(received.poll(2, TimeUnit.SECONDS)!!.contains("\"token\":\"cba_token\""))
        var last = 0
        rt.subscribe("s1") { last }
        assertTrue(received.poll(2, TimeUnit.SECONDS)!!.contains("\"afterSeq\":0"))

        last = 42
        synchronized(sockets) { sockets[0] }.close(1001, "server going away")
        // Wait for the second connection's frames (status transitions are too quick to observe reliably).
        val frames = listOf(received.poll(5, TimeUnit.SECONDS)!!, received.poll(5, TimeUnit.SECONDS)!!)
        assertTrue(frames[0].contains("\"type\":\"auth\""))
        assertTrue(frames[1].contains("\"afterSeq\":42"), frames[1])
        assertEquals(2, synchronized(sockets) { sockets.size })
        assertEquals(ConnectionStatus.CONNECTED, rt.status.value)
        rt.stop()
        scope.cancel()
        synchronized(sockets) { sockets.forEach { it.close(1000, null) } }
        Thread.sleep(300)
        server.close()
    }

    @Test fun commandsFailFastWhileOffline() = runBlocking {
        val rt = RealtimeClient("ws://127.0.0.1:9/none", { "t" }, OkHttpClient(), CoroutineScope(Dispatchers.IO))
        val r = rt.command(TerminalCommand.Input("s", "x"))
        assertEquals(CommandResult(false, CommandError("offline", "Not connected")), r)
    }
}
