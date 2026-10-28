package dev.codebridge.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/** How a tool call reads in the chat, in the style of Claude Code: `Bash(npm test)` with the result under it as `⎿ …`. */
object ToolDisplay {
    private val argumentKeys = listOf("command", "file_path", "path", "notebook_path", "pattern", "url", "query", "description", "prompt")

    /** The one argument worth showing next to the tool name, or null when there is none. */
    fun headline(summary: String, limit: Int = 90): String? {
        val obj = runCatching { Json.parseToJsonElement(summary) as? JsonObject }.getOrNull()
        if (obj == null) return flatten(summary).takeIf { it.isNotEmpty() }?.let { clip(it, limit) }
        for (key in argumentKeys) {
            val v = (obj[key] as? JsonPrimitive)?.contentOrNull
            if (!v.isNullOrEmpty()) return clip(flatten(v), limit)
        }
        return null
    }

    /** Result text with Claude Code's `[{"type":"text","text":"…"}]` wrapping removed. */
    fun resultText(summary: String): String {
        if (!summary.startsWith("[")) return summary
        val blocks = runCatching { Json.parseToJsonElement(summary) as? JsonArray }.getOrNull() ?: return summary
        val texts = blocks.mapNotNull { (it as? JsonObject)?.get("text")?.let { t -> (t as? JsonPrimitive)?.contentOrNull } }
        return if (texts.isEmpty()) summary else texts.joinToString("\n")
    }

    /** The first [maxLines] lines and how many more there were. */
    fun preview(summary: String, maxLines: Int = 3): Pair<List<String>, Int> {
        val all = resultText(summary).split('\n').filter { it.isNotEmpty() }
        return all.take(maxLines) to maxOf(0, all.size - maxLines)
    }

    data class DiffLine(val added: Boolean, val text: String)

    /** [more] counts lines left out to keep the card short. */
    data class Diff(val path: String, val lines: List<DiffLine>, val more: Int)

    /** For file edits and writes: the changed lines as red and green rows. Null for every other tool, or when the call was too long to arrive whole. */
    fun diff(summary: String, maxLines: Int = 60): Diff? {
        val obj = runCatching { Json.parseToJsonElement(summary) as? JsonObject }.getOrNull() ?: return null
        fun str(o: JsonObject, k: String) = (o[k] as? JsonPrimitive)?.contentOrNull
        val path = str(obj, "file_path") ?: str(obj, "notebook_path") ?: return null
        val pairs = mutableListOf<Pair<String, String>>()
        val old = str(obj, "old_string")
        val new = str(obj, "new_string")
        if (old != null && new != null) pairs += old to new
        (obj["edits"] as? JsonArray)?.forEach { e ->
            val eo = e as? JsonObject ?: return@forEach
            val o = str(eo, "old_string")
            val n = str(eo, "new_string")
            if (o != null && n != null) pairs += o to n
        }
        str(obj, "content")?.let { pairs += "" to it }
        if (pairs.isEmpty()) return null
        val all = buildList {
            for ((o, n) in pairs) {
                if (o.isNotEmpty()) o.split('\n').forEach { add(DiffLine(false, it)) }
                if (n.isNotEmpty()) n.split('\n').forEach { add(DiffLine(true, it)) }
            }
        }
        return Diff(path, all.take(maxLines), maxOf(0, all.size - maxLines))
    }

    private fun flatten(s: String) = s.lines().joinToString(" ").trim()
    private fun clip(s: String, limit: Int) = if (s.length <= limit) s else s.take(limit - 1) + "…"
}
