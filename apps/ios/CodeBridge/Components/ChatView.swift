import CodeBridgeKit
import SwiftUI

struct ChatTranscriptView: View {
    let items: [ChatItem]
    let revision: Int
    var onRetry: (() -> Void)?

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    if items.isEmpty {
                        ContentUnavailableView("Send a prompt to start", systemImage: "sparkles", description: Text("The agent works inside this workspace and asks before changing anything."))
                    }
                    ForEach(items) { item in row(item).id(item.id) }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding(.horizontal)
                .padding(.vertical, 8)
            }
            .onChange(of: revision) { withAnimation(.snappy) { proxy.scrollTo("bottom", anchor: .bottom) } }
        }
    }

    @ViewBuilder
    private func row(_ item: ChatItem) -> some View {
        switch item {
        case let .user(_, text):
            HStack {
                Spacer(minLength: 40)
                Text(text)
                    .textSelection(.enabled)
                    .padding(12)
                    .background(Color.accentColor.opacity(0.22), in: .rect(cornerRadius: 18))
            }
        case let .assistant(_, text, streaming):
            Text(text + (streaming ? " ▍" : ""))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        case let .tool(_, _, name, summary, result):
            let color: Color = result.map { $0.ok ? Palette.success : Palette.danger } ?? Palette.warning
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: result == nil ? "gearshape.2" : (result!.ok ? "checkmark.circle.fill" : "xmark.octagon.fill"))
                    .foregroundStyle(color)
                    .symbolEffect(.rotate, isActive: result == nil)
                VStack(alignment: .leading, spacing: 2) {
                    Text(name).font(.code.weight(.semibold)).foregroundStyle(color)
                    Text(result?.summary ?? summary).font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(3)
                }
            }
            .accessibilityElement(children: .combine)
        case let .failure(_, code, message, retryable):
            VStack(alignment: .leading, spacing: 6) {
                Label(code, systemImage: "exclamationmark.triangle.fill").font(.subheadline.weight(.semibold)).foregroundStyle(Palette.danger)
                Text(message).font(.footnote)
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
}

/// Floating Liquid Glass prompt composer.
struct ComposerBar: View {
    let disabledReason: String?
    let busy: Bool
    let send: (String) -> Void
    @State private var text = ""

    var body: some View {
        GlassEffectContainer(spacing: 10) {
            HStack(alignment: .bottom, spacing: 10) {
                TextField(disabledReason ?? "Ask the agent to change, test or explain something…", text: $text, axis: .vertical)
                    .lineLimit(1...6)
                    .disabled(disabledReason != nil)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                    .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 22))
                Button {
                    send(text.trimmingCharacters(in: .whitespacesAndNewlines))
                    text = ""
                } label: {
                    Image(systemName: busy ? "ellipsis" : "arrow.up").font(.headline).frame(width: 28, height: 28)
                }
                .buttonStyle(.glassProminent)
                .buttonBorderShape(.circle)
                .disabled(disabledReason != nil || busy || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityLabel("Send prompt")
            }
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
