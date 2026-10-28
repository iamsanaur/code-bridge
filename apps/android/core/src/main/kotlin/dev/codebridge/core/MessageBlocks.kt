package dev.codebridge.core

/** Splits a chat reply into prose and fenced code blocks (```), so code can be shown in its own panel. */
object MessageBlocks {
    data class Block(val code: Boolean, val text: String)

    /** A fence that is still open (the reply is streaming) counts as code to the end. */
    fun split(text: String): List<Block> {
        val blocks = mutableListOf<Block>()
        val buf = StringBuilder()
        var inCode = false
        fun flush() {
            val t = if (inCode) buf.toString().trimEnd('\n') else buf.toString().trim('\n')
            if (t.isNotEmpty() || inCode) blocks += Block(inCode, t)
            buf.clear()
        }
        for (line in text.split('\n')) {
            if (line.trimStart().startsWith("```")) {
                flush()
                inCode = !inCode
            } else {
                if (buf.isNotEmpty()) buf.append('\n')
                buf.append(line)
            }
        }
        flush()
        return blocks.filter { it.text.isNotEmpty() }
    }
}
