import Foundation

/// Finds the images a chat message or tool call is about, so the app can fetch and show them from the computer.
public enum ImageRefs {
    private static let regex = try! NSRegularExpression(pattern: #"[A-Za-z0-9_@%+=,.\-/~]+\.(?:png|jpe?g|gif|webp)\b"#, options: [.caseInsensitive])

    /// File names or paths that end in an image extension, in order, without repeats. Web addresses are skipped.
    public static func paths(in text: String, limit: Int = 4) -> [String] {
        let ns = text as NSString
        var seen = Set<String>()
        var out: [String] = []
        for m in regex.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            if m.range.location > 0, ns.substring(with: NSRange(location: m.range.location - 1, length: 1)) == ":" { continue }
            let p = ns.substring(with: m.range)
            if p.hasPrefix("//") || p.hasPrefix("http") || !seen.insert(p).inserted { continue }
            out.append(p)
            if out.count == limit { break }
        }
        return out
    }

    /// Images for a tool card: the file a Read or Write call is about, plus any image paths in what it printed.
    public static func forTool(summary: String, result: String?, limit: Int = 4) -> [String] {
        var out: [String] = []
        if let data = summary.data(using: .utf8),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let file = obj["file_path"] as? String, !paths(in: file).isEmpty {
            out.append(file)
        }
        for p in paths(in: ToolDisplay.resultText(result ?? ""), limit: limit) where !out.contains(p) { out.append(p) }
        return Array(out.prefix(limit))
    }
}
