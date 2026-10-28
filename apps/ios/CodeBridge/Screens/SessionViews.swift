import CodeBridgeKit
import SwiftUI
import UIKit

struct SessionsView: View {
    enum Filter: String, CaseIterable, Identifiable {
        case active = "Active", local = "Local Mac", cloud = "Cloud", finished = "Finished"
        var id: String { rawValue }
    }

    @Environment(AppModel.self) private var app
    @State private var filter = Filter.active
    @State private var trigger = 0

    var body: some View {
        List {
            AsyncContent(load: { try await load() }, reloadTrigger: trigger) { sessions in
                if sessions.isEmpty { ContentUnavailableView("No sessions", systemImage: "terminal") }
                ForEach(sessions) { s in NavigationLink(value: Route.session(s.id)) { SessionRow(session: s) } }
            }
            .id(filter)
        }
        .navigationTitle("Sessions")
        .toolbar {
            ToolbarItem(placement: .principal) {
                Picker("Filter", selection: $filter) {
                    ForEach(Filter.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                .fixedSize()
            }
        }
        .refreshable { trigger += 1 }
        .refreshOnRealtime($trigger)
        .codeBridgeDestinations()
    }

    private func load() async throws -> [Session] {
        switch filter {
        case .active: try await app.api.sessions(active: true)
        case .local: try await app.api.sessions(kind: .local)
        case .cloud: try await app.api.sessions(kind: .cloud)
        case .finished: try await app.api.sessions(active: false)
        }
    }
}

struct NewSessionView: View {
    let deviceId: String
    let workspaceId: String
    @Environment(AppModel.self) private var app
    @State private var mode = SessionMode.command
    @State private var presetId: String?
    @State private var custom = ""
    @State private var prompt = ""
    @State private var confirmReason: String?
    @State private var runner = ActionRunner()
    @State private var created: String?

    var body: some View {
        Form {
            AsyncContent(load: { try await app.api.device(deviceId) }) { d in
                let caps = d.capabilities
                let ws = d.workspaces.first { $0.id == workspaceId }
                Section {
                    Label("Runs on \(d.name) in \(ws?.displayPath ?? workspaceId)", systemImage: "laptopcomputer").font(.footnote).foregroundStyle(Palette.local)
                }
                Section("What should run?") {
                    modeRow(.command, "Command", "Run a preset (or allowed custom) command in a terminal", "terminal", nil)
                    modeRow(.agent, "Coding agent (Anthropic API)", "Claude edits and tests this project with your key on the Mac. Edits and non-preset commands need your approval.", "sparkles",
                            caps?.anthropicKeyConfigured == true ? nil : "No API key on this Mac. Run `codebridge-agent credentials set` on the Mac.")
                    modeRow(.claudeCode, "Claude Code (local CLI)", "Runs your installed `claude` CLI headlessly with its own login and permission settings.", "chevron.left.forwardslash.chevron.right",
                            caps?.claudeCodeAvailable == true ? nil : "Claude Code CLI not found on this Mac")
                    modeRow(.shell, "Interactive shell", "A login shell in this folder. Equivalent to full shell access.", "apple.terminal",
                            caps?.allowInteractiveShell == true ? nil : "Disabled on this Mac (codebridge-agent policy set allowInteractiveShell true)")
                }
                if mode == .command {
                    Section("Presets") {
                        ForEach(d.presets) { p in
                            Button {
                                presetId = presetId == p.id ? nil : p.id
                                custom = ""
                            } label: {
                                HStack {
                                    Text(p.label).font(.code)
                                    Spacer()
                                    if presetId == p.id { Image(systemName: "checkmark").foregroundStyle(.tint) }
                                }
                            }
                            .accessibilityAddTraits(presetId == p.id ? .isSelected : [])
                        }
                    }
                    Section {
                        TextField(caps?.allowCustomCommands == true ? "e.g. npm run dev" : "Disabled on this Mac (allowCustomCommands)", text: $custom)
                            .font(.code)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .disabled(caps?.allowCustomCommands != true)
                            .onChange(of: custom) { if !custom.isEmpty { presetId = nil } }
                    } header: { Text("Or a custom command") } footer: { Text("Commands run without a shell: no pipes, redirects or globbing.") }
                }
                if mode == .agent || mode == .claudeCode {
                    Section("First prompt (optional)") {
                        TextField("e.g. Fix the failing test in src/utils", text: $prompt, axis: .vertical).lineLimit(3...8)
                    }
                }
                if let confirmReason {
                    Section {
                        Label("This command looks risky: \(confirmReason). Run it anyway?", systemImage: "exclamationmark.triangle").foregroundStyle(Palette.warning)
                        Button("Run anyway", role: .destructive) { start(confirmed: true) }.disabled(runner.busy)
                    }
                }
                Section {
                    InlineError(message: runner.error)
                    Button { start(confirmed: false) } label: {
                        Text(runner.busy ? "Starting…" : "Start session").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.glassProminent)
                    .controlSize(.large)
                    .disabled(!d.online || runner.busy || (mode == .command && presetId == nil && splitArgs(custom).isEmpty))
                }
            }
        }
        .navigationTitle("New local session")
        .navigationDestination(item: $created) { SessionView(sessionId: $0) }
    }

    private func modeRow(_ m: SessionMode, _ title: String, _ body: String, _ icon: String, _ disabledReason: String?) -> some View {
        Button { mode = m } label: {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: icon).frame(width: 24).foregroundStyle(disabledReason == nil ? Color.accentColor : .secondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).foregroundStyle(disabledReason == nil ? .primary : .secondary)
                    Text(disabledReason ?? body).font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                if mode == m { Image(systemName: "checkmark.circle.fill").foregroundStyle(.tint) }
            }
        }
        .disabled(disabledReason != nil)
        .accessibilityAddTraits(mode == m ? .isSelected : [])
    }

