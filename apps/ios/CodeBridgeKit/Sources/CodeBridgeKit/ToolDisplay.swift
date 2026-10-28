import Foundation

/// How a tool call reads in the chat, in the style of Claude Code: `Bash(npm test)` with the
/// result underneath as `⎿ first lines… +N lines`.
public enum ToolDisplay {
    private static let argumentKeys = [
        "command", "file_path", "path", "notebook_path", "pattern", "url", "query", "description", "prompt",
    ]

    /// Claude Code's tool for starting a subagent (called `Task` in older versions, `Agent` in newer ones).
    public static func isSubagent(_ name: String) -> Bool { name == "Task" || name == "Agent" }

    /// What a subagent was asked to do and which kind it is.
    public static func subagentInfo(summary: String) -> (description: String?, type: String?) {
        guard let data = summary.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return (nil, nil) }
        return (obj["description"] as? String, obj["subagent_type"] as? String)
    }

    /// A subagent's final report, without the harness's "[Subagent hand-back]" preamble and its indentation.
    public static func subagentReport(_ result: String) -> String {
        let text = resultText(result)
        var body = Substring(text)
        if let r = text.range(of: "The report follows:") { body = text[r.upperBound...] }
        // The harness appends the agent's id and token usage after the report; the phone has no use for them.
        let lines = body.split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.hasPrefix("  ") ? String($0.dropFirst(2)) : String($0) }
        let kept = lines.prefix { !$0.hasPrefix("agentId:") && !$0.hasPrefix("<usage>") }
        return kept.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// The one argument worth showing next to the tool name, or nil when there is none.
    public static func headline(summary: String, limit: Int = 90) -> String? {
        guard let data = summary.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            let flat = flatten(summary)
            return flat.isEmpty ? nil : clip(flat, limit)
        }
        for key in argumentKeys {
            if let value = obj[key] as? String, !value.isEmpty { return clip(flatten(value), limit) }
        }
        return nil
    }

    /// Result text with Claude Code's `[{"type":"text","text":"…"}]` wrapping removed.
    public static func resultText(_ summary: String) -> String {
        // An older agent sent a picture's base64, cut off mid-JSON, so it cannot be parsed.
        if summary.hasPrefix(#"[{"type":"image""#) { return "[image]" }
        guard summary.hasPrefix("["), let data = summary.data(using: .utf8),
              let blocks = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return summary }
        // Pictures come back as base64 blocks; the app shows the file itself, so say "[image]" here.
        let texts = blocks.compactMap { b -> String? in b["type"] as? String == "image" ? "[image]" : b["text"] as? String }
        return texts.isEmpty ? summary : texts.joined(separator: "\n")
    }

    /// The first `maxLines` lines and how many more there were.
    public static func preview(_ summary: String, maxLines: Int = 3) -> (lines: [String], more: Int) {
        let all = resultText(summary).split(separator: "\n", omittingEmptySubsequences: true).map(String.init)
        return (Array(all.prefix(maxLines)), max(0, all.count - maxLines))
    }

    public struct DiffLine: Equatable, Sendable {
        public enum Kind: Sendable { case added, removed }
        public var kind: Kind
        public var text: String
    }

    public struct Diff: Equatable, Sendable {
        public var path: String
        public var lines: [DiffLine]
        /// Lines left out to keep the card short.
        public var more: Int
    }

    /// For file edits and writes: the changed lines as red and green rows. Nil for every other tool, or when the
    /// call was too long to arrive whole.
    public static func diff(name: String, summary: String, maxLines: Int = 60) -> Diff? {
        guard let data = summary.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let path = (obj["file_path"] ?? obj["notebook_path"]) as? String else { return nil }
        var pairs: [(old: String, new: String)] = []
        if let o = obj["old_string"] as? String, let n = obj["new_string"] as? String { pairs.append((o, n)) }
        if let edits = obj["edits"] as? [[String: Any]] {
            for e in edits { if let o = e["old_string"] as? String, let n = e["new_string"] as? String { pairs.append((o, n)) } }
        }
        if let content = obj["content"] as? String { pairs.append(("", content)) }
        guard !pairs.isEmpty else { return nil }
        var all: [DiffLine] = []
        for p in pairs {
            for l in p.old.split(separator: "\n", omittingEmptySubsequences: false) where !(p.old.isEmpty) { all.append(.init(kind: .removed, text: String(l))) }
            for l in p.new.split(separator: "\n", omittingEmptySubsequences: false) where !(p.new.isEmpty) { all.append(.init(kind: .added, text: String(l))) }
        }
        return Diff(path: path, lines: Array(all.prefix(maxLines)), more: max(0, all.count - maxLines))
    }

    private static func flatten(_ s: String) -> String {
        s.split(whereSeparator: \.isNewline).joined(separator: " ").trimmingCharacters(in: .whitespaces)
    }

    private static func clip(_ s: String, _ limit: Int) -> String {
        s.count <= limit ? s : String(s.prefix(limit - 1)) + "…"
    }
}
