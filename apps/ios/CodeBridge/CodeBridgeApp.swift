import SwiftUI

@main
struct CodeBridgeApp: App {
    @State private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .task { await model.restore() }
                .onOpenURL { model.handle(url: $0) }
                .onChange(of: scenePhase) { _, phase in
                    if phase == .active { model.realtime.nudge() }
                }
        }
    }
}
