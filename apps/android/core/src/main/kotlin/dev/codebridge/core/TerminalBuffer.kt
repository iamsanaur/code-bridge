package dev.codebridge.core

/** Style of a run of terminal text: ANSI colour index 0-15 (or -1 for default) and bold. */
data class TermStyle(val fg: Int = -1, val bold: Boolean = false)

data class TermSegment(val text: String, val style: TermStyle)

/**
 * Line-oriented terminal model (port of packages/shared/src/terminal.ts).
 * Supports printable text, \n, \r overwrite, \b, \t, SGR colours/bold, erase-in-line,
 * clear screen and horizontal cursor moves. Full-screen TUIs are not emulated.
 */
class TerminalBuffer(private val maxLines: Int = 5000) {
    private val lines = ArrayList<List<TermSegment>>()
    private var current = ArrayList<Pair<Char, Int>>()
    private var col = 0
    private var style = 0
    private var pending = ""
    var dropped = 0; private set
    var revision = 0L; private set

    private fun pack(fg: Int, bold: Boolean) = (fg + 1) or (if (bold) 32 else 0)
    private fun unpack(s: Int) = TermStyle(fg = (s and 31) - 1, bold = (s and 32) != 0)

    fun write(chunk: String) {
        val data = pending + chunk
        pending = ""
        var i = 0
        while (i < data.length) {
            val ch = data[i]
            if (ch == '\u001b') {
                val consumed = parseEscape(data, i)
                if (consumed == 0) {
                    pending = data.substring(i, min(data.length, i + 256))
                    break
                }
                i += consumed
                continue
            }
            when (ch) {
                '\n' -> commitLine()
                '\r' -> col = 0
                '\b' -> col = maxOf(0, col - 1)
                '\t' -> {
                    val next = (col / 8 + 1) * 8
                    while (col < next) put(' ')
                }
                else -> if (ch >= ' ' && ch != '\u007f') put(ch)
            }
            i++
        }
        revision++
    }

    private fun min(a: Int, b: Int) = if (a < b) a else b

    fun clear() {
        lines.clear()
        current = ArrayList()
        col = 0
        revision++
    }

    fun lines(): List<List<TermSegment>> = lines + listOf(compress(current))

    fun plainText(): String = lines().joinToString("\n") { line -> line.joinToString("") { it.text } }

    private fun put(ch: Char) {
        val cell = ch to style
        if (col < current.size) current[col] = cell
        else {
            while (current.size < col) current.add(' ' to 0)
            current.add(cell)
        }
        col++
    }

    private fun commitLine() {
        lines.add(compress(current))
        current = ArrayList()
        col = 0
        if (lines.size > maxLines) {
            val excess = lines.size - maxLines
            repeat(excess) { lines.removeAt(0) }
            dropped += excess
        }
    }

    private fun parseEscape(data: String, start: Int): Int {
        if (start + 1 >= data.length) return 0
        when (data[start + 1]) {
            '[' -> {
                var j = start + 2
                while (j < data.length && data[j].code !in 0x40..0x7e) j++
                if (j >= data.length) return 0
                applyCsi(data.substring(start + 2, j), data[j])
                return j - start + 1
            }
            ']' -> {
                var j = start + 2
                while (j < data.length) {
                    if (data[j] == '\u0007') return j - start + 1
                    if (data[j] == '\u001b' && j + 1 < data.length && data[j + 1] == '\\') return j - start + 2
                    j++
                }
                return 0
            }
            else -> return 2
        }
    }

    private fun applyCsi(params: String, final: Char) {
        when (final) {
            'm' -> {
                val codes = if (params.isEmpty()) listOf(0) else params.split(';').map { it.toIntOrNull() ?: 0 }
                var (fg, bold) = unpack(style)
                var k = 0
                while (k < codes.size) {
                    val c = codes[k]
                    when {
                        c == 0 -> { fg = -1; bold = false }
                        c == 1 -> bold = true
                        c == 22 -> bold = false
                        c in 30..37 -> fg = c - 30
                        c in 90..97 -> fg = c - 90 + 8
                        c == 39 -> fg = -1
                        c == 38 || c == 48 -> k += when (codes.getOrNull(k + 1)) { 5 -> 2; 2 -> 4; else -> 0 }
                    }
                    k++
                }
                style = pack(fg, bold)
            }
            'K' -> when (params.toIntOrNull() ?: 0) {
                0 -> while (current.size > col) current.removeAt(current.lastIndex)
                2 -> current = ArrayList()
            }
            'J' -> if (params == "2" || params == "3") clear()
            'G' -> col = maxOf(0, (params.toIntOrNull() ?: 1) - 1)
            'C' -> col += params.toIntOrNull() ?: 1
            'D' -> col = maxOf(0, col - (params.toIntOrNull() ?: 1))
        }
    }

    private fun compress(cells: List<Pair<Char, Int>>): List<TermSegment> {
        val out = ArrayList<TermSegment>()
        if (cells.isEmpty()) return out
        val sb = StringBuilder()
        var s = cells[0].second
        for ((ch, cs) in cells) {
            if (cs != s) {
                if (sb.isNotEmpty()) out.add(TermSegment(sb.toString(), unpack(s)))
                sb.setLength(0)
                s = cs
            }
            sb.append(ch)
        }
        if (sb.isNotEmpty()) out.add(TermSegment(sb.toString(), unpack(s)))
        return out
    }
}

fun stripAnsi(text: String): String = TerminalBuffer(Int.MAX_VALUE).apply { write(text) }.plainText()
