package dev.codebridge.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/** Finds the images a chat message or tool call is about, so the app can fetch and show them from the computer. */
object ImageRefs {
    private val regex = Regex("""[A-Za-z0-9_@%+=,.\-/~]+\.(?:png|jpe?g|gif|webp)\b""", RegexOption.IGNORE_CASE)

    /** File names or paths that end in an image extension, in order, without repeats. Web addresses are skipped. */
    fun paths(text: String, limit: Int = 4): List<String> {
        val out = LinkedHashSet<String>()
        for (m in regex.findAll(text)) {
            if (m.range.first > 0 && text[m.range.first - 1] == ':') continue
            val p = m.value
            if (p.startsWith("//") || p.startsWith("http")) continue
            out += p
            if (out.size == limit) break
        }
        return out.toList()
    }

    /** Images for a tool card: the file a Read or Write call is about, plus any image paths in what it printed. */
    fun forTool(summary: String, result: String?, limit: Int = 4): List<String> {
        val out = LinkedHashSet<String>()
        val obj = runCatching { Json.parseToJsonElement(summary) as? JsonObject }.getOrNull()
        val file = (obj?.get("file_path") as? JsonPrimitive)?.contentOrNull
        if (file != null && paths(file).isNotEmpty()) out += file
        for (p in paths(ToolDisplay.resultText(result.orEmpty()), limit)) out += p
        return out.take(limit)
    }
}
