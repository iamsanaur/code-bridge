import CodeBridgeKit
import SwiftUI

struct WelcomeView: View {
    @Environment(AppModel.self) private var app
    @State private var scanning = false
    @State private var pasting = false
    @State private var pasted = ""
    @State private var error: String?

    var body: some View {
        ZStack {
            // Vivid background so the Liquid Glass controls have something to refract.
            MeshGradient(
                width: 3, height: 3,
                points: [[0, 0], [0.5, 0], [1, 0], [0, 0.5], [0.6, 0.45], [1, 0.5], [0, 1], [0.5, 1], [1, 1]],
                colors: [
                    .black, Color(hex: 0x10324A), .black,
                    Palette.local.opacity(0.55), Color(hex: 0x1B1F3B), Palette.cloud.opacity(0.55),
                    .black, Color(hex: 0x241A3D), .black,
                ]
            )
            .ignoresSafeArea()

            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    Image(systemName: "point.3.connected.trianglepath.dotted")
                        .font(.system(size: 44, weight: .semibold))
                        .foregroundStyle(.white)
                        .padding(18)
                        .glassEffect(.regular, in: .rect(cornerRadius: 24))
                        .accessibilityHidden(true)
                        .padding(.top, 40)
                    Text("CodeBridge")
                        .font(.largeTitle.bold())
                        .foregroundStyle(.white)
                        .accessibilityAddTraits(.isHeader)
                    Text("Run and supervise coding sessions on your own Mac or PC from anywhere. You run your own relay, so there is no account and nothing to sign up for. Scan the QR code your relay shows and you are connected.")
                        .font(.body)
                        .foregroundStyle(.white.opacity(0.85))
                    Spacer(minLength: 24)
                    GlassEffectContainer(spacing: 12) {
                        VStack(spacing: 12) {
                            if QRScannerView.isAvailable {
                                Button { scanning = true } label: {
                                    Label("Scan QR code", systemImage: "qrcode.viewfinder").frame(maxWidth: .infinity)
                                }
                                .buttonStyle(.glassProminent)
                                Button { pasting = true } label: {
                                    Label("Paste a link", systemImage: "doc.on.clipboard").frame(maxWidth: .infinity)
                                }
                                .buttonStyle(.glass)
                            } else {
                                Button { pasting = true } label: {
                                    Label("Paste a link", systemImage: "doc.on.clipboard").frame(maxWidth: .infinity)
                                }
                                .buttonStyle(.glassProminent)
                            }
                        }
                        .controlSize(.extraLarge)
                    }
                    InlineError(message: error)
                    NavigationLink { SetupRelayView() } label: {
                        Label("Set up a relay (one command)", systemImage: "terminal").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.glass)
                    .controlSize(.extraLarge)
                    NavigationLink { AuthFormView(mode: .signIn) } label: {
                        Text("Sign in to a shared relay").font(.footnote)
                    }
                    .foregroundStyle(.white.opacity(0.7))
                    if app.isInsecure {
                        Label("This build connects to \(app.apiURL.absoluteString) without HTTPS. Use this only for local development.", systemImage: "exclamationmark.shield")
                            .font(.footnote)
                            .foregroundStyle(Palette.warning)
                    }
                }
                .padding(24)
            }
        }
        .preferredColorScheme(.dark)
        .fullScreenCover(isPresented: $scanning) {
            ZStack(alignment: .top) {
                QRScannerView { payload in
                    scanning = false
                    accept(payload)
                }
                .ignoresSafeArea()
                HStack {
                    Text("Point at your relay’s QR code").font(.subheadline.weight(.medium)).padding(.horizontal, 16).padding(.vertical, 10)
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
        .alert("Paste your link", isPresented: $pasting) {
            TextField("codebridge://connect?…", text: $pasted)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            Button("Continue") { accept(pasted); pasted = "" }
            Button("Cancel", role: .cancel) { pasted = "" }
        } message: {
            Text("Run `codebridge-relay link` on the computer that runs your relay to see it.")
        }
    }

    private func accept(_ text: String) {
        error = nil
        if let link = parseConnectLink(text) { app.pendingConnect = link }
        else { error = "That isn’t a CodeBridge connect link. Run `codebridge-relay link` to show it again." }
    }
}

/// An explicit Back button. The welcome screen forces a dark appearance, which can leave the system back chevron
/// invisible on the lighter screens pushed from it, so these screens draw their own.
struct BackButton: ViewModifier {
    @Environment(\.dismiss) private var dismiss
    func body(content: Content) -> some View {
        content
            .navigationBarBackButtonHidden(true)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { dismiss() } label: { Label("Back", systemImage: "chevron.backward") }
                        .accessibilityLabel("Back")
                }
            }
    }
}

extension View {
    func explicitBackButton() -> some View { modifier(BackButton()) }
}

