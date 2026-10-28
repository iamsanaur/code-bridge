import CodeBridgeKit
import SwiftUI
import UIKit

struct DeviceRow: View {
    let device: Device
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Label(device.name, systemImage: "laptopcomputer").font(.headline)
                Spacer()
                OnlineBadge(online: device.online)
            }
            Text("\(device.hostname ?? "unknown host") · \(device.workspaces.count) workspace\(device.workspaces.count == 1 ? "" : "s")" + (device.online ? "" : " · last seen \(timeAgo(device.lastSeenAt))"))
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}

struct SessionRow: View {
    let session: Session
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                KindBadge(kind: session.kind)
                Spacer()
                StatusBadge(status: session.status)
            }
            Text(session.title).font(.body.weight(.semibold)).lineLimit(2)
            Text("\(session.mode.label) · \(session.kind == .local ? "\(session.deviceName ?? "Mac") / \(session.workspaceName ?? "")" : "Anthropic sandbox") · \(timeAgo(session.createdAt))")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}

/// Bumps a counter whenever the relay reports device presence or session status changes.
struct RealtimeRefresh: ViewModifier {
    @Environment(AppModel.self) private var app
    @Binding var trigger: Int

    func body(content: Content) -> some View {
        content.task {
            for await message in app.realtime.messages() {
                switch message {
                case .deviceStatus, .sessionStatus: trigger += 1
                default: break
                }
            }
        }
    }
}

extension View {
    func refreshOnRealtime(_ trigger: Binding<Int>) -> some View { modifier(RealtimeRefresh(trigger: trigger)) }
}

struct HomeView: View {
    @Environment(AppModel.self) private var app
    @State private var trigger = 0

    var body: some View {
        List {
            Section("Your Macs") {
                AsyncContent(load: { try await app.api.devices() }, reloadTrigger: trigger) { devices in
                    if devices.isEmpty {
                        ContentUnavailableView {
                            Label("No computer yet", systemImage: "laptopcomputer.slash")
                        } description: {
                            Text("Install the CodeBridge agent on your Mac or PC and connect it to your relay.")
                        } actions: {
                            NavigationLink(value: Route.pair) { Text("Add a computer") }.buttonStyle(.glassProminent)
                        }
                    }
                    ForEach(devices) { d in NavigationLink(value: Route.device(d.id)) { DeviceRow(device: d) } }
                }
            }
            AsyncContent(load: { try await app.api.sessions(active: true) }, reloadTrigger: trigger) { sessions in
                let running = sessions.filter { $0.status.group == .running }.count
                let waiting = sessions.filter { $0.status.group == .waiting }.count
                Section {
                    if sessions.isEmpty {
                        Text("No active sessions. Open a Mac to start one, or start a cloud session.").font(.footnote).foregroundStyle(.secondary)
                    }
                    ForEach([SessionKind.local, .cloud], id: \.self) { kind in
                        let group = sessions.filter { $0.kind == kind }
                        if !group.isEmpty {
                            Text(kind == .local ? "On your Macs" : "Managed cloud")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(kind == .local ? Palette.local : Palette.cloud)
                            ForEach(group) { s in NavigationLink(value: Route.session(s.id)) { SessionRow(session: s) } }
                        }
                    }
                } header: {
                    HStack {
                        Text("Active sessions")
                        Spacer()
                        Text("\(running) running · \(waiting) waiting").textCase(nil)
                    }
                }
            }
        }
        .navigationTitle("CodeBridge")
        .refreshable { trigger += 1 }
        .refreshOnRealtime($trigger)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                NavigationLink(value: Route.devices) { Image(systemName: "rectangle.stack") }.accessibilityLabel("Manage devices")
            }
            ToolbarSpacer(.fixed, placement: .topBarTrailing)
            ToolbarItem(placement: .topBarTrailing) {
                NavigationLink(value: Route.pair) { Image(systemName: "qrcode.viewfinder") }.accessibilityLabel("Add a computer")
            }
        }
        .codeBridgeDestinations()
    }
}

struct DevicesView: View {
    @Environment(AppModel.self) private var app
    @State private var trigger = 0
    @State private var renaming: Device?
    @State private var newName = ""
    @State private var revoking: Device?
    @State private var runner = ActionRunner()

