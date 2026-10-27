import CodeBridgeKit
import SwiftUI

struct CredentialsView: View {
    @Environment(AppModel.self) private var app
    @State private var key = ""
    @State private var trigger = 0
    @State private var runner = ActionRunner()

    var body: some View {
        Form {
            Section {
                Text("The coding agent on your Mac uses an API key stored in that Mac’s Keychain. It is never sent to the CodeBridge server or through the relay.")
                Text("codebridge-agent credentials set").font(.code)
                AsyncContent(load: { try await app.api.devices() }) { devices in
                    ForEach(devices) { d in
                        LabeledContent(d.name, value: d.capabilities?.anthropicKeyConfigured == true ? "Key configured" : "No key")
                    }
                }
                Text("Claude Code sessions use the `claude` CLI’s own login on the Mac; an API key here does not sign in Claude Code.").font(.footnote).foregroundStyle(.secondary)
            } header: { Text("Local Mac sessions") }

            AsyncContent(load: { try await app.api.cloudCredential() }, reloadTrigger: trigger) { c in
                Section {
                    Text("Cloud sessions run on Anthropic’s Managed Agents platform and need a key stored on the CodeBridge server, encrypted at rest (AES-256-GCM). Anthropic bills that key.")
                        .font(.footnote)
                    if !c.storageAvailable {
                        Label("This server has no credential encryption key configured, so cloud keys can’t be stored.", systemImage: "exclamationmark.triangle").foregroundStyle(Palette.warning)
                    }
                    LabeledContent("Key on file", value: c.configured ? (c.hint ?? "yes") : "None")
                    SecureField(c.configured ? "Replace key (sk-ant-…)" : "Anthropic API key (sk-ant-…)", text: $key)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    InlineError(message: runner.error)
                    Button("Save key") {
                        runner.run {
                            try await app.api.saveCloudKey(key.trimmingCharacters(in: .whitespaces))
                            key = "" // never keep the key in app state after upload
                            trigger += 1
                        }
                    }
                    .disabled(!key.hasPrefix("sk-ant-") || !c.storageAvailable || runner.busy)
                    if c.configured {
                        Button("Remove key", role: .destructive) { runner.run { try await app.api.deleteCloudKey(); trigger += 1 } }
                    }
                } header: { Text("Managed cloud sessions") }
            }
        }
        .navigationTitle("API credentials")
    }
}

struct CloudView: View {
    @Environment(AppModel.self) private var app
    @State private var trigger = 0
    @State private var model = ""
    @State private var unrestricted = false
    @State private var hosts = ""
    @State private var budget = ""
    @State private var runner = ActionRunner()

    var body: some View {
        List {
            AsyncContent(load: { try await app.api.cloudConfig() }, reloadTrigger: trigger) { c in
                if !c.enabled {
                    ContentUnavailableView("Cloud sessions are disabled", systemImage: "cloud.slash", description: Text("This CodeBridge server has cloud sessions turned off."))
                } else {
                    Section {
                        Label {
                            Text("CodeBridge-managed cloud sessions run in a fresh, isolated container on Anthropic Managed Agents. They can’t access your Mac, and they are not your Claude.ai or Claude Code sessions.")
                                .font(.footnote)
                        } icon: { Image(systemName: "cloud").foregroundStyle(Palette.cloud) }
                        if !c.keyConfigured {
                            NavigationLink(value: Route.credentials) { Label("Add an Anthropic API key first", systemImage: "key").foregroundStyle(Palette.warning) }
                        } else {
                            NavigationLink(value: Route.newCloudSession) { Label("New cloud session", systemImage: "plus.circle.fill") }
                        }
                    }
                    Section {
                        Picker("Model", selection: $model) {
                            ForEach(c.availableModels, id: \.self) { Text($0).tag($0) }
                        }
                        Toggle("Unrestricted network", isOn: $unrestricted)
                        if !unrestricted {
                            TextField("Allowed hosts (api.github.com, pypi.org)", text: $hosts)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                        }
                        LabeledContent("Budget per session (USD)") {
                            TextField("5.00", text: $budget).keyboardType(.decimalPad).multilineTextAlignment(.trailing)
                        }
                        InlineError(message: runner.error)
                        Button("Save environment") {
                            runner.run {
                                let cents = Int(((Double(budget) ?? 0) * 100).rounded())
                                let list = hosts.split(whereSeparator: { $0 == "," || $0 == " " || $0 == "\n" }).map(String.init)
                                try await app.api.updateCloudConfig(model: model, unrestricted: unrestricted, allowedHosts: list, budgetCents: cents)
                                trigger += 1
                            }
                        }
                        .disabled(runner.busy)
                    } header: {
                        Text("Environment")
                    } footer: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(unrestricted ? "The sandbox can reach any host. Keep secrets out of prompts and files." : "Limited: package registries plus the hosts you list.")
                            Text("At most \(c.maxConcurrent) cloud session(s) at once; sessions end automatically after the server’s maximum duration. The budget is a hard cap enforced by Anthropic.")
                            Text(c.resources.map { "Agent \($0.agentId) · Environment \($0.environmentId)" } ?? "Resources are created at Anthropic on first use.")
                            Text(c.billing)
                        }
                    }
                    .onAppear {
                        model = c.model
                        unrestricted = c.networking == "unrestricted"
                        hosts = c.allowedHosts.joined(separator: ", ")
                        budget = String(format: "%.2f", Double(c.budgetCents) / 100)
                    }
                }
            }
            Section("Cloud sessions") {
                AsyncContent(load: { try await app.api.sessions(kind: .cloud) }, reloadTrigger: trigger) { sessions in
                    if sessions.isEmpty { Text("None yet.").font(.footnote).foregroundStyle(.secondary) }
                    ForEach(sessions) { s in NavigationLink(value: Route.session(s.id)) { SessionRow(session: s) } }
                }
            }
        }
        .navigationTitle("Cloud")
        .refreshable { trigger += 1 }
        .refreshOnRealtime($trigger)
        .codeBridgeDestinations()
    }
}

