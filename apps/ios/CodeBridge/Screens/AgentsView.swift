import CodeBridgeKit
import SwiftUI

/// Every Claude Code session across your computers, grouped by what needs you: waiting on an approval, working, or
/// idle. Tap one to open it; cancel a running turn without opening it; start another agent in any project.
struct AgentsView: View {
    @Environment(AppModel.self) private var app
    @State private var trigger = 0
    @State private var runner = ActionRunner()
    @State private var confirmStop: Session?

    private struct Snapshot {
        var sessions: [Session]
        var devices: [Device]
    }

    var body: some View {
        List {
            AsyncContent(load: { try await load() }, reloadTrigger: trigger) { snap in
                content(snap)
            }
        }
        .navigationTitle("Agents")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) { NewAgentMenu() }
        }
        .refreshable { trigger += 1 }
        .refreshOnRealtime($trigger)
        .codeBridgeDestinations()
        .confirmationDialog("Stop this agent?", isPresented: Binding(get: { confirmStop != nil }, set: { if !$0 { confirmStop = nil } }), titleVisibility: .visible, presenting: confirmStop) { s in
            Button("Stop", role: .destructive) { runner.run { try await app.api.signal(s.id, terminate: true); trigger += 1 } }
        } message: { _ in Text("Ends the session on your computer. Its history stays readable.") }
    }

    private func load() async throws -> Snapshot {
        async let sessions = app.api.sessions(active: true)
        async let devices = app.api.devices()
        return Snapshot(sessions: try await sessions.filter { $0.mode == .claudeCode || $0.mode == .agent }, devices: try await devices)
    }

    @ViewBuilder
    private func content(_ snap: Snapshot) -> some View {
        let needs = snap.sessions.filter { $0.status == .waiting }
        let working = snap.sessions.filter { $0.status.group == .running }
        let idle = snap.sessions.filter { $0.status == .idle }
        Section { Summary(needs: needs.count, working: working.count, idle: idle.count, computers: snap.devices.filter(\.online).count) }
        InlineError(message: runner.error)
        if snap.sessions.isEmpty {
            ContentUnavailableView {
                Label("No agents running", systemImage: "person.3")
            } description: {
                Text("Start one in any project on your computers. Each agent works on its own, and you can run several at once.")
            } actions: {
                NewAgentMenu(prominent: true)
            }
        }
        group("Needs you", needs, snap)
        group("Working", working, snap)
        group("Waiting for a prompt", idle, snap)
        Section {
            NavigationLink(value: Route.history) { Label("History and cloud sessions", systemImage: "clock.arrow.circlepath") }
        }
    }

    @ViewBuilder
    private func group(_ title: String, _ sessions: [Session], _ snap: Snapshot) -> some View {
        if !sessions.isEmpty {
            Section(title) {
                ForEach(sessions) { s in
                    NavigationLink(value: Route.session(s.id)) { AgentRow(session: s) }
                        .swipeActions(edge: .trailing) {
                            Button("Stop", role: .destructive) { confirmStop = s }
                        }
                        .swipeActions(edge: .leading) {
                            if s.status.group == .running {
                                Button("Cancel turn") { runner.run { try await app.api.signal(s.id, terminate: false); trigger += 1 } }.tint(Palette.warning)
                            }
                        }
                        .contextMenu {
                            Button("Cancel turn", systemImage: "stop.circle") { runner.run { try await app.api.signal(s.id, terminate: false); trigger += 1 } }
                                .disabled(s.status.group != .running)
                            Button("Stop agent", systemImage: "xmark.octagon", role: .destructive) { confirmStop = s }
                        }
                }
            }
        }
    }
}

private struct Summary: View {
    let needs: Int
    let working: Int
    let idle: Int
    let computers: Int
    var body: some View {
        HStack(spacing: 0) {
            stat(needs, "Need you", Palette.warning)
            stat(working, "Working", .blue)
            stat(idle, "Idle", .secondary)
            stat(computers, "Online", Palette.success)
        }
        .accessibilityElement(children: .combine)
    }

    private func stat(_ n: Int, _ label: String, _ color: Color) -> some View {
        VStack(spacing: 2) {
            Text("\(n)").font(.title2.weight(.semibold)).foregroundStyle(n > 0 ? color : .secondary).monospacedDigit()
            Text(label).font(.caption).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
    }
}

private struct AgentRow: View {
    let session: Session

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            StatusDot(status: session.status)
                .padding(.top, 6)
            VStack(alignment: .leading, spacing: 4) {
                Text(session.title).font(.body.weight(.semibold)).lineLimit(2)
                Text("\(session.deviceName ?? "Computer") · \(session.workspaceName ?? "")")
                    .font(.footnote).foregroundStyle(.secondary)
                HStack(spacing: 8) {
                    Text(session.status == .waiting ? "Waiting for your approval" : session.status.label)
                        .font(.caption.weight(.medium)).foregroundStyle(session.status.tint)
                    Text("· \(timeAgo(session.createdAt))").font(.caption).foregroundStyle(.secondary)
                    if let u = session.usage { Text("· \(formatUSD(u.estimatedCostUsd))").font(.caption).foregroundStyle(.secondary) }
                }
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}

private struct StatusDot: View {
    let status: SessionStatus
    @State private var pulse = false
    var body: some View {
        Circle()
            .fill(status.tint)
            .frame(width: 10, height: 10)
            .scaleEffect(status.group == .running && pulse ? 1.35 : 1)
            .opacity(status.group == .running && pulse ? 0.6 : 1)
            .animation(status.group == .running ? .easeInOut(duration: 0.9).repeatForever(autoreverses: true) : .default, value: pulse)
            .onAppear { pulse = true }
    }
}

/// Start another agent: pick an online computer, then one of its projects.
private struct NewAgentMenu: View {
    var prominent = false
    @Environment(AppModel.self) private var app
    @State private var devices: [Device] = []

    var body: some View {
        Menu {
            let online = devices.filter(\.online)
            if online.isEmpty { Text("No computer is online") }
            ForEach(online) { d in
                Section(d.name) {
                    if d.workspaces.isEmpty { Text("No projects yet") }
                    ForEach(d.workspaces) { w in
                        NavigationLink(value: Route.newSession(deviceId: d.id, workspaceId: w.id)) { Label(w.name, systemImage: "folder") }
                    }
                }
            }
        } label: {
            if prominent { Label("New agent", systemImage: "plus") } else { Image(systemName: "plus") }
        }
        .accessibilityLabel("New agent")
        .task { devices = (try? await app.api.devices()) ?? [] }
    }
}
