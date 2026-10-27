import Foundation

public struct TermStyle: Equatable, Hashable, Sendable {
    public var fg: Int = -1 // ANSI colour index 0-15, -1 = default
    public var bold = false
    public init(fg: Int = -1, bold: Bool = false) {
        self.fg = fg
        self.bold = bold
    }
}

public struct TermSegment: Equatable, Hashable, Sendable {
    public var text: String
    public var style: TermStyle
}

/// Line-oriented terminal model (port of packages/shared/src/terminal.ts).
/// Handles text, \n, \r overwrite, \b, \t, SGR colours/bold, erase-in-line, clear
/// screen and horizontal cursor moves. Full-screen TUIs are not emulated.
public struct TerminalBuffer: Sendable {
    private var lines: [[TermSegment]] = []
    private var current: [(Character, Int)] = []
    private var col = 0
    private var style = 0
    private var pending: [Character] = []
    private let maxLines: Int
    public private(set) var dropped = 0
    public private(set) var revision = 0

    public init(maxLines: Int = 5000) { self.maxLines = maxLines }

    private func pack(_ fg: Int, _ bold: Bool) -> Int { (fg + 1) | (bold ? 32 : 0) }
    private func unpack(_ s: Int) -> TermStyle { TermStyle(fg: (s & 31) - 1, bold: s & 32 != 0) }

    public mutating func write(_ chunk: String) {
        // Work on unicode scalars-as-characters; escape sequences are ASCII.
        let data = pending + Array(chunk)
        pending = []
        var i = 0
        while i < data.count {
            let ch = data[i]
            if ch == "\u{1B}" {
                let consumed = parseEscape(data, i)
                if consumed == 0 {
                    pending = Array(data[i..<Swift.min(data.count, i + 256)])
                    break
                }
                i += consumed
                continue
            }
            switch ch {
            case "\n", "\r\n": commitLine()
            case "\r": col = 0
            case "\u{08}": col = Swift.max(0, col - 1)
            case "\t":
                let next = (col / 8 + 1) * 8
                while col < next { put(" ") }
            default:
                if let a = ch.asciiValue, a < 0x20 || a == 0x7F { break }
                put(ch)
            }
            i += 1
        }
        revision += 1
    }

    public mutating func clear() {
        lines = []
        current = []
        col = 0
        revision += 1
    }

    public func allLines() -> [[TermSegment]] { lines + [compress(current)] }

    public func plainText() -> String { allLines().map { $0.map(\.text).joined() }.joined(separator: "\n") }

    private mutating func put(_ ch: Character) {
        let cell = (ch, style)
        if col < current.count { current[col] = cell } else {
            while current.count < col { current.append((" ", 0)) }
            current.append(cell)
        }
        col += 1
    }

    private mutating func commitLine() {
        lines.append(compress(current))
        current = []
        col = 0
        if lines.count > maxLines {
            let excess = lines.count - maxLines
            lines.removeFirst(excess)
            dropped += excess
        }
    }

    private mutating func parseEscape(_ data: [Character], _ start: Int) -> Int {
        guard start + 1 < data.count else { return 0 }
        switch data[start + 1] {
        case "[":
            var j = start + 2
            while j < data.count, !(data[j].asciiValue.map { (0x40...0x7E).contains($0) } ?? false) { j += 1 }
            guard j < data.count else { return 0 }
            applyCsi(String(data[(start + 2)..<j]), data[j])
            return j - start + 1
        case "]":
            var j = start + 2
            while j < data.count {
                if data[j] == "\u{07}" { return j - start + 1 }
                if data[j] == "\u{1B}", j + 1 < data.count, data[j + 1] == "\\" { return j - start + 2 }
                j += 1
            }
            return 0
        default:
            return 2
        }
    }

    private mutating func applyCsi(_ params: String, _ final: Character) {
        switch final {
        case "m":
            let codes = params.isEmpty ? [0] : params.split(separator: ";", omittingEmptySubsequences: false).map { Int($0) ?? 0 }
            var s = unpack(style)
            var k = 0
            while k < codes.count {
                let c = codes[k]
                switch c {
                case 0: s = TermStyle()
                case 1: s.bold = true
                case 22: s.bold = false
                case 30...37: s.fg = c - 30
                case 90...97: s.fg = c - 90 + 8
                case 39: s.fg = -1
                case 38, 48: k += (k + 1 < codes.count && codes[k + 1] == 5) ? 2 : (k + 1 < codes.count && codes[k + 1] == 2) ? 4 : 0
                default: break
                }
                k += 1
            }
            style = pack(s.fg, s.bold)
        case "K":
            switch Int(params) ?? 0 {
            case 0: if current.count > col { current.removeLast(current.count - col) }
            case 2: current = []
            default: break
            }
        case "J": if params == "2" || params == "3" { clear() }
        case "G": col = Swift.max(0, (Int(params) ?? 1) - 1)
        case "C": col += Int(params) ?? 1
        case "D": col = Swift.max(0, col - (Int(params) ?? 1))
        default: break
        }
    }

    private func compress(_ cells: [(Character, Int)]) -> [TermSegment] {
        var out: [TermSegment] = []
        guard var s = cells.first?.1 else { return out }
        var text = ""
        for (ch, cs) in cells {
            if cs != s {
                if !text.isEmpty { out.append(TermSegment(text: text, style: unpack(s))) }
                text = ""
                s = cs
            }
            text.append(ch)
        }
        if !text.isEmpty { out.append(TermSegment(text: text, style: unpack(s))) }
        return out
    }
}

public func stripAnsi(_ text: String) -> String {
    var t = TerminalBuffer(maxLines: .max)
    t.write(text)
    return t.plainText()
}