    var body: some View {
        List {
            AsyncContent(load: { try await app.api.devices() }, reloadTrigger: trigger) { devices in
                if devices.isEmpty { ContentUnavailableView("No devices", systemImage: "laptopcomputer.slash") }
                ForEach(devices) { d in
                    NavigationLink(value: Route.device(d.id)) {
                        VStack(alignment: .leading) {
                            DeviceRow(device: d)
                            Text("agent \(d.agentVersion ?? "?") · paired \(timeAgo(d.createdAt))").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    .swipeActions {
                        Button("Revoke", role: .destructive) { revoking = d }
                        Button("Rename") { newName = d.name; renaming = d }.tint(.blue)
                    }
                }
            }
            InlineError(message: runner.error)
        }
        .navigationTitle("Devices")
        .refreshable { trigger += 1 }
        .refreshOnRealtime($trigger)
        .alert("Rename Mac", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            TextField("Name", text: $newName)
            Button("Save") {
                guard let d = renaming else { return }
                runner.run { try await app.api.renameDevice(d.id, name: newName.trimmingCharacters(in: .whitespaces)); trigger += 1 }
            }
            Button("Cancel", role: .cancel) {}
        }
        .confirmationDialog("Revoke \(revoking?.name ?? "this Mac")?", isPresented: Binding(get: { revoking != nil }, set: { if !$0 { revoking = nil } }), titleVisibility: .visible) {
            Button("Revoke", role: .destructive) {
                guard let d = revoking else { return }
                runner.run { try await app.api.revokeDevice(d.id); trigger += 1 }
            }
        } message: {
            Text("Its credential stops working immediately, running sessions are stopped, and it must be paired again.")
        }
    }
}

struct DeviceView: View {
    let deviceId: String
    @Environment(AppModel.self) private var app
    @State private var trigger = 0
    @State private var creating = false
    @State private var picking = false
    /// Set right after a project is created, so the next screen is "start a session in it".
    @State private var createdWorkspaceId: String?

    var body: some View {
        List {
            AsyncContent(load: { try await app.api.device(deviceId) }, reloadTrigger: trigger) { d in
                Section {
                    HStack {
                        Text("\(d.hostname ?? "") · \(d.platform ?? "") · agent \(d.agentVersion ?? "?")").font(.footnote).foregroundStyle(.secondary)
                        Spacer()
                        OnlineBadge(online: d.online)
                    }
                    if !d.online {
                        Label("This Mac is offline (last seen \(timeAgo(d.lastSeenAt))). Make sure the CodeBridge agent is running and the Mac is awake.", systemImage: "moon.zzz")
                            .font(.footnote).foregroundStyle(Palette.warning)
                    }
                }
                Section("Projects") {
                    if d.capabilities?.canCreateWorkspaces == true {
                        Button { creating = true } label: {
                            Label("New project", systemImage: "folder.badge.plus").frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.glassProminent)
                        .disabled(!d.online)
                        .accessibilityHint("Creates a new folder on \(d.name) and starts a project in it")
                    }
                    if d.capabilities?.canBrowseFolders == true {
                        Button { picking = true } label: {
                            Label("Add existing folder", systemImage: "folder").frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.glass)
                        .disabled(!d.online)
                        .accessibilityHint("Choose a project folder that is already on \(d.name)")
                    }
                    if d.workspaces.isEmpty {
                        Text(d.capabilities?.canCreateWorkspaces == true
                             ? "No projects yet. Create one above, or on the computer run: codebridge-agent workspace add ~/path/to/project"
                             : "No workspaces yet. On the computer run: codebridge-agent workspace add ~/path/to/project")
                            .font(.footnote)
                    }
                    ForEach(d.workspaces) { w in
                        VStack(alignment: .leading, spacing: 8) {
                            Label(w.name, systemImage: w.isGitRepo ? "arrow.triangle.branch" : "folder").font(.headline)
                            Text(w.displayPath).font(.code).foregroundStyle(.secondary)
                            HStack {
                                NavigationLink(value: Route.newSession(deviceId: d.id, workspaceId: w.id)) { Text("New session") }
                                    .buttonStyle(.glassProminent)
                                    .disabled(!d.online)
                                if d.capabilities?.claudeCodeAvailable == true {
                                    NavigationLink(value: Route.conversations(deviceId: d.id, workspaceId: w.id)) { Text("Continue") }
                                        .buttonStyle(.glass)
                                        .disabled(!d.online)
                                        .accessibilityHint("Pick up an earlier Claude Code conversation in this project")
                                }
                                if w.isGitRepo {
                                    NavigationLink(value: Route.changes(deviceId: d.id, workspaceId: w.id)) { Text("Changes") }
                                        .buttonStyle(.glass)
                                        .disabled(!d.online)
                                }
                            }
                        }
                        .padding(.vertical, 4)
                    }
                }
                .sheet(isPresented: $creating) {
                    NavigationStack {
                        NewProjectView(device: d) { workspace in
                            creating = false
                            trigger += 1
                            createdWorkspaceId = workspace.id
                        }
                    }
                    .presentationDetents([.medium, .large])
                }
                .sheet(isPresented: $picking) {
                    NavigationStack {
                        FolderPickerView(device: d) { workspace in
                            picking = false
                            trigger += 1
                            createdWorkspaceId = workspace.id
                        }
                    }
                    .presentationDetents([.large])
                }
                .navigationDestination(isPresented: Binding(get: { createdWorkspaceId != nil }, set: { if !$0 { createdWorkspaceId = nil } })) {
                    if let id = createdWorkspaceId { NewSessionView(deviceId: d.id, workspaceId: id) }
                }
                Section("Capabilities (set on the Mac)") {
                    if let c = d.capabilities {
                        LabeledContent("Terminal", value: c.pty ? "PTY" : "pipes only")
                        LabeledContent("Coding agent API key", value: c.anthropicKeyConfigured ? "In the Mac’s Keychain" : "Not set")
                        LabeledContent("Claude Code CLI", value: c.claudeCodeAvailable ? "Available" : "Not available")
                        LabeledContent("Custom commands", value: c.allowCustomCommands ? "Allowed" : "Disabled")
                        LabeledContent("Interactive shell", value: c.allowInteractiveShell ? "Allowed" : "Disabled")
                        LabeledContent("New projects from this phone", value: c.canCreateWorkspaces == true ? "Allowed" : "Disabled")
                        LabeledContent("Pick existing folders", value: c.canBrowseFolders == true ? "Allowed" : "Disabled")
                        if let root = c.projectsRoot { LabeledContent("Default project folder", value: root) }
                    } else {
                        Text("The Mac hasn’t connected yet.").font(.footnote)
                    }
                }
                .navigationTitle(d.name)
            }
        }
        .refreshable { trigger += 1 }
        .refreshOnRealtime($trigger)
    }
}

struct PairView: View {
    let initialCode: String?
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var code = ""
    @State private var claimed: PairingClaim?
    @State private var done = false
    @State private var scanning = false
    @State private var runner = ActionRunner()

    var body: some View {
        Form {
            if let command = app.agentConnectCommand {
                // Personal relay: the computer joins with the same secret as this phone. No code to approve.
                Section {
                    Text("Add a computer to your relay. Install the agent there, then run the command below on it. It connects straight away, with nothing to approve.")
                        .font(.footnote)
                    InstallTip()
                }
                Section("Run this on the computer") {
                    CommandBlock(title: "Contains your relay password. Don’t share it.", command: command)
                    Button { UIPasteboard.general.string = command } label: { Label("Copy command", systemImage: "doc.on.doc") }
                        .buttonStyle(.glass)
                }
            } else if done {
                Section {
                    Label("Almost there", systemImage: "checkmark.seal.fill").font(.title3.bold()).foregroundStyle(Palette.success)
                    Text("Confirm on your Mac that it should join your account (the agent asks “Is that your account?”). It will then appear on your dashboard.")
                    Button("Done") { dismiss() }.buttonStyle(.glassProminent)
                }
            } else if let c = claimed {
                Section("Allow this Mac to connect?") {
                    Label(c.deviceName, systemImage: "laptopcomputer").font(.headline)
                    Text("\(c.hostname ?? "unknown host") · \(c.platform ?? "unknown platform")").font(.footnote).foregroundStyle(.secondary)
                }
                Section {
                    Label("Only approve if you just ran `codebridge-agent pair` on this Mac yourself. Once paired, you can run approved commands on it from this phone.", systemImage: "exclamationmark.shield")
                        .font(.footnote).foregroundStyle(Palette.warning)
                    InlineError(message: runner.error)
                    GlassEffectContainer(spacing: 10) {
                        HStack {
                            Button("Deny", role: .destructive) { runner.run { try await app.api.decidePairing(id: c.pairingId, approve: false); dismiss() } }
                                .buttonStyle(.glass)
                            Button("Approve") { runner.run { try await app.api.decidePairing(id: c.pairingId, approve: true); done = true } }
                                .buttonStyle(.glassProminent)
                        }
                        .controlSize(.large)
                        .disabled(runner.busy)
                    }
                }
                .sensoryFeedback(.success, trigger: done)
            } else {
                Section {
                    Text("On your Mac, run `codebridge-agent pair --server …`, then scan the QR code it shows or type its code.")
                        .font(.footnote)
                    InstallTip()
                    if QRScannerView.isAvailable {
                        Button { scanning = true } label: { Label("Scan QR code", systemImage: "qrcode.viewfinder") }
                            .buttonStyle(.glass)
                    }
                }
                Section("Pairing code") {
                    TextField("ABCD-EFGH", text: $code)
                        .font(.system(.title3, design: .monospaced))
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                        .onSubmit { claim(code) }
                    InlineError(message: runner.error)
                    Button("Continue") { claim(code) }
                        .buttonStyle(.glassProminent)
                        .disabled(runner.busy || code.filter { $0.isLetter || $0.isNumber }.count != 8)
                }
            }
        }
        .navigationTitle(app.isPersonal ? "Add a computer" : "Pair a Mac")
        .onAppear { if let initialCode, code.isEmpty { code = initialCode; claim(initialCode) } }
        .fullScreenCover(isPresented: $scanning) {
            ZStack(alignment: .top) {
                QRScannerView { payload in
                    scanning = false
                    if let c = codeFromQR(payload) { code = c; claim(c) } else { runner.error = "That QR code isn’t a CodeBridge pairing code." }
                }
                .ignoresSafeArea()
                HStack {
                    Text("Point at the code on your Mac").font(.subheadline.weight(.medium)).padding(.horizontal, 16).padding(.vertical, 10)
                        .glassEffect(.regular, in: .capsule)
                    Spacer()
                    Button { scanning = false } label: { Image(systemName: "xmark") }
                        .buttonStyle(.glass)
                        .buttonBorderShape(.circle)
                        .accessibilityLabel("Close scanner")
                }
                .padding()
            }
        }
    }

    private func claim(_ raw: String) {
        guard let normalized = normalizePairingCode(raw) else {
            runner.error = "Enter the 8-character code shown on your Mac (e.g. ABCD-EFGH)."
            return
        }
        runner.run { claimed = try await app.api.claimPairing(code: normalized) }
    }
}

/// How to get the agent running on a Mac. The agent drives the user's own `claude` CLI, so their Claude plan
/// login stays on the Mac and never passes through the relay or this phone.
struct InstallTip: View {
    var body: some View {
        DisclosureGroup {
            VStack(alignment: .leading, spacing: 10) {
                CommandBlock(title: "1. Install Node.js 22+ on your Mac or Windows PC (nodejs.org)", command: "node --version")
                CommandBlock(title: "2. Install the CodeBridge agent", command: RelayCommands.installAgent)
                CommandBlock(title: "3. Optional: install Claude Code and sign in with your Claude plan", command: "claude")
                CommandBlock(title: "4. Allow a project folder, then keep the agent running in the background", command: "codebridge-agent workspace add <project folder>\ncodebridge-agent service install")
                Text("Your Claude login stays on your computer. It is never sent to CodeBridge or this phone.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            .padding(.top, 6)
        } label: {
            Label("How to install the agent (Mac or Windows)", systemImage: "lightbulb")
                .font(.subheadline.weight(.semibold))
        }
    }
}


/// Start a new project on a computer by name. The phone sends only a name: the computer creates a brand-new
/// folder inside its own projects folder, never an existing one, and the owner can switch this off.
struct NewProjectView: View {
    let device: Device
    let onCreated: (WorkspaceInfo) -> Void
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var gitInit = true
    @State private var runner = ActionRunner()
    @State private var root: String?
    @State private var choosingRoot = false
    @FocusState private var focused: Bool

    private var problem: String? { projectNameError(name) }
    private var canCreate: Bool { isValidProjectName(name) && !runner.busy }

    var body: some View {
        Form {
            Section {
                TextField("Project name", text: $name)
                    .focused($focused)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.go)
                    .onSubmit { create() }
                if let problem { Label(problem, systemImage: "exclamationmark.circle").font(.footnote).foregroundStyle(Palette.danger) }
            } footer: {
                Text("A new folder is created on \(device.name), inside the default project folder below. Existing folders are never touched.")
            }
            Section {
                LabeledContent("Create in", value: root ?? device.capabilities?.projectsRoot ?? "~/CodeBridge")
                    .font(.code)
                if device.capabilities?.canBrowseFolders == true {
                    Button("Change default folder") { choosingRoot = true }
                }
            } header: { Text("Default project folder") }
            Section {
                Toggle("Start a git repository", isOn: $gitInit)
            }
            Section { InlineError(message: runner.error) }
        }
        .navigationTitle("New project")
        .navigationBarTitleDisplayMode(.inline)
        .explicitBackButton()
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Create") { create() }.disabled(!canCreate)
            }
        }
        .onAppear { focused = true }
        .sheet(isPresented: $choosingRoot) {
            NavigationStack {
                FolderPickerView(device: device, purpose: .defaultFolder, onAdded: { _ in }, onChosenDefault: { path in
                    root = path
                    choosingRoot = false
                })
            }
            .presentationDetents([.large])
        }
    }

    private func create() {
        guard canCreate else { return }
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        runner.run {
            let result = try await app.api.createWorkspace(deviceId: device.id, name: trimmed, gitInit: gitInit)
            onCreated(result.workspace)
        }
    }
}

/// Pick a folder that already exists on the computer. Only folders inside its home directory are shown (no hidden
/// or system folders), and the computer checks the choice again before adding it.
struct FolderPickerView: View {
    enum Purpose { case addProject, defaultFolder }