    private func start(confirmed: Bool) {
        confirmReason = nil
        runner.run {
            do {
                let s = try await app.api.createLocalSession(deviceId: deviceId, CreateLocalSession(
                    workspaceId: workspaceId,
                    mode: mode,
                    presetId: mode == .command ? presetId : nil,
                    argv: mode == .command && presetId == nil ? splitArgs(custom) : nil,
                    confirmedRisk: confirmed ? true : nil,
                    prompt: (mode == .agent || mode == .claudeCode) && !prompt.isEmpty ? prompt : nil
                ))
                created = s.id
            } catch let e as APIError where e.code == "requires_confirmation" {
                confirmReason = e.message
            }
        }
    }
}

/// Holds one session's live state and keeps it in sync with the relay.
@MainActor
@Observable
final class SessionStream {
    private(set) var state = SessionState()
    @ObservationIgnored private var listener: Task<Void, Never>?
    @ObservationIgnored private var resyncTask: Task<Void, Never>?

    func start(_ realtime: RealtimeClient, sessionId: String) {
        guard listener == nil else { return }
        realtime.subscribe(sessionId) { [weak self] in self?.state.lastSeq ?? 0 }
        listener = Task { [weak self] in
            for await message in realtime.messages() {
                guard let self else { return }
                switch message {
                case let .event(ev) where ev.sessionId == sessionId:
                    if self.state.apply(ev) == .gap, self.resyncTask == nil {
                        self.resyncTask = Task {
                            try? await Task.sleep(for: .milliseconds(300))
                            realtime.resync(sessionId, afterSeq: self.state.lastSeq)
                            self.resyncTask = nil
                        }
                    }
                case let .replayGap(sid, resume) where sid == sessionId:
                    self.state.resume(from: resume)
                default: break
                }
            }
        }
    }

    func stop(_ realtime: RealtimeClient, sessionId: String) {
        listener?.cancel()
        listener = nil
        realtime.unsubscribe(sessionId)
    }
}

struct SessionView: View {
    let sessionId: String
    @Environment(AppModel.self) private var app
    @State private var stream = SessionStream()
    @State private var runner = ActionRunner()
    @State private var inputError: String?
    @State private var lastPrompt: String?
    @State private var confirmStop = false
    @State private var trigger = 0
    @State private var showChanges: Route?

    var body: some View {
        AsyncContent(load: { try await app.api.session(sessionId) }, reloadTrigger: trigger) { s in
            content(s)
        }
        .navigationDestination(item: $showChanges) { route in
            if case let .changes(d, w) = route { ChangesView(deviceId: d, workspaceId: w) }
        }
        .onAppear { stream.start(app.realtime, sessionId: sessionId) }
        .onDisappear { stream.stop(app.realtime, sessionId: sessionId) }
    }

