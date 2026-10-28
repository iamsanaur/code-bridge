import CodeBridgeKit
import SwiftUI

/// Earlier Claude Code conversations saved on the computer for one project (from a terminal, the desktop app or this
/// app). Pick one to carry on from the phone, either in place or as a copy that leaves the original untouched.
struct ConversationsView: View {
    let deviceId: String
    let workspaceId: String
    @Environment(AppModel.self) private var app
    @State private var runner = ActionRunner()
    @State private var picked: SavedConversation?
    @State private var created: String?

    /// A conversation touched in the last few minutes may still be open in a terminal.
    private func maybeOpen(_ c: SavedConversation) -> Bool {
        guard let date = ISO8601DateFormatter.withFraction.date(from: c.lastActiveAt) ?? ISO8601DateFormatter().date(from: c.lastActiveAt) else { return false }
        return Date().timeIntervalSince(date) < 600
    }

    var body: some View {
        List {
            Section {
                Text("Conversations saved on this computer for this project. Continuing one keeps everything Claude already knows about it.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            InlineError(message: runner.error)
            AsyncContent(load: { try await app.api.savedConversations(deviceId: deviceId, workspaceId: workspaceId) }) { items in
                if items.isEmpty {
                    ContentUnavailableView("No saved conversations", systemImage: "text.bubble", description: Text("Start a Claude Code session in this project first."))
                }
                ForEach(items) { c in
                    Button { picked = c } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(c.title).font(.body.weight(.semibold)).foregroundStyle(.primary).lineLimit(3).multilineTextAlignment(.leading)
                            HStack(spacing: 6) {
                                Text(timeAgo(c.lastActiveAt)).font(.footnote).foregroundStyle(.secondary)
                                if maybeOpen(c) { Text("· may be open on the computer").font(.footnote).foregroundStyle(Palette.warning) }
                            }
                        }
                        .padding(.vertical, 2)
                    }
                    .disabled(runner.busy)
                }
            }
        }
        .navigationTitle("Continue")
        .navigationBarTitleDisplayMode(.inline)
        .navigationDestination(item: $created) { SessionView(sessionId: $0) }
        .confirmationDialog(picked?.title ?? "", isPresented: Binding(get: { picked != nil }, set: { if !$0 { picked = nil } }), titleVisibility: .visible, presenting: picked) { c in
            Button("Continue this conversation") { start(c, asCopy: false) }
            Button("Continue as a copy") { start(c, asCopy: true) }
            Button("Cancel", role: .cancel) {}
        } message: { c in
            Text(maybeOpen(c)
                 ? "This conversation was used a moment ago and may still be open in a terminal. A copy is safer: the original stays as it is."
                 : "A copy leaves the original conversation unchanged.")
        }
    }

    private func start(_ c: SavedConversation, asCopy: Bool) {
        runner.run {
            let s = try await app.api.createLocalSession(deviceId: deviceId, CreateLocalSession(
                workspaceId: workspaceId, mode: .claudeCode, resumeId: c.id, resumeAsCopy: asCopy, resumeTitle: c.title))
            created = s.id
        }
    }
}

private extension ISO8601DateFormatter {
    static let withFraction: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
}
