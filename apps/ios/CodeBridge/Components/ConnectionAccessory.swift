import CodeBridgeKit
import SwiftUI

/// Lives in the tab bar's bottom accessory (Liquid Glass) and shows relay health.
struct ConnectionAccessory: View {
    @Environment(AppModel.self) private var app
    @Environment(\.tabViewBottomAccessoryPlacement) private var placement

    var body: some View {
        let (text, color, symbol) = describe(app.realtime.status)
        HStack(spacing: 8) {
            Image(systemName: symbol)
                .foregroundStyle(color)
                .symbolEffect(.pulse, isActive: app.realtime.status != .connected)
            if placement != .inline {
                Text(text).font(.subheadline.weight(.medium)).lineLimit(1)
            }
        }
        .padding(.horizontal, 12)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(text)
    }

    private func describe(_ s: ConnectionStatus) -> (String, Color, String) {
        switch s {
        case .connected: ("Connected to your Macs", Palette.success, "dot.radiowaves.left.and.right")
        case .connecting: ("Connecting…", .secondary, "antenna.radiowaves.left.and.right")
        case .reconnecting: ("Reconnecting – output resumes where it left off", Palette.warning, "arrow.triangle.2.circlepath")
        case .offline: ("Connection lost. Reconnecting…", Palette.danger, "wifi.exclamationmark")
        case .unauthorized: ("Session expired – sign in again", Palette.danger, "person.crop.circle.badge.exclamationmark")
        case .idle: ("Not connected", .secondary, "pause.circle")
        }
    }
}
