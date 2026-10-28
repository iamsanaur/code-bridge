import CodeBridgeKit
import SwiftUI

/// The conversation, laid out like Claude Code's own apps: your messages as blue bubbles, Claude's replies as plain
/// text under a "Claude" header, and every tool call as a collapsible card (file edits show their changed lines).
struct ChatTranscriptView: View {
    let items: [ChatItem]
    let revision: Int
    var working = false
    var onRetry: (() -> Void)?

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 14) {
                if items.isEmpty {
                    VStack(spacing: 10) {
                        ClaudeMark(size: 44)
                        Text("Claude Code").font(.title3.weight(.semibold))
                        Text("Runs on your computer, in this folder. Ask it to read, change or test something.")
                            .font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.top, 48)
                }
                ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                    row(item, startsRun: index == 0 || items[index - 1].isUser)
                }
                if working { WorkingLine() }
                Color.clear.frame(height: 1).id("bottom")
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
        }
        // Stay pinned to the newest line while text streams in and rows change height.
        .defaultScrollAnchor(.bottom, for: .sizeChanges)
        .defaultScrollAnchor(.bottom, for: .initialOffset)
        .scrollDismissesKeyboard(.interactively)
    }

    @ViewBuilder
    private func row(_ item: ChatItem, startsRun: Bool) -> some View {
        switch item {
        case let .user(_, text):
            HStack {
                Spacer(minLength: 48)
                Text(text)
                    .textSelection(.enabled)
                    .foregroundStyle(.white)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(Palette.userBubble, in: .rect(cornerRadius: 20))
            }
        case let .assistant(_, text, streaming):
            VStack(alignment: .leading, spacing: 8) {
                if startsRun { ClaudeHeader() }
                Text(markdown(text) + (streaming ? AttributedString(" ▍") : AttributedString()))
                    .font(.body)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        case let .tool(_, _, name, summary, result):
            VStack(alignment: .leading, spacing: 8) {
                if startsRun { ClaudeHeader() }
                ToolCard(name: name, summary: summary, result: result)
            }
        case let .failure(_, code, message, retryable):
            VStack(alignment: .leading, spacing: 8) {
                Label(code, systemImage: "exclamationmark.triangle.fill")
                    .font(.subheadline.weight(.semibold)).foregroundStyle(Palette.danger)
                Text(message).font(.footnote).textSelection(.enabled)
                if retryable, let onRetry {
                    Button("Retry last prompt", action: onRetry).buttonStyle(.glass)
                }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Palette.danger.opacity(0.12), in: .rect(cornerRadius: 14))
        case let .notice(_, text):
            Text(text).font(.caption).foregroundStyle(.secondary).frame(maxWidth: .infinity)
        }
    }

    /// Bold, italics, `code` and links; line breaks are kept as typed.
    private func markdown(_ text: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        return (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
    }
}

extension ChatItem {
    var isUser: Bool { if case .user = self { true } else { false } }
}

private struct ClaudeMark: View {
    let size: CGFloat
    var body: some View {
        Image(systemName: "asterisk")
            .font(.system(size: size * 0.5, weight: .bold))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(Palette.claude, in: .rect(cornerRadius: size * 0.28))
            .accessibilityHidden(true)
    }
}

private struct ClaudeHeader: View {
    var body: some View {
        HStack(spacing: 10) {
            ClaudeMark(size: 28)
            Text("Claude").font(.headline)
        }
        .accessibilityElement(children: .combine)
    }
}

/// One tool call: a card with a coloured edge, collapsed to `Tool / argument`. Edits and writes open to show the
/// lines they changed; other tools show what was asked and what came back.
private struct ToolCard: View {
    let name: String
    let summary: String
    let result: ToolOutcome?
    @State private var expanded: Bool?

    private var diff: ToolDisplay.Diff? { ToolDisplay.diff(name: name, summary: summary) }
    private var isOpen: Bool { expanded ?? (diff != nil) }
    private var edge: Color { result.map { $0.ok ? Palette.success : Palette.danger } ?? Palette.warning }

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            Rectangle().fill(edge).frame(width: 3)
            VStack(alignment: .leading, spacing: 8) {
                Button { withAnimation(.snappy) { expanded = !isOpen } } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "chevron.right").font(.caption.weight(.semibold))
                            .rotationEffect(.degrees(isOpen ? 90 : 0)).foregroundStyle(.secondary)
                        (Text(name).fontWeight(.medium) + Text("  /  ").foregroundStyle(.tertiary)
                         + Text(diff?.path.components(separatedBy: "/").last ?? ToolDisplay.headline(summary: summary) ?? "Details")
                            .font(.system(.subheadline, design: .monospaced)).foregroundColor(diff == nil ? .secondary : .accentColor))
                            .font(.subheadline)
                            .lineLimit(1)
                        Spacer(minLength: 0)
                        if result == nil { ProgressView().controlSize(.mini) }
                    }
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityHint(isOpen ? "Hide details" : "Show details")

                if isOpen { details }
            }
            .padding(.leading, 10)
            .padding(.vertical, 4)
        }
    }

    @ViewBuilder
    private var details: some View {
        if let diff {
            VStack(alignment: .leading, spacing: 0) {
                Text(diff.path).font(.system(.caption, design: .monospaced)).foregroundStyle(.secondary)
                    .lineLimit(1).truncationMode(.head).padding(8)
                ForEach(Array(diff.lines.enumerated()), id: \.offset) { _, line in
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(line.kind == .added ? "+" : "−").foregroundStyle(line.kind == .added ? Palette.success : Palette.danger)
                        Text(line.text.isEmpty ? " " : line.text)
                    }
                    .font(.system(size: 12, design: .monospaced))
                    .padding(.horizontal, 8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background((line.kind == .added ? Palette.success : Palette.danger).opacity(0.12))
                }
                if diff.more > 0 { Text("… +\(diff.more) more lines").font(.caption).foregroundStyle(.secondary).padding(8) }
            }
            .background(.quaternary.opacity(0.5), in: .rect(cornerRadius: 10))
            .clipShape(.rect(cornerRadius: 10))
        } else {
            VStack(alignment: .leading, spacing: 8) {
                Text(summary).font(.system(size: 12, design: .monospaced)).foregroundStyle(.secondary).lineLimit(8)
                if let result {
                    let p = ToolDisplay.preview(result.summary, maxLines: 12)
                    VStack(alignment: .leading, spacing: 2) {
                        ForEach(Array(p.lines.enumerated()), id: \.offset) { _, l in Text(l).lineLimit(3) }
                        if p.more > 0 { Text("… +\(p.more) lines").foregroundStyle(.secondary) }
                        if p.lines.isEmpty { Text(result.ok ? "Done" : "Failed") }
                    }
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(result.ok ? Color.primary : Palette.danger)
                }
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.quaternary.opacity(0.5), in: .rect(cornerRadius: 10))
            .textSelection(.enabled)
        }
    }
}

