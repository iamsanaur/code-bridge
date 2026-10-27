import CodeBridgeKit
import SwiftUI
import UIKit

extension TermSegment {
    var attributed: AttributedString {
        var a = AttributedString(text)
        if (0..<16).contains(style.fg) { a.foregroundColor = Palette.ansi[style.fg] }
        if style.bold { a.font = Font.terminal.bold() }
        return a
    }
}

/// Live terminal output. Follows new output while you're at the bottom; scroll up
/// to read history and a floating glass "Latest" button appears.
struct TerminalOutputView: View {
    let lines: [[TermSegment]]
    let revision: Int
    let dropped: Int
    @State private var follow = true
    @Namespace private var glass

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if dropped > 0 {
                        Text("\(dropped) earlier lines trimmed").font(.caption2).foregroundStyle(.secondary)
                    }
                    ForEach(lines.indices, id: \.self) { i in
                        Text(lines[i].isEmpty ? AttributedString(" ") : lines[i].reduce(into: AttributedString()) { $0 += $1.attributed })
                            .font(.terminal)
                            .foregroundStyle(Palette.terminalText)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .id(i)
                    }
                    Color.clear.frame(height: 1).id("bottom")
                        .onAppear { follow = true }
                        .onDisappear { follow = false }
                }
                .textSelection(.enabled)
                .padding(10)
            }
            .background(Palette.terminalBackground, in: .rect(cornerRadius: 16))
            .onChange(of: revision) {
                if follow { proxy.scrollTo("bottom", anchor: .bottom) }
            }
            .overlay(alignment: .bottomTrailing) {
                if !follow {
                    Button {
                        withAnimation(.snappy) { proxy.scrollTo("bottom", anchor: .bottom) }
                    } label: {
                        Label("Latest", systemImage: "arrow.down")
                    }
                    .buttonStyle(.glass)
                    .padding(12)
                    .transition(.scale.combined(with: .opacity))
                    .accessibilityLabel("Jump to latest output")
                }
            }
            .animation(.snappy, value: follow)
            .accessibilityLabel("Terminal output")
        }
    }
}

/// Floating Liquid Glass key bar + input line for terminal sessions.
struct TerminalInputBar: View {
    let disabledReason: String?
    let send: (String) -> Void
    @State private var text = ""
    @FocusState private var focused: Bool

    private struct Key: Identifiable {
        let label: String
        let data: String
        let spoken: String
        var id: String { label }
    }

    private static let keys: [Key] = [
        Key(label: "esc", data: "\u{1B}", spoken: "Escape"), Key(label: "tab", data: "\t", spoken: "Tab"),
        Key(label: "⌃C", data: "\u{03}", spoken: "Control C"), Key(label: "⌃D", data: "\u{04}", spoken: "Control D"),
        Key(label: "↑", data: "\u{1B}[A", spoken: "Up arrow"), Key(label: "↓", data: "\u{1B}[B", spoken: "Down arrow"),
        Key(label: "←", data: "\u{1B}[D", spoken: "Left arrow"), Key(label: "→", data: "\u{1B}[C", spoken: "Right arrow"),
        Key(label: "|", data: "|", spoken: "Pipe"), Key(label: "~", data: "~", spoken: "Tilde"), Key(label: "/", data: "/", spoken: "Slash"),
    ]

    var body: some View {
        let enabled = disabledReason == nil
        GlassEffectContainer(spacing: 8) {
            VStack(spacing: 8) {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(Self.keys) { key in
                            Button { send(key.data) } label: {
                                Text(key.label).font(.system(.callout, design: .monospaced)).frame(minWidth: 30, minHeight: 30)
                            }
                            .buttonStyle(.glass)
                            .disabled(!enabled)
                            .accessibilityLabel("Send \(key.spoken)")
                        }
                    }
                    .padding(.horizontal, 2)
                }
                HStack(spacing: 8) {
                    TextField(disabledReason ?? "Type a line and press return", text: $text)
                        .font(.system(.body, design: .monospaced))
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.send)
                        .focused($focused)
                        .onSubmit { submit() }
                        .disabled(!enabled)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .glassEffect(.regular.interactive(), in: .capsule)
                    Button {
                        if let s = UIPasteboard.general.string { text += s }
                    } label: { Image(systemName: "doc.on.clipboard") }
                        .buttonStyle(.glass)
                        .disabled(!enabled)
                        .accessibilityLabel("Paste from clipboard")
                    Button { submit() } label: { Image(systemName: "return") }
                        .buttonStyle(.glassProminent)
                        .disabled(!enabled)
                        .accessibilityLabel("Send line")
                }
            }
        }
    }

    private func submit() {
        send(text + "\r")
        text = ""
        focused = true
    }
}
