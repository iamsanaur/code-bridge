import SwiftUI

struct WelcomeView: View {
    @Environment(AppModel.self) private var app

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

            VStack(alignment: .leading, spacing: 18) {
                Spacer()
                Image(systemName: "point.3.connected.trianglepath.dotted")
                    .font(.system(size: 44, weight: .semibold))
                    .foregroundStyle(.white)
                    .padding(18)
                    .glassEffect(.regular, in: .rect(cornerRadius: 24))
                    .accessibilityHidden(true)
                Text("CodeBridge")
                    .font(.largeTitle.bold())
                    .foregroundStyle(.white)
                    .accessibilityAddTraits(.isHeader)
                Text("Run and supervise coding sessions on your own Mac from anywhere. Commands execute on your Mac, inside folders you approve on the Mac. Optional cloud sessions run in an isolated Anthropic-hosted sandbox and are always labelled as such.")
                    .font(.body)
                    .foregroundStyle(.white.opacity(0.85))
                Spacer()
                GlassEffectContainer(spacing: 12) {
                    VStack(spacing: 12) {
                        NavigationLink { AuthFormView(mode: .signIn) } label: {
                            Text("Sign in").frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.glassProminent)
                        NavigationLink { AuthFormView(mode: .register) } label: {
                            Text("Create an account").frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.glass)
                    }
                    .controlSize(.extraLarge)
                }
                if app.isInsecure {
                    Label("The server (\(app.apiURL.absoluteString)) isn’t using HTTPS. Use this only for local development.", systemImage: "exclamationmark.shield")
                        .font(.footnote)
                        .foregroundStyle(Palette.warning)
                }
                Text("Server: \(app.apiURL.absoluteString)").font(.caption2).foregroundStyle(.white.opacity(0.6))
            }
            .padding(24)
        }
        .preferredColorScheme(.dark)
    }
}

struct AuthFormView: View {
    enum Mode { case signIn, register }
    let mode: Mode
    @Environment(AppModel.self) private var app
    @State private var email = ""
    @State private var password = ""
    @State private var runner = ActionRunner()

    private var minPassword: Int { mode == .register ? 12 : 1 }

    var body: some View {
        Form {
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
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button(mode == .register ? "Create" : "Sign in") {
                    runner.run {
                        if mode == .register { try await app.register(email: email.trimmingCharacters(in: .whitespaces), password: password) }
                        else { try await app.signIn(email: email.trimmingCharacters(in: .whitespaces), password: password) }
                    }
                }
                .disabled(email.isEmpty || password.count < minPassword || runner.busy)
            }
        }
    }
}
