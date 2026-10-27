import CodeBridgeKit
import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        Group {
            if !app.ready {
                ProgressView("Starting CodeBridge…")
            } else if app.user == nil {
                NavigationStack { WelcomeView() }
            } else {
                MainTabs()
            }
        }
        .animation(.smooth, value: app.user?.id)
    }
}

/// Signed-in shell: a Liquid Glass tab bar that minimises on scroll, with relay
/// status in the tab bar's bottom accessory.
struct MainTabs: View {
    @Environment(AppModel.self) private var app
    @State private var selection = 0
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