/// One command per relay option. Each starts the relay, opens its address and joins that computer.
enum RelayCommands {
    static let cloudflare = "npx -y codebridge-relay start --tunnel cloudflare --with-agent"
    static let fly = "npx -y codebridge-relay fly --with-agent"
    static let installAgent = "npm install -g codebridge-agent"
}

/// Set up a relay in one step. A phone can't start a tunnel on a computer it isn't connected to yet, so this
/// gives one command per option to run on the computer (or send there), then the user scans the QR it shows.
struct SetupRelayView: View {
    @Environment(AppModel.self) private var app
    @State private var scanning = false
    @State private var error: String?

    var body: some View {
        Form {
            Section {
                Text("Your relay is a small program that links this phone to your computers. You run it yourself, so there is no account and nothing is hosted for you. One command does everything: it starts the relay, opens a secure public address, joins that computer, and shows a QR code to scan.")
                    .font(.footnote)
            }
            option("Free: public address through Cloudflare (needs Node.js 22+ and cloudflared)", RelayCommands.cloudflare)
            option("Permanent: your own Fly.io account, about $2 a month (needs flyctl)", RelayCommands.fly)
            Section {
                Text("Run it in a terminal on your Mac or PC, or use Send to my computer to AirDrop or message the command to yourself. The relay prints a QR code. Scan it here.")
                    .font(.footnote).foregroundStyle(.secondary)
                if QRScannerView.isAvailable {
                    Button { scanning = true } label: { Label("Scan the QR code", systemImage: "qrcode.viewfinder").frame(maxWidth: .infinity) }
                        .buttonStyle(.glassProminent)
                }
                InlineError(message: error)
            }
        }
        .navigationTitle("Set up a relay")
        .explicitBackButton()
        .fullScreenCover(isPresented: $scanning) {
            ZStack(alignment: .top) {
                QRScannerView { payload in
                    scanning = false
                    if let link = parseConnectLink(payload) { app.pendingConnect = link }
                    else { error = "That isn’t a CodeBridge connect link." }
                }
                .ignoresSafeArea()
                HStack {
                    Text("Point at your relay’s QR code").font(.subheadline.weight(.medium)).padding(.horizontal, 16).padding(.vertical, 10)
                        .glassEffect(.regular, in: .capsule)
                    Spacer()
                    Button { scanning = false } label: { Image(systemName: "xmark") }
                        .buttonStyle(.glass).buttonBorderShape(.circle).accessibilityLabel("Close scanner")
                }
                .padding()
            }
        }
    }

    private func option(_ title: String, _ command: String) -> some View {
        Section {
            CommandBlock(title: title, command: command)
            Button { UIPasteboard.general.string = command } label: { Label("Copy", systemImage: "doc.on.doc").frame(maxWidth: .infinity) }
                .buttonStyle(.glassProminent)
            ShareLink(item: command) { Label("Send to my computer", systemImage: "square.and.arrow.up").frame(maxWidth: .infinity) }
                .buttonStyle(.glass)
        }
    }
}

/// A titled, selectable command the user can copy.
struct CommandBlock: View {
    let title: String
    let command: String
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.footnote.weight(.medium))
            Text(command)
                .font(.system(.footnote, design: .monospaced))
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true) // never truncate a command the user has to run
                .padding(8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
        }
    }
}

struct AuthFormView: View {
    enum Mode { case signIn, register }
    let mode: Mode
    @Environment(AppModel.self) private var app
    @State private var server = ""
    @State private var email = ""
    @State private var password = ""
    @State private var runner = ActionRunner()

    private var minPassword: Int { mode == .register ? 12 : 1 }

    var body: some View {
        Form {
            Section("Shared relay") {
                TextField("https://relay.example.com", text: $server)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            }
            Section {
                TextField("Email", text: $email)
                    .textContentType(.username)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                SecureField(mode == .register ? "Password (12+ characters)" : "Password", text: $password)
                    .textContentType(mode == .register ? .newPassword : .password)
            } footer: {
                if mode == .register && !password.isEmpty && password.count < 12 {
                    Text("Use at least 12 characters.").foregroundStyle(Palette.danger)
                }
            }
            InlineError(message: runner.error)
        }
        .navigationTitle(mode == .register ? "Create account" : "Sign in")
        .explicitBackButton()
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button(mode == .register ? "Create" : "Sign in") {
                    runner.run {
                        if !server.isEmpty { try await app.useSharedRelay(server) }
                        if mode == .register { try await app.register(email: email.trimmingCharacters(in: .whitespaces), password: password) }
                        else { try await app.signIn(email: email.trimmingCharacters(in: .whitespaces), password: password) }
                    }
                }
                .disabled(email.isEmpty || password.count < minPassword || runner.busy)
            }
        }
    }
}
