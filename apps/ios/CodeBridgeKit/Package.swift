// swift-tools-version: 6.0
import PackageDescription

// Platform-independent core of the iOS app: protocol models, REST + WebSocket
// clients, session state and terminal rendering model. Tested with `swift test`
// on macOS; the app target (iOS 26, SwiftUI + Liquid Glass) depends on it.
let package = Package(
    name: "CodeBridgeKit",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [.library(name: "CodeBridgeKit", targets: ["CodeBridgeKit"])],
    targets: [
        .target(name: "CodeBridgeKit", swiftSettings: [.swiftLanguageMode(.v5)]),
        .testTarget(name: "CodeBridgeKitTests", dependencies: ["CodeBridgeKit"], swiftSettings: [.swiftLanguageMode(.v5)]),
    ]
)
