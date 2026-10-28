import SwiftUI

/// Semantic colours. Local Mac and managed cloud sessions always use distinct tints
/// so the execution environment is never ambiguous.
enum Palette {
    static let local = Color(red: 0.31, green: 0.82, blue: 0.65)
    static let cloud = Color(red: 0.71, green: 0.55, blue: 1.0)
    static let warning = Color(red: 0.96, green: 0.77, blue: 0.32)
    static let danger = Color(red: 1.0, green: 0.42, blue: 0.42)
    static let success = local
    /// Claude Code's own orange-coral, used only for its name and spinner.
    static let claude = Color(hex: 0xD97757)
    /// Your own messages in the chat.
    static let userBubble = Color(hex: 0x2563EB)
    static let terminalBackground = Color(red: 0.02, green: 0.03, blue: 0.045)
    static let terminalText = Color(red: 0.84, green: 0.86, blue: 0.90)

    static let ansi: [Color] = [
        0x1E2430, 0xFF6B6B, 0x4FD1A5, 0xF5C451, 0x5B9CFF, 0xC792EA, 0x56D4E0, 0xC8CDD8,
        0x5C6577, 0xFF8A8A, 0x7BE3BE, 0xFFD97A, 0x8AB8FF, 0xDDB3FF, 0x8BE9F2, 0xFFFFFF,
    ].map { Color(hex: $0) }
}

extension Color {
    init(hex: Int) {
        self.init(red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255)
    }
}

extension Font {
    static let terminal = Font.system(size: 12.5, design: .monospaced)
    static let code = Font.system(.footnote, design: .monospaced)
}