/// Shown while a turn is running.
private struct WorkingLine: View {
    var body: some View {
        HStack(spacing: 8) {
            ProgressView().controlSize(.small)
            Text("Working…").font(.subheadline).foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Claude Code is working")
    }
}

/// The prompt box: a rounded input with a send button, floating on glass.
struct ComposerBar: View {
    let disabledReason: String?
    let busy: Bool
    let send: (String) -> Void
    @State private var text = ""
    @FocusState private var focused: Bool

    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        HStack(alignment: .bottom, spacing: 10) {
            TextField(disabledReason ?? "Ask Claude anything…", text: $text, axis: .vertical)
                .lineLimit(1...6)
                .focused($focused)
                .disabled(disabledReason != nil)
                .textInputAutocapitalization(.sentences)
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 22))
            Button {
                let message = trimmed
                text = ""
                send(message)
            } label: {
                Image(systemName: busy ? "ellipsis" : "arrow.up").font(.headline).frame(width: 28, height: 28)
            }
            .buttonStyle(.glassProminent)
            .buttonBorderShape(.circle)
            .disabled(disabledReason != nil || busy || trimmed.isEmpty)
            .accessibilityLabel("Send prompt")
        }
    }
}

/// A tool waiting for the user's decision. Nothing runs until Approve is pressed.
struct ApprovalCard: View {
    let approval: PendingApproval
    let busy: Bool
    let decide: (Bool) -> Void
    @State private var expanded = false

    private var color: Color {
        switch approval.risk {
        case "high": Palette.danger
        case "medium": Palette.warning
        default: Palette.success
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Approval needed · \(approval.risk) risk", systemImage: "hand.raised.fill")
                .font(.caption.weight(.semibold))
                .foregroundStyle(color)
            Text(approval.title).font(.headline)
            Text(approval.detail)
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
                .lineLimit(expanded ? nil : 8)
                .textSelection(.enabled)
            Button(expanded ? "Show less" : "Show full details") { withAnimation { expanded.toggle() } }
                .font(.footnote)
            GlassEffectContainer(spacing: 10) {
                HStack(spacing: 10) {
                    Button(role: .destructive) { decide(false) } label: { Text("Reject").frame(maxWidth: .infinity) }
                        .buttonStyle(.glass)
                    Button { decide(true) } label: { Text("Approve").frame(maxWidth: .infinity) }
                        .buttonStyle(.glassProminent)
                }
                .controlSize(.large)
                .disabled(busy)
            }
        }
        .padding(16)
        .background(.background.secondary, in: .rect(cornerRadius: 22))
        .overlay(RoundedRectangle(cornerRadius: 22).strokeBorder(color.opacity(0.6)))
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isModal)
    }
}