    let device: Device
    var purpose: Purpose = .addProject
    let onAdded: (WorkspaceInfo) -> Void
    /// Called instead of `onAdded` when choosing the default folder, with the new `~/…` path.
    var onChosenDefault: (String) -> Void = { _ in }
    /// Where to start; the home folder when nil.
    var startPath: String?
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var listing: BrowseFoldersResult?
    @State private var loadError: String?
    @State private var loading = false
    @State private var runner = ActionRunner()

    var body: some View {
        List {
            if let listing {
                Section {
                    Label(listing.displayPath, systemImage: listing.isGitRepo ? "arrow.triangle.branch" : "folder")
                        .font(.code)
                } footer: {
                    Text(purpose == .defaultFolder
                         ? (listing.canAdd ? "New projects will be created inside this folder." : "Open the folder where new projects should go, such as Projects.")
                         : (listing.canAdd ? "Tap “Use this folder” to work in it, or open a folder inside it." : "Open the folder that holds your project."))
                }
                if let parent = listing.parentPath {
                    Button { load(parent) } label: { Label("Up one folder", systemImage: "arrow.up.left") }
                }
                Section("Folders") {
                    if listing.folders.isEmpty { Text("No folders here").foregroundStyle(.secondary) }
                    ForEach(listing.folders) { f in
                        Button { load(f.path) } label: {
                            HStack {
                                Label(f.name, systemImage: f.isGitRepo ? "arrow.triangle.branch" : "folder")
                                Spacer()
                                Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
                            }
                        }
                        .foregroundStyle(.primary)
                    }
                    if listing.truncated { Text("Only the first folders are shown.").font(.footnote).foregroundStyle(.secondary) }
                }
            } else if let loadError {
                Section { InlineError(message: loadError); Button("Try again") { load(nil) } }
            } else {
                Section { ProgressView("Loading \(device.name)…") }
            }
            if listing != nil { Section { InlineError(message: runner.error) } }
        }
        .navigationTitle(purpose == .defaultFolder ? "Default folder" : "Add folder")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            ToolbarItem(placement: .confirmationAction) {
                Button(purpose == .defaultFolder ? "Set as default" : "Use this folder") { add() }
                    .disabled(listing?.canAdd != true || runner.busy)
            }
        }
        .overlay { if loading { ProgressView().controlSize(.large) } }
        .task { if listing == nil { load(startPath) } }
    }

    private func load(_ path: String?) {
        loading = true
        Task {
            defer { loading = false }
            do {
                listing = try await app.api.browseFolders(deviceId: device.id, path: path)
                loadError = nil
            } catch {
                if listing == nil { loadError = (error as? APIError)?.message ?? error.localizedDescription }
                else { runner.error = (error as? APIError)?.message ?? error.localizedDescription }
            }
        }
    }

    private func add() {
        guard let path = listing?.path else { return }
        let purpose = purpose
        runner.run {
            switch purpose {
            case .addProject:
                let result = try await app.api.addWorkspace(deviceId: device.id, path: path)
                onAdded(result.workspace)
            case .defaultFolder:
                let result = try await app.api.setProjectsRoot(deviceId: device.id, path: path)
                onChosenDefault(result.projectsRoot)
            }
        }
    }
}
