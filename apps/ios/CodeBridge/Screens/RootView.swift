import CodeBridgeKit
import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var app
    @State private var connecting = ActionRunner()

    /// Test seam for simulator runs, where nothing can be tapped: CODEBRIDGE_DEBUG_SCREEN=setup.
    private var debugScreen: String? {
        #if DEBUG
        ProcessInfo.processInfo.environment["CODEBRIDGE_DEBUG_SCREEN"]
        #else
        nil
        #endif
    }

    /// CODEBRIDGE_DEBUG_SESSION=<session id> opens that session straight away (DEBUG builds only).
    private var debugSession: String? {
        #if DEBUG
        ProcessInfo.processInfo.environment["CODEBRIDGE_DEBUG_SESSION"]
        #else
        nil
        #endif
    }

    var body: some View {
        Group {
            if !app.ready {
                ProgressView("Starting CodeBridge…")
            } else if debugScreen == "setup" {
                NavigationStack { SetupRelayView() }
            } else if app.user == nil {
                NavigationStack { WelcomeView() }
            } else if let debugSession {
                NavigationStack { SessionView(sessionId: debugSession) }
            } else {
                MainTabs()
            }
        }
        .animation(.smooth, value: app.user?.id)
        .confirmationDialog(
            "Connect to \(app.pendingConnect?.host ?? "this relay")?",
            isPresented: Binding(get: { app.pendingConnect != nil }, set: { if !$0 { app.pendingConnect = nil } }),
            titleVisibility: .visible,
            presenting: app.pendingConnect
        ) { link in
            Button("Connect") {
                app.pendingConnect = nil
                connecting.run { try await app.connect(link) }
            }
            Button("Cancel", role: .cancel) { app.pendingConnect = nil }
        } message: { _ in
            Text("This relay will be able to run commands on every computer you connect to it. Only continue if you set it up yourself.")
        }
        .alert("Couldn’t connect", isPresented: Binding(get: { connecting.error != nil }, set: { if !$0 { connecting.error = nil } })) {
            Button("OK", role: .cancel) {}
        } message: { Text(connecting.error ?? "") }
        .overlay { if connecting.busy { ProgressView("Connecting…").padding().glassEffect() } }
    }
}

/// Signed-in shell: a Liquid Glass tab bar that minimises on scroll, with relay
/// status in the tab bar's bottom accessory.
struct MainTabs: View {
    @Environment(AppModel.self) private var app
    @State private var selection = Int(ProcessInfo.processInfo.environment["CODEBRIDGE_DEBUG_TAB"] ?? "") ?? 0
    @State private var homePath = NavigationPath()

    var body: some View {
        TabView(selection: $selection) {
            Tab("Home", systemImage: "laptopcomputer.and.iphone", value: 0) {
                NavigationStack(path: $homePath) { HomeView() }
            }
            Tab("Sessions", systemImage: "terminal", value: 1) {
                NavigationStack { SessionsView() }
            }
            Tab("Cloud", systemImage: "cloud", value: 2) {
                NavigationStack { CloudView() }
            }
            Tab("Settings", systemImage: "gearshape", value: 3) {
                NavigationStack { SettingsView() }
            }
        }
        .tabBarMinimizeBehavior(.onScrollDown)
        .tabViewBottomAccessory { ConnectionAccessory() }
        .sheet(item: Binding(get: { app.pendingPairCode.map(PairCode.init) }, set: { app.pendingPairCode = $0?.code })) { pending in
            NavigationStack { PairView(initialCode: pending.code) }
        }
    }
}

private struct PairCode: Identifiable {
    let code: String
    var id: String { code }
}

/// Navigation destinations shared by every stack.
enum Route: Hashable {
    case device(String)
    case devices
    case pair
    case newSession(deviceId: String, workspaceId: String)
    case session(String)
    case changes(deviceId: String, workspaceId: String)
    case credentials
    case newCloudSession
    case usage
}

extension View {
    func codeBridgeDestinations() -> some View {
        navigationDestination(for: Route.self) { route in
            switch route {
            case let .device(id): DeviceView(deviceId: id)
            case .devices: DevicesView()
            case .pair: PairView(initialCode: nil)
            case let .newSession(d, w): NewSessionView(deviceId: d, workspaceId: w)
            case let .session(id): SessionView(sessionId: id)
            case let .changes(d, w): ChangesView(deviceId: d, workspaceId: w)
            case .credentials: CredentialsView()
            case .newCloudSession: NewCloudSessionView()
            case .usage: UsageView()
            }
        }
    }
}