struct NewCloudSessionView: View {
    @Environment(AppModel.self) private var app
    @State private var prompt = ""
    @State private var runner = ActionRunner()
    @State private var created: String?

    var body: some View {
        Form {
            Section {
                Label("This starts a new session in an Anthropic-hosted sandbox. It has no access to your Mac’s files.", systemImage: "cloud").font(.footnote)
            }
            Section("What should the cloud agent do?") {
                TextField("e.g. Write a CLI in Go that converts CSV to JSON, with tests", text: $prompt, axis: .vertical).lineLimit(4...10)
            }
            Section {
                InlineError(message: runner.error)
                Button { runner.run { created = try await app.api.createCloudSession(prompt: prompt.trimmingCharacters(in: .whitespacesAndNewlines)).id } } label: {
                    Text(runner.busy ? "Starting…" : "Start cloud session").frame(maxWidth: .infinity)
                }
                .buttonStyle(.glassProminent)
                .controlSize(.large)
                .disabled(prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || runner.busy)
            }
        }
        .navigationTitle("New cloud session")
        .navigationDestination(item: $created) { SessionView(sessionId: $0) }
    }
}

struct UsageView: View {
    private struct Bucket: Identifiable {
        let id: String
        let title: String
        let subtitle: String
        let color: Color
    }

    private let buckets = [
        Bucket(id: "local", title: "Local Mac", subtitle: "Your API key on the Mac", color: Palette.local),
        Bucket(id: "cloud", title: "Managed cloud", subtitle: "Your server-stored key", color: Palette.cloud),
    ]

    @Environment(AppModel.self) private var app

    var body: some View {
        List {
            Section {
                Text("Estimates at Anthropic list prices from the usage each session reported (Claude Code sessions show the CLI’s own figure). Your Anthropic invoice is authoritative.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            AsyncContent(load: { try await app.api.usage() }) { u in
                ForEach(buckets) { b in
                    let t = u.totals[b.id]
                    Section {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(formatUSD(t?.estimatedCostUsd ?? 0)).font(.largeTitle.bold()).foregroundStyle(b.color).contentTransition(.numericText())
                            Text("\(t?.sessions ?? 0) session(s) · \(formatTokens(t?.inputTokens ?? 0)) input · \(formatTokens(t?.outputTokens ?? 0)) output tokens · last \(u.periodDays) days")
                                .font(.footnote).foregroundStyle(.secondary)
                        }
                    } header: { Text(b.title) } footer: { Text(b.subtitle) }
                }
                if u.sessionsWithUnknownCost > 0 {
                    Text("\(u.sessionsWithUnknownCost) session(s) used a model without a known price and are excluded from cost totals.").font(.footnote)
                }
            }
        }
        .navigationTitle("Usage & cost")
    }
}

struct SettingsView: View {
    @Environment(AppModel.self) private var app
    @State private var password = ""
    @State private var confirmDelete = false
    @State private var runner = ActionRunner()

    var body: some View {
        Form {
            Section("Account") {
                LabeledContent("Signed in as", value: app.user?.email ?? "")
                LabeledContent("Server", value: app.apiURL.host() ?? app.apiURL.absoluteString)
                if app.isInsecure { Label("Not using HTTPS (development).", systemImage: "exclamationmark.shield").foregroundStyle(Palette.warning) }
            }
            Section {
                NavigationLink(value: Route.devices) { Label("Devices", systemImage: "laptopcomputer") }
                NavigationLink(value: Route.credentials) { Label("API credentials", systemImage: "key") }
                NavigationLink(value: Route.usage) { Label("Usage & cost", systemImage: "chart.bar") }
            }
            Section("Security") {
                Label("Sign-in tokens live in the iOS Keychain (this device only) and rotate on every refresh.", systemImage: "lock")
                Label("Your Macs connect outbound to the relay; no ports are opened on your Mac.", systemImage: "arrow.up.right.circle")
                Label("Traffic is encrypted in transit (TLS) to the CodeBridge server, which relays it to your Mac. It is not end-to-end encrypted: the server can see terminal traffic while relaying it, but does not store terminal output.", systemImage: "network")
                Label("Which folders and commands are allowed is decided on each Mac and can’t be changed from this phone.", systemImage: "hand.raised")
            }
            .font(.footnote)
            Section {
                Button("Sign out") { Task { await app.signOut() } }
            }
            Section {
                SecureField("Confirm with your password", text: $password)
                InlineError(message: runner.error)
                Button("Delete my account", role: .destructive) { confirmDelete = true }.disabled(password.isEmpty || runner.busy)
            } header: { Text("Delete account") } footer: {
                Text("Permanently deletes your account, revokes all Macs, ends cloud sessions and erases stored credentials. This cannot be undone.")
            }
        }
        .navigationTitle("Settings")
        .confirmationDialog("Delete account?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete", role: .destructive) { runner.run { try await app.deleteAccount(password: password) } }
        } message: { Text("This permanently deletes everything.") }
        .codeBridgeDestinations()
    }
}