    @ViewBuilder
    private func content(_ s: Session) -> some View {
        let st = stream.state
        let status = st.status ?? s.status
        let ended = status.isTerminal
        let offline = app.realtime.status != .connected
        let disabledReason: String? = ended ? "Session has ended" : offline ? "Reconnecting…" : nil
        VStack(spacing: 10) {
            header(s, status: status)
            ForEach(st.approvals) { a in
                ApprovalCard(approval: a, busy: runner.busy) { approve in
                    runner.run { try await app.api.decideApproval(sessionId, approvalId: a.approvalId, approve: approve) }
                }
                .padding(.horizontal)
            }
            InlineError(message: runner.error ?? inputError).padding(.horizontal)
            if s.mode.isChat {
                ChatTranscriptView(items: st.chat, revision: st.revision, working: status == .running, onRetry: retryAction)
                    .environment(\.imageSource, imageSource(for: s))
            } else {
                TerminalOutputView(lines: st.terminal.allLines(), revision: st.revision, dropped: st.terminal.dropped)
                    .padding(.horizontal)
            }
        }
        .safeAreaInset(edge: .bottom) {
            Group {
                if s.mode.isChat {
                    ComposerBar(disabledReason: disabledReason ?? (status == .running && s.mode == .claudeCode ? "Claude Code is working…" : nil), busy: runner.busy) { text in
                        lastPrompt = text
                        runner.run { try await app.api.prompt(sessionId, text: text) }
                    }
                } else if s.kind == .local {
                    TerminalInputBar(disabledReason: disabledReason) { data in
                        inputError = nil
                        Task {
                            let r = await app.realtime.command(.input(sessionId: sessionId, data: data))
                            if !r.ok { inputError = r.error?.message ?? "Input was not delivered" }
                        }
                    }
                }
            }
            .padding(.horizontal)
            .padding(.bottom, 6)
        }
        .navigationTitle(s.mode.label)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if !ended {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        if s.mode.isChat || s.kind == .cloud {
                            runner.run { try await app.api.signal(sessionId, terminate: false) }
                        } else {
                            Task { _ = await app.realtime.command(.input(sessionId: sessionId, data: "\u{03}")) }
                        }
                    } label: { Image(systemName: "stop.circle") }
                        .disabled(offline)
                        .accessibilityLabel(s.mode.isChat ? "Cancel turn" : "Interrupt")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button(role: .destructive) { confirmStop = true } label: { Image(systemName: "xmark.octagon") }
                        .accessibilityLabel(s.kind == .cloud ? "End session" : "Stop session")
                }
            }
            ToolbarSpacer(.fixed, placement: .topBarTrailing)
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    if !s.mode.isChat {
                        Button("Copy output", systemImage: "doc.on.doc") { UIPasteboard.general.string = st.terminal.plainText() }
                    }
                    if s.kind == .local, let d = s.deviceId, let w = s.workspaceId {
                        Button("Changes", systemImage: "arrow.triangle.branch") { showChanges = .changes(deviceId: d, workspaceId: w) }
                    }
                } label: { Image(systemName: "ellipsis") }
            }
        }
        .confirmationDialog(s.kind == .cloud ? "End cloud session?" : "Stop session?", isPresented: $confirmStop, titleVisibility: .visible) {
            Button(s.kind == .cloud ? "End session" : "Stop", role: .destructive) {
                runner.run {
                    if s.kind == .cloud { try await app.api.endCloudSession(sessionId) } else { try await app.api.signal(sessionId, terminate: true) }
                    trigger += 1
                }
            }
        } message: {
            Text(s.kind == .cloud ? "The managed session is interrupted and archived at Anthropic. Its history stays readable." : "Sends SIGTERM to the process on your Mac (SIGKILL after 5 seconds).")
        }
        .sensoryFeedback(.warning, trigger: st.approvals.count) { old, new in new > old }
        .sensoryFeedback(.success, trigger: status) { _, new in new == .completed }
    }

    /// Local sessions can show images from their project; cloud sessions have no files on the phone's computer.
    private func imageSource(for s: Session) -> ImageSource? {
        guard s.kind == .local, let device = s.deviceId, let workspace = s.workspaceId else { return nil }
        let api = app.api
        return ImageSource(scope: "\(device)/\(workspace)") { path in
            try await api.fileData(deviceId: device, workspaceId: workspace, path: path)
        }
    }

    private var retryAction: (() -> Void)? {
        guard let p = lastPrompt else { return nil }
        return { runner.run { try await app.api.prompt(sessionId, text: p) } }
    }

    private func header(_ s: Session, status: SessionStatus) -> some View {
        let st = stream.state
        return VStack(alignment: .leading, spacing: 4) {
            HStack {
                KindBadge(kind: s.kind)
                Spacer()
                StatusBadge(status: status)
            }
            Text((s.kind == .local ? "\(s.deviceName ?? "Mac") · \(s.workspaceName ?? "")" : "Anthropic Managed Agents sandbox (no access to your Mac)") + (st.exitCode.map { " · exit \($0)" } ?? ""))
                .font(.footnote).foregroundStyle(.secondary)
            if let m = st.statusMessage { Text(m).font(.caption).foregroundStyle(.tertiary) }
            if let u = st.usage ?? s.usage {
                Text("\(formatTokens(u.inputTokens)) in · \(formatTokens(u.outputTokens)) out · \(formatUSD(u.estimatedCostUsd)) \(u.source == "claude_code_result" ? "(reported by Claude Code)" : "(estimate at list price)")")
                    .font(.caption).foregroundStyle(.tertiary)
            }
            if status == .lost {
                Label("The CodeBridge agent restarted or the Mac rebooted, so this process is gone. Start a new session.", systemImage: "exclamationmark.triangle")
                    .font(.footnote).foregroundStyle(Palette.warning)
            }
        }
        .padding(.horizontal)
    }
}

