import Foundation

/// Splits a chat reply into prose and fenced code blocks (```), so code can be shown in its own panel.
public enum MessageBlocks {
    public struct Block: Equatable, Sendable {
        public var code: Bool
        public var text: String
    }

    /// A fence that is still open (the reply is streaming) counts as code to the end.
    public static func split(_ text: String) -> [Block] {
        var blocks: [Block] = []
        var lines: [Substring] = []
        var inCode = false
        func flush() {
            let joined = lines.joined(separator: "\n")
            let t = inCode ? String(joined.reversed().drop(while: { $0 == "\n" }).reversed()) : joined.trimmingCharacters(in: .newlines)
            if !t.isEmpty { blocks.append(Block(code: inCode, text: t)) }
            lines.removeAll()
        }
        for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
            if line.drop(while: { $0 == " " || $0 == "\t" }).hasPrefix("```") {
                flush()
                inCode.toggle()
            } else {
                lines.append(line)
            }
        }
        flush()
        return blocks
    }
}
