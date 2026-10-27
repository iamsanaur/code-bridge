package dev.codebridge.core

import java.net.URI
import java.time.Duration
import java.time.Instant
import java.util.Locale

const val PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

/** Normalises a typed pairing code ("abcd-efgh" -> "ABCDEFGH"); null if invalid. */
fun normalizePairingCode(input: String): String? {
    val c = input.uppercase(Locale.ROOT).filter { it.isLetterOrDigit() }
    return c.takeIf { it.length == 8 && it.all { ch -> ch in PAIRING_ALPHABET } }
}

/** Extracts the code from a scanned `codebridge://pair?code=…` link; rejects anything else. */
fun codeFromQr(data: String): String? = runCatching {
    val uri = URI(data)
    if (uri.scheme != "codebridge" || uri.host != "pair") return null
    val code = uri.rawQuery?.split('&')?.map { it.split('=', limit = 2) }?.firstOrNull { it[0] == "code" }?.getOrNull(1) ?: return null
    normalizePairingCode(java.net.URLDecoder.decode(code, Charsets.UTF_8))
}.getOrNull()

/**
 * What `codebridge-relay` puts in its QR code: `codebridge://connect?server=<url>&secret=<owner secret>`.
 * It carries the owner secret, so it is treated like a password and never logged.
 */
data class ConnectLink(val server: String, val secret: String) {
    /** The host shown to the user before connecting. */
    val host: String get() = runCatching { URI(server).host }.getOrNull() ?: server
}

private val LOCAL_HOSTS = setOf("localhost", "127.0.0.1", "::1", "[::1]", "10.0.2.2")

private fun isLocalHost(host: String) = host in LOCAL_HOSTS || host.endsWith(".local")

/** Parses a scanned or pasted connect link; rejects other schemes and servers that are neither https nor local. */
fun parseConnectLink(text: String): ConnectLink? = runCatching {
    val uri = URI(text.trim())
    if (uri.scheme != "codebridge" || uri.host != "connect") return null
    val params = uri.rawQuery?.split('&')?.mapNotNull { p -> p.split('=', limit = 2).takeIf { it.size == 2 } }
        ?.associate { it[0] to java.net.URLDecoder.decode(it[1], Charsets.UTF_8) } ?: return null
    val server = params["server"]?.trimEnd('/') ?: return null
    val secret = params["secret"]?.takeIf { it.isNotEmpty() } ?: return null
    val target = URI(server)
    val host = target.host ?: return null
    if (target.scheme != "https" && !(target.scheme == "http" && isLocalHost(host))) return null
    ConnectLink(server, secret)
}.getOrNull()

fun makeConnectLink(server: String, secret: String): String {
    fun enc(s: String) = java.net.URLEncoder.encode(s, Charsets.UTF_8).replace("+", "%20")
    return "codebridge://connect?server=${enc(server.trimEnd('/'))}&secret=${enc(secret)}"
}

/** Splits a command line into argv without a shell: quotes group, no globbing/pipes/expansion. */
fun splitArgs(line: String): List<String> {
    val out = ArrayList<String>()
    val cur = StringBuilder()
    var quote: Char? = null
    var has = false
    for (ch in line) {
        if (quote != null) {
            if (ch == quote) quote = null else cur.append(ch)
        } else if (ch == '"' || ch == '\'') {
            quote = ch
            has = true
        } else if (ch.isWhitespace()) {
            if (cur.isNotEmpty() || has) out.add(cur.toString())
            cur.setLength(0)
            has = false
        } else cur.append(ch)
    }
    if (cur.isNotEmpty() || has) out.add(cur.toString())
    return out
}

fun timeAgo(iso: String?, now: Instant = Instant.now()): String {
    if (iso == null) return "never"
    val s = runCatching { Duration.between(Instant.parse(iso), now).seconds }.getOrElse { return "—" }.coerceAtLeast(0)
    return when {
        s < 10 -> "just now"
        s < 60 -> "${s}s ago"
        s < 3600 -> "${Math.round(s / 60.0)}m ago"
        s < 48 * 3600 -> "${Math.round(s / 3600.0)}h ago"
        else -> "${Math.round(s / 86400.0)}d ago"
    }
}

fun formatUsd(v: Double?): String = when {
    v == null -> "—"
    v < 0.01 -> String.format(Locale.US, "$%.4f", v)
    else -> String.format(Locale.US, "$%.2f", v)
}

fun formatTokens(n: Long): String = when {
    n < 1000 -> n.toString()
    n < 1_000_000 -> String.format(Locale.US, "%.1fk", n / 1000.0)
    else -> String.format(Locale.US, "%.2fM", n / 1_000_000.0)
}