struct ChangesView: View {
    let deviceId: String
    let workspaceId: String
    @Environment(AppModel.self) private var app
    private static let codes = ["M": "modified", "A": "added", "D": "deleted", "R": "renamed", "C": "copied", "U": "conflict", "?": "untracked"]

    var body: some View {
        List {
            AsyncContent(load: { try await app.api.gitStatus(deviceId: deviceId, workspaceId: workspaceId) }) { s in
                Section {
                    Label("\(s.branch ?? "(detached)")" + ((s.ahead ?? 0) > 0 ? " · \(s.ahead!) ahead" : "") + ((s.behind ?? 0) > 0 ? " · \(s.behind!) behind" : ""), systemImage: "arrow.triangle.branch")
                }
                Section("\(s.files.count) changed file\(s.files.count == 1 ? "" : "s")\(s.truncated ? " (truncated)" : "")") {
                    if s.files.isEmpty { ContentUnavailableView("Working tree clean", systemImage: "checkmark.circle") }
                    ForEach(s.files) { f in
                        let code = f.index != " " && f.index != "?" ? f.index : f.worktree
                        NavigationLink {
                            DiffView(deviceId: deviceId, workspaceId: workspaceId, path: f.path)
                        } label: {
                            VStack(alignment: .leading) {
                                Text(f.path).font(.code)
                                Text((Self.codes[code] ?? code) + (f.index != " " && f.index != "?" ? " · staged" : "")).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
        }
        .navigationTitle("Changes")
    }
}

struct DiffView: View {
    let deviceId: String
    let workspaceId: String
    let path: String
    @Environment(AppModel.self) private var app

    var body: some View {
        ScrollView([.vertical, .horizontal]) {
            AsyncContent(load: { try await app.api.gitDiff(deviceId: deviceId, workspaceId: workspaceId, path: path) }) { d in
                let lines = (d.diff.isEmpty ? "(no textual diff — new or binary file)" : d.diff).split(separator: "\n", omittingEmptySubsequences: false).prefix(3000)
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                        Text(line.isEmpty ? " " : String(line))
                            .font(.caption.monospaced())
                            .foregroundStyle(line.hasPrefix("+") && !line.hasPrefix("+++") ? Palette.success : line.hasPrefix("-") && !line.hasPrefix("---") ? Palette.danger : line.hasPrefix("@@") ? Color.accentColor : Color.secondary)
                    }
                }
                .textSelection(.enabled)
                .padding()
            }
        }
        .background(Palette.terminalBackground)
        .navigationTitle(path)
        .navigationBarTitleDisplayMode(.inline)
    }
}
