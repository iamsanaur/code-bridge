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
