import CodeBridgeKit
import SwiftUI

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
                            Label("No Mac paired yet", systemImage: "laptopcomputer.slash")
                        } description: {
                            Text("Install the CodeBridge agent on your Mac, run `codebridge-agent pair`, then scan the code.")
                        } actions: {
                            NavigationLink(value: Route.pair) { Text("Pair a Mac") }.buttonStyle(.glassProminent)
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
                NavigationLink(value: Route.pair) { Image(systemName: "qrcode.viewfinder") }.accessibilityLabel("Pair a Mac")
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
                Section("Approved workspaces") {
                    if d.workspaces.isEmpty {
                        Text("No workspaces yet. On the Mac run: codebridge-agent workspace add ~/path/to/project").font(.footnote)
                    }
                    ForEach(d.workspaces) { w in
                        VStack(alignment: .leading, spacing: 8) {
                            Label(w.name, systemImage: w.isGitRepo ? "arrow.triangle.branch" : "folder").font(.headline)
                            Text(w.displayPath).font(.code).foregroundStyle(.secondary)
                            HStack {
                                NavigationLink(value: Route.newSession(deviceId: d.id, workspaceId: w.id)) { Text("New session") }
                                    .buttonStyle(.glassProminent)
                                    .disabled(!d.online)
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
                Section("Capabilities (set on the Mac)") {
                    if let c = d.capabilities {
                        LabeledContent("Terminal", value: c.pty ? "PTY" : "pipes only")
                        LabeledContent("Coding agent API key", value: c.anthropicKeyConfigured ? "In the Mac’s Keychain" : "Not set")
                        LabeledContent("Claude Code CLI", value: c.claudeCodeAvailable ? "Available" : "Not available")
                        LabeledContent("Custom commands", value: c.allowCustomCommands ? "Allowed" : "Disabled")
                        LabeledContent("Interactive shell", value: c.allowInteractiveShell ? "Allowed" : "Disabled")
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
            if done {
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
        .navigationTitle("Pair a Mac")
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
