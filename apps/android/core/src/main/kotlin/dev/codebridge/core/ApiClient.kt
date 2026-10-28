package dev.codebridge.core

import java.io.IOException
import java.time.Instant
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.serializer
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/** Where tokens live: Android Keystore-backed storage on device, memory in tests. */
interface TokenStore {
    suspend fun load(): TokenPair?
    suspend fun save(tokens: TokenPair)
    suspend fun clear()
}

class InMemoryTokenStore(private var tokens: TokenPair? = null) : TokenStore {
    override suspend fun load() = tokens
    override suspend fun save(tokens: TokenPair) { this.tokens = tokens }
    override suspend fun clear() { tokens = null }
}

class ApiException(val status: Int, val code: String, override val message: String) : IOException(message) {
    val isNetwork: Boolean get() = status == 0
}

/**
 * REST client with bearer auth and transparent access-token refresh. Concurrent
 * 401s share one refresh (single flight); a rejected refresh signs the user out.
 */
class ApiClient(
    baseUrl: String,
    private val tokenStore: TokenStore,
    private val http: OkHttpClient = OkHttpClient(),
    private val now: () -> Instant = Instant::now,
) {
    val baseUrl: String = baseUrl.trimEnd('/')
    private val jsonType = "application/json".toMediaType()
    private val refreshLock = Mutex()
    @Volatile private var tokens: TokenPair? = null

    /** Called when the server rejects the refresh token (session revoked or expired). */
    var onSignedOut: (() -> Unit)? = null

    init {
        baseUrl.toHttpUrl() // fail fast on malformed URLs
    }

    val isSignedIn: Boolean get() = tokens != null

    suspend fun restore(): Boolean {
        tokens = tokenStore.load()
        return tokens != null
    }

    suspend fun setTokens(t: TokenPair) {
        tokens = t
        tokenStore.save(t)
    }

    suspend fun clearTokens() {
        tokens = null
        tokenStore.clear()
    }

    /** A valid access token, refreshed first if it expires within 30 seconds. */
    suspend fun freshAccessToken(): String? {
        val t = tokens ?: return null
        if (Instant.parse(t.accessExpiresAt).minusSeconds(30).isBefore(now())) refresh(t.accessToken)
        return tokens?.accessToken
    }

    private suspend fun refresh(staleAccessToken: String?): Boolean = refreshLock.withLock {
        // Another caller refreshed while we waited for the lock.
        val current = tokens ?: return false
        if (staleAccessToken != null && current.accessToken != staleAccessToken) return true
        return try {
            val res = raw("POST", "/v1/auth/refresh", ProtocolJson.encodeToString(mapOf("refreshToken" to current.refreshToken)), emptyMap(), null)
            setTokens(ProtocolJson.decodeFromString(RefreshResponse.serializer(), res).tokens)
            true
        } catch (e: ApiException) {
            if (e.status == 401) {
                clearTokens()
                onSignedOut?.invoke()
            }
            false
        }
    }

    private suspend fun raw(method: String, path: String, body: String?, headers: Map<String, String>, token: String?): String =
        withContext(Dispatchers.IO) {
            val builder = Request.Builder().url(baseUrl + path).header("Accept", "application/json")
            headers.forEach { (k, v) -> builder.header(k, v) }
            if (token != null) builder.header("Authorization", "Bearer $token")
            val reqBody = body?.toRequestBody(jsonType)
            builder.method(method, if (reqBody == null && method in setOf("POST", "PUT", "PATCH")) "{}".toRequestBody(jsonType) else reqBody)
            val response = try {
                http.newCall(builder.build()).execute()
            } catch (e: IOException) {
                throw ApiException(0, "network_error", "Cannot reach the CodeBridge server. Check your connection.")
            }
            response.use {
                val text = it.body.string()
                if (!it.isSuccessful) {
                    val err = runCatching { ProtocolJson.decodeFromString(ApiErrorBody.serializer(), text) }.getOrNull()
                    throw ApiException(it.code, err?.code ?: "http_error", err?.message ?: "Request failed (${it.code})")
                }
                text
            }
        }

    suspend fun <T> request(
        method: String,
        path: String,
        deserializer: KSerializer<T>,
        body: String? = null,
        headers: Map<String, String> = emptyMap(),
        auth: Boolean = true,
    ): T {
        val token = if (auth) freshAccessToken() else null
        val text = try {
            raw(method, path, body, headers, token)
        } catch (e: ApiException) {
            if (auth && e.status == 401 && tokens != null && refresh(token)) raw(method, path, body, headers, tokens?.accessToken) else throw e
        }
        return ProtocolJson.decodeFromString(deserializer, text.ifEmpty { "{}" })
    }

    private inline fun <reified B> encode(b: B): String = ProtocolJson.encodeToString(serializer<B>(), b)

    private fun idem() = mapOf("Idempotency-Key" to UUID.randomUUID().toString())

    // ---- Auth -------------------------------------------------------------
    suspend fun register(email: String, password: String): User = authenticate("/v1/auth/register", email, password)
    suspend fun signIn(email: String, password: String): User = authenticate("/v1/auth/login", email, password)

    private suspend fun authenticate(path: String, email: String, password: String): User {
        val res = request("POST", path, AuthResponse.serializer(), encode(mapOf("email" to email, "password" to password)), auth = false)
        setTokens(res.tokens)
        return res.user
    }

    /** Personal relay: exchanges the owner secret from the QR code for session tokens. No account involved. */
    suspend fun connect(secret: String): User {
        val res = request("POST", "/v1/auth/connect", AuthResponse.serializer(), encode(mapOf("secret" to secret)), auth = false)
        setTokens(res.tokens)
        return res.user
    }

    suspend fun me(): User = request("GET", "/v1/me", User.serializer())

    suspend fun signOut() {
        runCatching { request("POST", "/v1/auth/logout", JsonObject.serializer()) }
        clearTokens()
    }

    suspend fun deleteAccount(password: String) {
        request("DELETE", "/v1/me", JsonObject.serializer(), encode(mapOf("password" to password)))
        clearTokens()
    }

    // ---- Pairing & devices ------------------------------------------------
    suspend fun claimPairing(code: String): PairingClaim =
        request("POST", "/v1/pairing/claim", PairingClaim.serializer(), encode(mapOf("code" to code)))

    suspend fun decidePairing(pairingId: String, approve: Boolean) {
        request("POST", "/v1/pairing/$pairingId/${if (approve) "approve" else "deny"}", JsonObject.serializer())
    }

    suspend fun devices(): List<Device> = request("GET", "/v1/devices", DeviceList.serializer()).devices
    suspend fun device(id: String): Device = request("GET", "/v1/devices/$id", Device.serializer())
    suspend fun renameDevice(id: String, name: String) {
        request("PATCH", "/v1/devices/$id", JsonObject.serializer(), encode(mapOf("name" to name)))
    }
    suspend fun revokeDevice(id: String) {
        request("DELETE", "/v1/devices/$id", JsonObject.serializer())
    }

    // ---- Sessions ---------------------------------------------------------
    suspend fun sessions(kind: SessionKind? = null, active: Boolean? = null): List<Session> {
        val q = buildList {
            if (kind != null) add("kind=${kind.name.lowercase()}")
            if (active != null) add("active=$active")
        }.joinToString("&")
        return request("GET", "/v1/sessions" + (if (q.isEmpty()) "" else "?$q"), SessionList.serializer()).sessions
    }

    suspend fun session(id: String): Session = request("GET", "/v1/sessions/$id", Session.serializer())

    /** One idempotency key per user action, so a retried request never starts a second session. */
    suspend fun createLocalSession(deviceId: String, body: CreateLocalSession): Session =
        request("POST", "/v1/devices/$deviceId/sessions", Session.serializer(), encode(body), idem())

    /**
     * Starts a new project on the computer: a brand-new folder with this name inside the owner's projects folder.
     * Only a name is sent, never a path, and the computer refuses names that already exist.
     */
    suspend fun createWorkspace(deviceId: String, name: String, gitInit: Boolean): CreateWorkspaceResult =
        request(
            "POST",
            "/v1/devices/$deviceId/workspaces",
            CreateWorkspaceResult.serializer(),
            ProtocolJson.encodeToString(JsonObject.serializer(), kotlinx.serialization.json.buildJsonObject {
                put("name", kotlinx.serialization.json.JsonPrimitive(name))
                put("gitInit", kotlinx.serialization.json.JsonPrimitive(gitInit))
            }),
            idem(),
        )

    /** The folders inside one folder of the computer's home directory (the home folder when [path] is null). */
    suspend fun browseFolders(deviceId: String, path: String?): BrowseFoldersResult =
        request(
            "GET",
            "/v1/devices/$deviceId/browse" + (path?.let { "?path=" + java.net.URLEncoder.encode(it, "UTF-8") } ?: ""),
            BrowseFoldersResult.serializer(),
        )

    /** Adds an existing folder as a project. The computer re-checks the path and refuses hidden, system and out-of-home folders. */
    suspend fun addWorkspace(deviceId: String, path: String): AddWorkspaceResult =
        request(
            "POST",
            "/v1/devices/$deviceId/workspaces/add",
            AddWorkspaceResult.serializer(),
            encode(mapOf("path" to path)),
            idem(),
        )

    /** Chooses the folder new projects are created in. The computer re-checks it (inside home, nothing hidden). */
    suspend fun setProjectsRoot(deviceId: String, path: String): SetProjectsRootResult =
        request(
            "PUT",
            "/v1/devices/$deviceId/projects-root",
            SetProjectsRootResult.serializer(),
            encode(mapOf("path" to path)),
            idem(),
        )

    /**
     * An image from a project on the computer (png, jpg, gif or webp, at most 6 MB). The relay gathers it from the
     * computer in pieces; only files inside the project are ever served.
     */
    suspend fun fileBytes(deviceId: String, workspaceId: String, path: String): ByteArray {
        val url = baseUrl + "/v1/devices/$deviceId/workspaces/$workspaceId/file?path=" + java.net.URLEncoder.encode(path, "UTF-8")
        suspend fun fetch(token: String?): ByteArray = withContext(Dispatchers.IO) {
            val builder = Request.Builder().url(url).header("Accept", "image/*").get()
            if (token != null) builder.header("Authorization", "Bearer $token")
            val response = try {
                http.newCall(builder.build()).execute()
            } catch (e: IOException) {
                throw ApiException(0, "network_error", "Cannot reach the CodeBridge server. Check your connection.")
            }
            response.use {
                if (!it.isSuccessful) {
                    val err = runCatching { ProtocolJson.decodeFromString(ApiErrorBody.serializer(), it.body.string()) }.getOrNull()
                    throw ApiException(it.code, err?.code ?: "http_error", err?.message ?: "Request failed (${it.code})")
                }
                it.body.bytes()
            }
        }
        val token = freshAccessToken()
        return try {
            fetch(token)
        } catch (e: ApiException) {
            if (e.status == 401 && tokens != null && refresh(token)) fetch(tokens?.accessToken) else throw e
        }
    }

    /** The Claude Code conversations saved on the computer for one project, newest first. */
    suspend fun savedConversations(deviceId: String, workspaceId: String): List<SavedConversation> =
        request("GET", "/v1/devices/$deviceId/workspaces/$workspaceId/claude-sessions", SavedConversationList.serializer()).sessions

    suspend fun signal(sessionId: String, terminate: Boolean) {
        request("POST", "/v1/sessions/$sessionId/signal", JsonObject.serializer(), encode(mapOf("signal" to if (terminate) "terminate" else "interrupt")), idem())
    }

    suspend fun prompt(sessionId: String, text: String) {
        request("POST", "/v1/sessions/$sessionId/prompt", JsonObject.serializer(), encode(mapOf("text" to text)), idem())
    }

    suspend fun decideApproval(sessionId: String, approvalId: String, approve: Boolean) {
        request(
            "POST",
            "/v1/sessions/$sessionId/approvals/$approvalId",
            JsonObject.serializer(),
            encode(mapOf("decision" to if (approve) "approve" else "reject")),
            idem(),
        )
    }

    suspend fun gitStatus(deviceId: String, workspaceId: String): GitStatus =
        request("GET", "/v1/devices/$deviceId/workspaces/$workspaceId/git/status", GitStatus.serializer())

    suspend fun gitDiff(deviceId: String, workspaceId: String, path: String?): GitDiff {
        val q = path?.let { "?path=" + java.net.URLEncoder.encode(it, Charsets.UTF_8) } ?: ""
        return request("GET", "/v1/devices/$deviceId/workspaces/$workspaceId/git/diff$q", GitDiff.serializer())
    }

    suspend fun usage(): UsageSummary = request("GET", "/v1/usage", UsageSummary.serializer())

    // ---- Credentials & cloud ---------------------------------------------
    suspend fun cloudCredential(): CredentialStatus = request("GET", "/v1/credentials/anthropic", CredentialStatus.serializer())

    /** Uploads the key once over TLS; the server stores it encrypted and never returns it. */
    suspend fun saveCloudKey(apiKey: String) {
        request("PUT", "/v1/credentials/anthropic", JsonObject.serializer(), encode(mapOf("apiKey" to apiKey)))
    }

    suspend fun deleteCloudKey() {
        request("DELETE", "/v1/credentials/anthropic", JsonObject.serializer())
    }

    suspend fun cloudConfig(): CloudConfig = request("GET", "/v1/cloud/config", CloudConfig.serializer())

    suspend fun updateCloudConfig(model: String, unrestricted: Boolean, allowedHosts: List<String>, budgetCents: Int) {
        val body = kotlinx.serialization.json.buildJsonObject {
            put("model", kotlinx.serialization.json.JsonPrimitive(model))
            put("networking", kotlinx.serialization.json.JsonPrimitive(if (unrestricted) "unrestricted" else "limited"))
            put("allowedHosts", kotlinx.serialization.json.JsonArray(allowedHosts.map { kotlinx.serialization.json.JsonPrimitive(it) }))
            put("budgetCents", kotlinx.serialization.json.JsonPrimitive(budgetCents))
        }
        request("PUT", "/v1/cloud/config", JsonObject.serializer(), body.toString())
    }

    suspend fun createCloudSession(prompt: String): Session =
        request("POST", "/v1/cloud/sessions", Session.serializer(), encode(mapOf("prompt" to prompt)), idem())

    suspend fun endCloudSession(id: String) {
        request("POST", "/v1/cloud/sessions/$id/end", JsonObject.serializer())
    }
}

@kotlinx.serialization.Serializable
private data class RelayInfo(val service: String = "", val mode: String = "")

/** Checks that an address really is a personal CodeBridge relay before any secret is sent to it. */
suspend fun verifyPersonalRelay(baseUrl: String, http: OkHttpClient = OkHttpClient()) {
    val text = withContext(Dispatchers.IO) {
        try {
            http.newCall(Request.Builder().url(baseUrl.trimEnd('/') + "/v1/relay/info").build()).execute().use { it.body.string() }
        } catch (e: IOException) {
            throw ApiException(0, "unreachable", "Couldn’t reach ${runCatching { java.net.URI(baseUrl).host }.getOrNull() ?: "the relay"}. Is it running?")
        }
    }
    val info = runCatching { ProtocolJson.decodeFromString(RelayInfo.serializer(), text) }.getOrNull()
    if (info?.service != "codebridge-relay") throw ApiException(0, "not_a_relay", "That address isn’t a CodeBridge relay.")
    if (info.mode != "personal") throw ApiException(0, "not_personal", "That relay uses email accounts. Use “Sign in to a shared relay” instead.")
}
