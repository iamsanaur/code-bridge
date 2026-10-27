import CodeBridgeKit
import SwiftUI

/// Small status capsule. These are content (not controls), so they use a tinted
/// fill rather than Liquid Glass, per Apple's guidance to keep glass for the
/// navigation/control layer.
struct Pill: View {
    let label: String
    let color: Color
    var systemImage: String? = nil

    var body: some View {
        HStack(spacing: 5) {
            if let systemImage { Image(systemName: systemImage).imageScale(.small) } else { Circle().fill(color).frame(width: 7, height: 7) }
            Text(label).font(.caption.weight(.semibold))
        }
        .foregroundStyle(color)
        .padding(.horizontal, 9)
        .padding(.vertical, 4)
        .background(color.opacity(0.14), in: .capsule)
        .accessibilityElement(children: .combine)
    }
}

struct KindBadge: View {
    let kind: SessionKind
    var body: some View {
        switch kind {
        case .local: Pill(label: "Local Mac", color: Palette.local, systemImage: "laptopcomputer")
        case .cloud: Pill(label: "Managed cloud", color: Palette.cloud, systemImage: "cloud")
        }
    }
}

struct StatusBadge: View {
    let status: SessionStatus
    var body: some View {
        Pill(label: status.label, color: status.tint)
    }
}

struct OnlineBadge: View {
    let online: Bool
    var body: some View {
        Pill(label: online ? "Online" : "Offline", color: online ? Palette.success : .secondary)
    }
}

extension SessionStatus {
    var tint: Color {
        switch group {
        case .running: .blue
        case .waiting: Palette.warning
        case .completed: Palette.success
        case .failed: Palette.danger
        }
    }
}
